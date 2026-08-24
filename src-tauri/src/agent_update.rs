// agent 升级/安装:移植自 agent-update-way(auway)的检测与升级逻辑。
// 前端负责定位二进制(候选目录检测,见 detectAgentCli),本模块负责:
// 安装方式分类(realpath 路径标记)→ 版本读取 → latest 比对(npm registry)
// → 按管理器构建升级命令 → spawn 并逐行把输出推给前端(agent-update-log 事件)。
// 所有外部命令不依赖用户预装 auway,零运行时依赖。

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// npm/npx 全局互斥:多个 npm 进程并发共用缓存锁会触发
/// ECOMPROMISED(Lock compromised),所有 npm 家族命令必须串行。
static NPM_LOCK: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// 注册表(与 auway KNOWN_AGENTS 对齐 + dsh/reasonix 扩展)
// ---------------------------------------------------------------------------

struct InstallMethodDef {
    id: &'static str,
    label: &'static str,
    /// unix shell 命令(sh -c 执行)。
    command: &'static str,
    /// Windows 变体(powershell -Command 执行);None 表示该方式在 Windows 不可用。
    windows: Option<&'static str>,
}

impl InstallMethodDef {
    const fn m(id: &'static str, label: &'static str, command: &'static str, windows: Option<&'static str>) -> Self {
        InstallMethodDef { id, label, command, windows }
    }
    /// 纯命令行管理器(npm/bun):Windows 可直接执行,无需变体。
    const fn manager(id: &'static str, label: &'static str, command: &'static str) -> Self {
        InstallMethodDef { id, label, command, windows: None }
    }
}

struct AgentDef {
    name: &'static str,
    label: &'static str,
    native_update: &'static [&'static str],
    version_args: &'static [&'static str],
    npm_package: Option<&'static str>,
    install_methods: &'static [InstallMethodDef],
}

const AGENTS: &[AgentDef] = &[
    AgentDef {
        name: "claude",
        label: "Claude Code",
        native_update: &["update"],
        version_args: &["--version"],
        npm_package: Some("@anthropic-ai/claude-code"),
        install_methods: &[
            InstallMethodDef::m("curl", "官方脚本 (curl)", "curl -fsSL https://claude.ai/install.sh | bash", Some("irm https://claude.ai/install.ps1 | iex")),
            InstallMethodDef::manager("npm", "npm 全局", "npm install -g @anthropic-ai/claude-code"),
            InstallMethodDef::m("brew", "Homebrew Cask", "brew install --cask claude-code", None),
        ],
    },
    AgentDef {
        name: "codex",
        label: "Codex",
        native_update: &["update"],
        version_args: &["--version"],
        npm_package: Some("@openai/codex"),
        install_methods: &[
            InstallMethodDef::manager("npm", "npm 全局", "npm install -g @openai/codex"),
            InstallMethodDef::m("brew", "Homebrew Cask", "brew install --cask codex", None),
            InstallMethodDef::m("curl", "官方脚本 (curl)", "curl -fsSL https://chatgpt.com/codex/install.sh | sh", Some("irm https://chatgpt.com/codex/install.ps1 | iex")),
        ],
    },
    AgentDef {
        name: "dsh",
        label: "DeepSeek Harness (dsh)",
        native_update: &[],
        version_args: &["--version"],
        npm_package: Some("@deepseek-ai/dsh"),
        install_methods: &[
            InstallMethodDef::manager("npm", "npm 全局", "npm install -g @deepseek-ai/dsh"),
        ],
    },
    AgentDef {
        name: "pi",
        label: "Pi agent",
        native_update: &["update", "pi"],
        version_args: &["--version"],
        npm_package: Some("@earendil-works/pi-coding-agent"),
        install_methods: &[
            InstallMethodDef::manager("npm", "npm 全局", "npm install -g @earendil-works/pi-coding-agent"),
            InstallMethodDef::m("curl", "官方脚本 (curl)", "curl -fsSL https://pi.dev/install.sh | sh", Some("irm https://pi.dev/install.ps1 | iex")),
        ],
    },
    AgentDef {
        name: "omp",
        label: "Oh My Pi",
        native_update: &["update"],
        version_args: &["--version"],
        npm_package: Some("@oh-my-pi/pi-coding-agent"),
        install_methods: &[
            InstallMethodDef::manager("bun", "bun 全局 (官方推荐)", "bun add -g @oh-my-pi/pi-coding-agent"),
            InstallMethodDef::m("curl", "官方脚本 (curl)", "curl -fsSL https://omp.sh/install | sh", Some("irm https://omp.sh/install.ps1 | iex")),
            InstallMethodDef::m("brew", "Homebrew Tap", "brew install can1357/tap/omp", None),
        ],
    },
    AgentDef {
        name: "reasonix",
        label: "Reasonix",
        native_update: &[],
        version_args: &["--version"],
        npm_package: Some("reasonix"),
        install_methods: &[
            InstallMethodDef::manager("npm", "npm 全局", "npm install -g reasonix"),
            InstallMethodDef::m("brew", "Homebrew Tap", "brew install esengine/reasonix/reasonix", None),
        ],
    },
];

fn find_def(name: &str) -> Option<&'static AgentDef> {
    AGENTS.iter().find(|a| a.name == name)
}

// ---------------------------------------------------------------------------
// 类型(前后端桥接)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    pub name: String,
    pub path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallMethodOut {
    pub id: String,
    pub label: String,
    pub command: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub name: String,
    pub label: String,
    pub installed: bool,
    pub path: Option<String>,
    pub manager: Option<String>,
    pub version: Option<String>,
    pub latest: Option<String>,
    pub update_available: bool,
    pub install_methods: Vec<InstallMethodOut>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub name: String,
    pub status: String, // updated | up-to-date | skipped | failed
    pub before: Option<String>,
    pub after: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 路径分类(auway MARKERS 移植)
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Clone)]
enum Manager {
    Npm,    // npm 全局(含 fnm/nvm 多版本)
    Pnpm,
    Bun,
    Brew,   // formula 或 cask
    User,   // ~/node_modules 用户级
    Native, // 官方安装器/独立二进制
    Local,  // 项目本地依赖,绝不碰
}

struct Detected {
    def: &'static AgentDef,
    real_path: String,
    manager: Manager,
    /// npm/pnpm/bun: 全局包名;brew: formula 名(从路径提取)。
    manager_target: Option<String>,
    /// npm: 拥有该包的 node 安装根(<root>/lib/node_modules/<pkg> 之前)。
    node_root: Option<String>,
    /// brew cask 安装(Caskroom 路径)。
    brew_cask: bool,
}

/// 解析 npm 可执行文件路径(GUI 应用 PATH 里通常没有 npm,需按安装形态定位):
/// 1. npm 管理安装 → 用其 node 根的 npm(fnm/nvm 多版本安全)
/// 2. PATH 查找
/// 3. fnm/nvm 任意版本的 npm
/// 4. Homebrew 目录
fn resolve_npm(det: &Detected) -> Option<String> {
    if let Some(root) = &det.node_root {
        let cand = format!("{}/bin/npm", root);
        if Path::new(&cand).exists() {
            return Some(cand);
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            if dir.is_empty() {
                continue;
            }
            let cand = format!("{}/npm", dir);
            if Path::new(&cand).exists() {
                return Some(cand);
            }
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    for base in [format!("{}/.local/share/fnm/node-versions", home), format!("{}/.nvm/versions/node", home)] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() {
                let cand = e.path().join("installation/bin/npm");
                if cand.exists() {
                    return Some(cand.to_string_lossy().to_string());
                }
            }
        }
    }
    for d in ["/opt/homebrew/bin/npm", "/usr/local/bin/npm"] {
        if Path::new(d).exists() {
            return Some(d.to_string());
        }
    }
    None
}

fn realpath(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string())
}

/// 按 realpath 路径标记分类安装管理器(auway MARKERS 移植)。
/// 返回 (manager, manager_target, node_root, brew_cask)。
fn classify(real: &str) -> (Manager, Option<String>, Option<String>, bool) {
    let has = |m: &str| real.contains(m);
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();

    // 提取 npm 包名:<...>/node_modules/<pkg>(scoped: @scope/pkg 两级)
    let pkg_from_node_modules = || -> Option<String> {
        let idx = real.find("/node_modules/")?;
        let rest = &real[idx + "/node_modules/".len()..];
        let mut parts = rest.split('/');
        let first = parts.next().unwrap_or("");
        if first.is_empty() {
            return None;
        }
        if first.starts_with('@') {
            let second = parts.next().unwrap_or("");
            if second.is_empty() {
                return None;
            }
            Some(format!("{}/{}", first, second))
        } else {
            Some(first.to_string())
        }
    };
    let node_root = || -> Option<String> {
        let idx = real.find("/lib/node_modules/")?;
        Some(real[..idx].to_string())
    };
    // brew 路径提取 formula/cask 名:Caskroom/<name>/<version>/... 或 Cellar/<name>/<version>/...
    let brew_name = |marker: &str| -> Option<String> {
        let idx = real.find(marker)?;
        let rest = &real[idx + marker.len()..];
        let name = rest.split('/').next().unwrap_or("");
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    };

    if has("/lib/node_modules/") {
        (Manager::Npm, pkg_from_node_modules(), node_root(), false)
    } else if has("/global/5/") {
        (Manager::Pnpm, pkg_from_node_modules(), None, false)
    } else if has("/.bun/install/global/") || has("/.bun/bin/") {
        (Manager::Bun, pkg_from_node_modules(), None, false)
    } else if has("/opt/homebrew/Caskroom/") || has("/usr/local/Caskroom/") || has("/home/linuxbrew/.linuxbrew/Caskroom/") {
        (Manager::Brew, brew_name("/Caskroom/"), None, true)
    } else if has("/opt/homebrew/Cellar/") || has("/usr/local/Cellar/") || has("/home/linuxbrew/.linuxbrew/Cellar/") {
        (Manager::Brew, brew_name("/Cellar/"), None, false)
    } else if real.starts_with(&home) && real[home.len()..].starts_with("/node_modules/") {
        // 用户级 ~/node_modules(先于项目本地判定,避免被 /node_modules/ 命中)
        (Manager::User, pkg_from_node_modules(), None, false)
    } else if has("/node_modules/") {
        // 项目本地(含 npx 缓存):跳过,绝不碰
        (Manager::Local, pkg_from_node_modules(), None, false)
    } else {
        (Manager::Native, None, None, false)
    }
}

// ---------------------------------------------------------------------------
// 子进程辅助
// ---------------------------------------------------------------------------

/// 安装/升级子进程统一注入非交互环境:绝大多数工具识别后跳过交互提示。
/// 再配合 stdin 关闭(读到 EOF 立即结束),保证不会因等待输入而挂起。
fn noninteractive_env() -> Vec<(String, String)> {
    [
        ("CI", "1"),
        ("NONINTERACTIVE", "1"),
        ("HOMEBREW_NO_AUTO_UPDATE", "1"),
        ("HOMEBREW_NO_ENV_HINTS", "1"),
        ("HOMEBREW_NO_INSTALL_UPGRADE", "1"),
        ("npm_config_yes", "true"),
        ("npm_config_fund", "false"),
        ("npm_config_audit", "false"),
        ("CODEX_NON_INTERACTIVE", "1"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn apply_noninteractive(cmd: &mut Command) {
    for (k, v) in noninteractive_env() {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()); // 交互提示读到 EOF 立即结束,绝不挂起
}

/// 清洗一行输出:先按 `\r`/`\n` 切分(进度条刷新帧),再逐段去 ANSI 转义序列。
fn clean_output_line(raw: &str) -> Vec<String> {
    raw.split(|c| c == '\r' || c == '\n')
        .map(|seg| {
            let stripped = strip_ansi_escapes::strip(seg.as_bytes());
            String::from_utf8_lossy(&stripped).trim_end().to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// macOS/Linux 从 GUI(LaunchServices)启动的进程 PATH 常为空或极简,
/// 导致 `#!/usr/bin/env node` 型脚本(pi/npm/pnpm/bun 等)找不到 node。
/// 将被调用二进制的父目录(通常与 node/npm 同级)前置到 PATH,使子进程
/// 能解析 node/npm(与 resolve_npm 的 npm 定位逻辑互补)。
/// 仅对绝对路径生效;裸命令名(如 "npm")交由 PATH 自身解析。
fn ensure_tool_path(cmd: &mut Command, bin: &str) {
    if bin.is_empty() {
        return;
    }
    let p = Path::new(bin);
    if !p.is_absolute() {
        return;
    }
    let Some(dir) = p.parent() else {
        return;
    };
    let extra = dir.to_string_lossy().to_string();
    let existing = std::env::var("PATH").unwrap_or_default();
    if existing.split(':').any(|d| d == extra) {
        return;
    }
    let new_path = if existing.is_empty() {
        extra
    } else {
        format!("{}:{}", extra, existing)
    };
    cmd.env("PATH", new_path);
}

/// 把命令行转成 Command:Windows 下 .cmd 工具(npm/pnpm/bun 等)经 cmd /C 执行。
fn build_command(cmd: &[String]) -> Command {
    let bin = cmd.first().map(String::as_str).unwrap_or("");
    let mut c;
    #[cfg(windows)]
    {
        if !bin.is_empty() {
            let is_cmd_tool = ["npm", "npx", "pnpm", "bun", "brew"].iter().any(|t| *t == bin)
                || bin.ends_with(".cmd")
                || bin.ends_with(".bat");
            if is_cmd_tool {
                c = Command::new("cmd");
                c.arg("/C");
                c.arg(quote_cmd_line(cmd));
                ensure_tool_path(&mut c, bin);
                return c;
            }
        }
        c = Command::new(cmd.first().cloned().unwrap_or_default());
    }
    #[cfg(not(windows))]
    {
        c = Command::new(cmd.first().cloned().unwrap_or_default());
    }
    c.args(&cmd[1..]);
    ensure_tool_path(&mut c, bin);
    c
}

#[cfg(windows)]
fn quote_cmd_line(args: &[String]) -> String {
    args.iter()
        .map(|a| if a.contains(' ') && !a.starts_with('"') { format!("\"{}\"", a) } else { a.clone() })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 执行安装脚本(unix: sh -c;windows: powershell -NoProfile -ExecutionPolicy Bypass -Command)。
fn build_shell_command(script: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("powershell");
        c.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg(script);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.arg("-c").arg(script);
        c
    }
}

/// 纯命令行管理器命令(npm/bun/pnpm/brew),Windows 下应走 cmd /C 解析
/// npm.cmd 而非 PowerShell 解析 npm.ps1(避免 ExecutionPolicy 拦截)。
fn is_manager_cmd(script: &str) -> bool {
    ["npm ", "bun ", "pnpm ", "brew "].iter().any(|p| script.starts_with(p))
}

/// 该安装方式在当前平台是否可用。
/// Windows 下:有 PowerShell 变体、或纯 npm/bun 命令行(brew、curl|sh 不可用)。
fn method_available_on(m: &InstallMethodDef, is_windows: bool) -> bool {
    if !is_windows {
        return true;
    }
    m.windows.is_some() || m.command.starts_with("npm ") || m.command.starts_with("bun ")
}

/// 该安装方式在当前平台要执行的命令(Windows 用 PowerShell 变体)。
fn method_script(m: &InstallMethodDef) -> &str {
    #[cfg(windows)]
    {
        m.windows.unwrap_or(m.command)
    }
    #[cfg(not(windows))]
    {
        m.command
    }
}

/// 运行命令并捕获输出(超时返回 timeout 标记;非交互)。
fn run_capture(cmd: &[String], timeout: Duration) -> Result<String, String> {
    let mut c = build_command(cmd);
    apply_noninteractive(&mut c);
    let mut child = c
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", cmd.join(" "), e))?;
    let out = child.stdout.take().expect("stdout piped");
    let err = child.stderr.take().expect("stderr piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        use std::io::Read;
        let _ = BufReader::new(out).read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let mut err_s = String::new();
    {
        use std::io::Read;
        let _ = BufReader::new(err).read_to_string(&mut err_s);
    }
    match rx.recv_timeout(timeout) {
        Ok(stdout) => {
            let _ = child.wait();
            Ok(stdout.trim().to_string())
        }
        Err(_) => {
            let _ = child.kill();
            Err(format!("{} 执行超时", cmd.join(" ")))
        }
    }
}

/// 运行命令,stdout/stderr 逐行推给前端事件(非交互、清洗 ANSI/\\r);返回退出码。
fn run_streaming(app: &AppHandle, cmd: &[String], timeout: Duration) -> Result<i32, String> {
    let mut c = build_command(cmd);
    apply_noninteractive(&mut c);
    let mut child = c
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", cmd.join(" "), e))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let a1 = app.clone();
    let t1 = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if let Ok(l) = line {
                for part in clean_output_line(&l) {
                    a1.emit("agent-update-log", part).ok();
                }
            }
        }
    });
    let a2 = app.clone();
    let t2 = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            if let Ok(l) = line {
                for part in clean_output_line(&l) {
                    a2.emit("agent-update-log", part).ok();
                }
            }
        }
    });
    // 超时轮询
    let start = std::time::Instant::now();
    loop {
        if let Some(code) = child.try_wait().map_err(|e| format!("等待 {} 失败: {}", cmd.join(" "), e))? {
            let _ = t1.join();
            let _ = t2.join();
            return Ok(code.code().unwrap_or(0));
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Err(format!("{} 执行超时({}s)", cmd.join(" "), timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

fn parse_version(out: &str) -> Option<String> {
    let mut chars = out.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c.is_ascii_digit() {
            let start = i;
            let mut end = i + 1;
            let mut dots = 0;
            while let Some(&(j, c2)) = chars.peek() {
                if c2.is_ascii_digit() {
                    end = j + 1;
                    chars.next();
                } else if c2 == '.' && dots < 3 {
                    end = j + 1;
                    dots += 1;
                    chars.next();
                } else {
                    break;
                }
            }
            // 预发布后缀:0.1.0-rc.6 保留 rc 部分
            if let Some(&(j, c2)) = chars.peek() {
                if c2 == '-' && j == end {
                    chars.next();
                    let mut e = j + 1;
                    while let Some(&(k, c3)) = chars.peek() {
                        if c3.is_ascii_alphanumeric() || c3 == '.' || c3 == '-' {
                            e = k + 1;
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    end = e;
                }
            }
            return Some(out[start..end].to_string());
        }
    }
    None
}

fn compare_versions(a: &str, b: &str) -> i32 {
    // 先比数字段;相等时比后缀(支持 0.1.0-rc.5 < 0.1.0-rc.6)
    let (na, sa) = a.split_once('-').map(|(n, s)| (n, s)).unwrap_or((a, ""));
    let (nb, sb) = b.split_once('-').map(|(n, s)| (n, s)).unwrap_or((b, ""));
    let pa: Vec<u32> = na.split('.').map(|n| n.parse().unwrap_or(0)).collect();
    let pb: Vec<u32> = nb.split('.').map(|n| n.parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va > vb {
            return 1;
        }
        if va < vb {
            return -1;
        }
    }
    if sa == sb {
        return 0;
    }
    // 有后缀视为比无后缀旧(1.0.0-rc.1 < 1.0.0)
    if sa.is_empty() {
        return 1;
    }
    if sb.is_empty() {
        return -1;
    }
    sa.cmp(sb) as i32
}

// ---------------------------------------------------------------------------
// 检查(check):安装状态 + 当前版本 + latest + 可升级
// ---------------------------------------------------------------------------

fn methods_out(def: &'static AgentDef) -> Vec<InstallMethodOut> {
    def.install_methods
        .iter()
        .filter(|m| method_available_on(m, cfg!(windows)))
        .map(|m| InstallMethodOut { id: m.id.to_string(), label: m.label.to_string(), command: method_script(m).to_string() })
        .collect()
}

fn check_one(entry: AgentEntry) -> AgentStatus {
    let Some(def) = find_def(&entry.name) else {
        return AgentStatus {
            label: entry.name.clone(),
            name: entry.name,
            installed: false,
            path: None,
            manager: None,
            version: None,
            latest: None,
            update_available: false,
            install_methods: vec![],
        };
    };
    let Some(path) = entry.path.as_deref().filter(|p| !p.is_empty()) else {
        return AgentStatus {
            name: def.name.to_string(),
            label: def.label.to_string(),
            installed: false,
            path: None,
            manager: None,
            version: None,
            latest: None,
            update_available: false,
            install_methods: methods_out(def),
        };
    };
    if !Path::new(path).exists() {
        return AgentStatus {
            name: def.name.to_string(),
            label: def.label.to_string(),
            installed: false,
            path: Some(path.to_string()),
            manager: None,
            version: None,
            latest: None,
            update_available: false,
            install_methods: methods_out(def),
        };
    }

    let real = realpath(path);
    let (manager, manager_target, node_root, brew_cask) = classify(&real);
    let det = Detected { def, real_path: real, manager, manager_target, node_root, brew_cask };

    // 版本:用解析出的真实路径执行 --version(避免 GUI PATH 受限)
    let mut version_cmd: Vec<String> = vec![det.real_path.clone()];
    version_cmd.extend(det.def.version_args.iter().map(|s| s.to_string()));
    let version = run_capture(&version_cmd, Duration::from_secs(10))
        .ok()
        .and_then(|out| parse_version(&out));

    // latest:统一 npm registry(npmPackage 即官方发布源,原生/brew 安装同源);
    // npm 需按安装形态解析(GUI PATH 里通常没有 npm);npm 家族命令串行防锁竞争
    let npm = resolve_npm(&det);
    let latest = npm
        .as_deref()
        .and_then(|_| det.def.npm_package)
        .and_then(|pkg| {
            let _guard = NPM_LOCK.lock().ok(); // 串行:防 ECOMPROMISED
            run_capture(
                &[npm.clone().unwrap_or_else(|| "npm".into()), "view".to_string(), pkg.to_string(), "version".to_string()],
                Duration::from_secs(15),
            )
            .ok()
        })
        .filter(|v| !v.is_empty());

    let update_available = match (&version, &latest) {
        (Some(v), Some(l)) => compare_versions(l, v) > 0,
        _ => false,
    };

    AgentStatus {
        name: det.def.name.to_string(),
        label: det.def.label.to_string(),
        installed: true,
        path: Some(det.real_path.clone()),
        manager: Some(match det.manager {
            Manager::Npm => "npm".to_string(),
            Manager::Pnpm => "pnpm".to_string(),
            Manager::Bun => "bun".to_string(),
            Manager::Brew => if det.brew_cask { "brew-cask".to_string() } else { "brew".to_string() },
            Manager::User => "user".to_string(),
            Manager::Native => "native".to_string(),
            Manager::Local => "local".to_string(),
        }),
        version,
        latest,
        update_available,
        install_methods: methods_out(det.def),
    }
}

// ---------------------------------------------------------------------------
// 升级命令构建(auway buildUpdateCommand 移植)
// ---------------------------------------------------------------------------

fn build_update_cmd(det: &Detected) -> Option<Vec<String>> {
    match det.manager {
        Manager::Npm => {
            let pkg = det.manager_target.clone().or_else(|| det.def.npm_package.map(|s| s.to_string()))?;
            let npm = resolve_npm(det).unwrap_or_else(|| "npm".to_string());
            if let Some(root) = &det.node_root {
                Some(vec![npm, "update".into(), "-g".into(), "--prefix".into(), root.clone(), pkg])
            } else {
                Some(vec![npm, "update".into(), "-g".into(), pkg])
            }
        }
        Manager::Pnpm => {
            let pkg = det.manager_target.clone().or_else(|| det.def.npm_package.map(|s| s.to_string()))?;
            Some(vec!["pnpm".into(), "add".into(), "-g".into(), pkg])
        }
        Manager::Bun => {
            let pkg = det.manager_target.clone().or_else(|| det.def.npm_package.map(|s| s.to_string()))?;
            Some(vec!["bun".into(), "add".into(), "-g".into(), pkg])
        }
        Manager::Brew => {
            let formula = det.manager_target.clone()?;
            if det.brew_cask {
                Some(vec!["brew".into(), "upgrade".into(), "--cask".into(), formula])
            } else {
                Some(vec!["brew".into(), "upgrade".into(), formula])
            }
        }
        Manager::Native => {
            if det.def.native_update.is_empty() {
                return None;
            }
            let mut cmd = vec![det.real_path.clone()];
            cmd.extend(det.def.native_update.iter().map(|s| s.to_string()));
            Some(cmd)
        }
        Manager::Local => {
            // npx 缓存安装(_npx/<hash>/node_modules/.bin/<bin>):用 npx 拉最新版刷新缓存。
            // 其余项目本地依赖绝不碰。
            if det.real_path.contains("/_npx/") {
                let pkg = det.def.npm_package?;
                let npx = resolve_npm(det)
                    .map(|npm| {
                        let dir = std::path::Path::new(&npm).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                        format!("{}/npx", dir)
                    })
                    .unwrap_or_else(|| "npx".to_string());
                Some(vec![npx, "--yes".into(), format!("{}@latest", pkg), "--version".into()])
            } else {
                None
            }
        }
        Manager::User => None,
    }
}

// ---------------------------------------------------------------------------
// 命令(tauri::command)
// ---------------------------------------------------------------------------

/// 并发检查各 agent 的版本与可升级状态(不阻塞主线程)。
#[tauri::command]
pub async fn agent_check(entries: Vec<AgentEntry>) -> Result<Vec<AgentStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut handles = Vec::new();
        for e in entries {
            handles.push(std::thread::spawn(move || check_one(e)));
        }
        let mut out = Vec::new();
        for h in handles {
            match h.join() {
                Ok(s) => out.push(s),
                Err(_) => {} // 线程 panic 跳过该 agent
            }
        }
        Ok::<Vec<AgentStatus>, String>(out)
    })
    .await
    .map_err(|e| format!("检查任务失败: {}", e))?
}

fn emit_log(app: &AppHandle, line: impl Into<String>) {
    let _ = app.emit("agent-update-log", line.into());
}

fn update_one(app: &AppHandle, entry: AgentEntry) -> UpdateResult {
    let Some(def) = find_def(&entry.name) else {
        return UpdateResult { name: entry.name, status: "failed".into(), before: None, after: None, error: Some("未知 agent".into()) };
    };
    let Some(path) = entry.path.as_deref().filter(|p| !p.is_empty()) else {
        emit_log(app, format!("⊘ {}: 未安装,跳过升级", def.label));
        return UpdateResult { name: def.name.into(), status: "skipped".into(), before: None, after: None, error: None };
    };
    if !Path::new(path).exists() {
        emit_log(app, format!("⊘ {}: 二进制不存在,跳过升级", def.label));
        return UpdateResult { name: def.name.into(), status: "skipped".into(), before: None, after: None, error: None };
    }
    let real = realpath(path);
    let (manager, manager_target, node_root, brew_cask) = classify(&real);
    let det = Detected { def, real_path: real, manager, manager_target, node_root, brew_cask };
    let before = run_capture(
        &{
            let mut v = vec![det.real_path.clone()];
            v.extend(det.def.version_args.iter().map(|s| s.to_string()));
            v
        },
        Duration::from_secs(10),
    )
    .ok()
    .and_then(|o| parse_version(&o));

    emit_log(app, format!("── 升级 {} {} ──", det.def.label, det.def.name));

    // 与启动检查的 npm view 串行,防止 npm 缓存锁竞争(ECOMPROMISED)
    let _npm_guard = NPM_LOCK.lock().ok();

    // 用户级安装走精确更新(npm view → pack → 原子替换)
    if det.manager == Manager::User {
        return update_user_level(app, &det, before);
    }

    let Some(cmd) = build_update_cmd(&det) else {
        emit_log(app, "⊘ 无可用升级命令(项目本地安装不自动升级;其它方式请检查注册表)".to_string());
        return UpdateResult { name: det.def.name.into(), status: "skipped".into(), after: before.clone(), before, error: None };
    };

    match run_streaming(app, &cmd, Duration::from_secs(300)) {
        Ok(code) => {
            // 升级后重读版本:npx 缓存安装读 latest 缓存版本,其余读真实路径
            let after = if det.manager == Manager::Local {
                det.def
                    .npm_package
                    .and_then(|pkg| {
                        run_capture(
                            &["npx".into(), "--yes".into(), format!("{}@latest", pkg), "--version".into()],
                            Duration::from_secs(60),
                        )
                        .ok()
                    })
                    .and_then(|o| parse_version(&o))
            } else {
                run_capture(
                    &{
                        let mut v = vec![det.real_path.clone()];
                        v.extend(det.def.version_args.iter().map(|s| s.to_string()));
                        v
                    },
                    Duration::from_secs(10),
                )
                .ok()
                .and_then(|o| parse_version(&o))
            };
            if code == 0 {
                let status = match (&before, &after) {
                    (Some(b), Some(a)) if a != b => "updated",
                    _ => "up-to-date",
                };
                emit_log(app, match status {
                    "updated" => format!("✔ {}: {} → {}", det.def.label, before.as_deref().unwrap_or("?"), after.as_deref().unwrap_or("?")),
                    _ => format!("✔ {}: 已是最新 ({})", det.def.label, after.as_deref().unwrap_or("?")),
                });
                // Pi 本体升级成功后,顺带更新其扩展(packages:pi update --extensions)
                if det.def.name == "pi" {
                    update_pi_extensions(app, &det.real_path);
                }
                UpdateResult { name: det.def.name.into(), status: status.into(), before, after, error: None }
            } else {
                emit_log(app, format!("✘ {}: 升级失败(退出码 {})", det.def.label, code));
                UpdateResult { name: det.def.name.into(), status: "failed".into(), before, after, error: Some(format!("退出码 {}", code)) }
            }
        }
        Err(e) => {
            emit_log(app, format!("✘ {}: {}", det.def.label, e));
            UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: Some(e) }
        }
    }
}

/// 用户级安装(~/.node_modules/<pkg>)的精确更新:npm view → npm pack → 原子替换 → 嵌套装依赖。
fn update_user_level(app: &AppHandle, det: &Detected, before: Option<String>) -> UpdateResult {
    let pkg = det.manager_target.clone().or_else(|| det.def.npm_package.map(|s| s.to_string()));
    let Some(pkg) = pkg else {
        emit_log(app, "⊘ 用户级安装缺少包名,跳过".to_string());
        return UpdateResult { name: det.def.name.into(), status: "skipped".into(), after: before.clone(), before, error: None };
    };
    let nm_idx = match det.real_path.find("/node_modules/") {
        Some(i) => i,
        None => {
            emit_log(app, "⊘ 无法定位 node_modules 根,跳过".to_string());
            return UpdateResult { name: det.def.name.into(), status: "skipped".into(), after: before.clone(), before, error: None };
        }
    };
    let nm_root = det.real_path[..nm_idx].to_string();
    let target_dir = format!("{}/node_modules/{}", nm_root, pkg);

    let npm = resolve_npm(det).unwrap_or_else(|| "npm".to_string());
    let latest = match run_capture(&[npm.clone(), "view".into(), pkg.clone(), "version".into()], Duration::from_secs(15)) {
        Ok(v) if !v.is_empty() => v,
        Ok(_) => {
            emit_log(app, "⊘ npm view 无版本信息,跳过".to_string());
            return UpdateResult { name: det.def.name.into(), status: "skipped".into(), after: before.clone(), before, error: None };
        }
        Err(e) => {
            emit_log(app, format!("✘ npm view 失败: {}", e));
            return UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: Some(e) };
        }
    };
    if let Some(b) = &before {
        if compare_versions(&latest, b) <= 0 {
            emit_log(app, format!("✔ {}: 已是最新 ({})", det.def.label, b));
            return UpdateResult { name: det.def.name.into(), status: "up-to-date".into(), after: before.clone(), before, error: None };
        }
    }

    emit_log(app, format!("下载 {}@{} (npm pack)...", pkg, latest));
    let tmp = std::env::temp_dir().join(format!("axup-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp);
    let pack = run_capture(
        &[npm.clone(), "pack".into(), format!("{}@{}", pkg, latest), "--pack-destination".into(), tmp.to_string_lossy().to_string()],
        Duration::from_secs(120),
    );
    let Ok(tarball_name) = pack else {
        let e = pack.unwrap_err();
        emit_log(app, format!("✘ npm pack 失败: {}", e));
        return UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: Some(e) };
    };
    let tarball = tmp.join(tarball_name);
    let extract_dir = tmp.join("pkg");
    let _ = std::fs::create_dir_all(&extract_dir);
    let tar_ok = run_capture(
        &["tar".into(), "-xzf".into(), tarball.to_string_lossy().to_string(), "-C".into(), extract_dir.to_string_lossy().to_string()],
        Duration::from_secs(60),
    );
    if tar_ok.is_err() {
        let e = tar_ok.unwrap_err();
        emit_log(app, format!("✘ 解包失败: {}", e));
        return UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: Some(e) };
    }
    // 提取出的目录名 = package/ (npm pack 固定)
    let pkg_dir = extract_dir.join("package");
    if !pkg_dir.exists() {
        emit_log(app, "✘ 解包结果缺少 package 目录".to_string());
        return UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: None };
    }
    // 原子替换:旧目录 → .bak-<pid>,新目录 → 目标
    let bak = format!("{}.bak-update", target_dir);
    let _ = std::fs::remove_dir_all(&bak);
    if Path::new(&target_dir).exists() {
        if std::fs::rename(&target_dir, &bak).is_err() {
            emit_log(app, "✘ 无法备份旧目录,跳过".to_string());
            return UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: None };
        }
    }
    if std::fs::rename(&pkg_dir, &target_dir).is_err() {
        let _ = std::fs::rename(&bak, &target_dir); // 回滚
        emit_log(app, "✘ 替换失败,已回滚".to_string());
        return UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: None };
    }
    emit_log(app, "安装依赖(嵌套于包目录内,不触碰其它包)...".to_string());
    let install = run_streaming(
        app,
        &[npm.clone(), "install".into(), "--prefix".into(), target_dir.clone(), "--omit=dev".into(), "--no-save".into()],
        Duration::from_secs(300),
    );
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(&bak);
    match install {
        Ok(0) => {
            emit_log(app, format!("✔ {}: {} → {}", det.def.label, before.as_deref().unwrap_or("?"), latest));
            UpdateResult { name: det.def.name.into(), status: "updated".into(), before, after: Some(latest), error: None }
        }
        Ok(code) => {
            emit_log(app, format!("✘ {}: 依赖安装失败(退出码 {})", det.def.label, code));
            UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: Some(format!("退出码 {}", code)) }
        }
        Err(e) => {
            emit_log(app, format!("✘ {}: {}", det.def.label, e));
            UpdateResult { name: det.def.name.into(), status: "failed".into(), after: before.clone(), before, error: Some(e) }
        }
    }
}

/// 更新 Pi 扩展/包(packages):pi update --extensions,不碰 pi 本体。
/// 通过 pi 官方命令,由 pi 自己处理 npm 锁文件与 git 引用对齐。
fn update_pi_extensions(app: &AppHandle, pi_bin: &str) {
    emit_log(app, "── 更新 Pi 扩展 (pi update --extensions) ──");
    let cmd = vec![pi_bin.to_string(), "update".to_string(), "--extensions".to_string()];
    let _guard = NPM_LOCK.lock().ok(); // pi update 内部跑 npm,串行防锁竞争
    match run_streaming(app, &cmd, Duration::from_secs(600)) {
        Ok(0) => emit_log(app, "✔ Pi 扩展更新完成"),
        Ok(code) => emit_log(app, format!("✘ Pi 扩展更新失败(退出码 {})", code)),
        Err(e) => emit_log(app, format!("✘ Pi 扩展更新失败: {}", e)),
    }
}

/// 仅更新 Pi 扩展(pi 未安装时报错;pi 本体无更新时也可单独更新扩展)。
#[tauri::command]
pub async fn pi_extensions_update(app: AppHandle, pi_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if pi_path.is_empty() || !Path::new(&pi_path).exists() {
            emit_log(&app, "⊘ 未检测到 pi,无法更新扩展".to_string());
            return Err("未检测到 pi,无法更新扩展".to_string());
        }
        // 保留原始(未 realpath)路径:pi 是 `#!/usr/bin/env node` 脚本,
        // realpath 会把它解析到 dist/cli.js(其父目录无 node/npm),
        // 导致 GUI 进程缺失 PATH 时子进程 `env: node` 找不到。
        // 传原始 bin 路径,ensure_tool_path 会把其父目录(bin,含 node/npm)前置到 PATH。
        update_pi_extensions(&app, &pi_path);
        emit_log(&app, "── Pi 扩展更新结束 ──");
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("更新任务失败: {}", e))?
}

/// 逐个升级(顺序执行,日志清晰);返回各 agent 结果摘要。
#[tauri::command]
pub async fn agent_update(app: AppHandle, entries: Vec<AgentEntry>) -> Result<Vec<UpdateResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        for e in entries {
            results.push(update_one(&app, e));
        }
        emit_log(&app, "── 升级完成 ──");
        Ok::<Vec<UpdateResult>, String>(results)
    })
    .await
    .map_err(|e| format!("升级任务失败: {}", e))?
}

/// 按官方安装方式安装 agent(流式输出)。
#[tauri::command]
pub async fn agent_install(app: AppHandle, name: String, method_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(def) = find_def(&name) else {
            return Err(format!("未知 agent: {}", name));
        };
        let Some(method) = def.install_methods.iter().find(|m| m.id == method_id) else {
            return Err(format!("未知安装方式: {}", method_id));
        };
        if !method_available_on(method, cfg!(windows)) {
            return Err(format!("安装方式 {} 在当前平台不可用", method.label));
        }
        let script = method_script(method);
        emit_log(&app, format!("── 安装 {} ({}) ──", def.label, method.label));
        emit_log(&app, format!("$ {}", script));
        let _npm_guard = NPM_LOCK.lock().ok(); // 安装命令多为 npm 家族,串行防锁竞争
        match run_shell_streaming(&app, script, Duration::from_secs(600)) {
            Ok(0) => {
                emit_log(&app, format!("✔ {} 安装完成", def.label));
                Ok(())
            }
            Ok(code) => Err(format!("安装失败(退出码 {})", code)),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("安装任务失败: {}", e))?
}

/// 执行 shell 字符串命令(用于安装脚本;非交互、清洗 ANSI/\\r)。
/// Windows 下按命令类型分流:管理器命令走 cmd,脚本走 powershell。
fn run_shell_streaming(app: &AppHandle, script: &str, timeout: Duration) -> Result<i32, String> {
    #[cfg(windows)]
    let mut c = if is_manager_cmd(script) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(script);
        c
    } else {
        build_shell_command(script)
    };
    #[cfg(not(windows))]
    let mut c = build_shell_command(script);
    apply_noninteractive(&mut c);
    let mut child = c
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动安装命令失败: {}", e))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let a1 = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if let Ok(l) = line {
                for part in clean_output_line(&l) {
                    a1.emit("agent-update-log", part).ok();
                }
            }
        }
    });
    let a2 = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            if let Ok(l) = line {
                for part in clean_output_line(&l) {
                    a2.emit("agent-update-log", part).ok();
                }
            }
        }
    });
    let start = std::time::Instant::now();
    loop {
        if let Some(code) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(code.code().unwrap_or(0));
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Err(format!("安装超时({}s)", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn det_for(def: &'static AgentDef, real: &str) -> Detected {
        let (manager, manager_target, node_root, brew_cask) = classify(real);
        Detected { def, real_path: real.to_string(), manager, manager_target, node_root, brew_cask }
    }

    #[test]
    fn classify_managers_by_path_markers() {
        let (m, target, root, cask) = classify("/Users/x/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
        assert_eq!(m, Manager::Npm);
        assert_eq!(root.as_deref(), Some("/Users/x/.local/share/fnm/node-versions/v24.13.0/installation"));
        assert_eq!(target.as_deref(), Some("@earendil-works/pi-coding-agent"));
        assert!(!cask);

        let (m, target, _, _) = classify("/Users/x/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
        assert_eq!(m, Manager::Bun);
        assert_eq!(target.as_deref(), Some("@oh-my-pi/pi-coding-agent"));

        let (m, target, _, cask) = classify("/opt/homebrew/Caskroom/codex/0.147.0/bin/codex");
        assert_eq!(m, Manager::Brew);
        assert!(cask);
        assert_eq!(target.as_deref(), Some("codex"));

        let (m, _, _, cask) = classify("/opt/homebrew/Cellar/opencode/1.18.16/bin/opencode");
        assert_eq!(m, Manager::Brew);
        assert!(!cask);

        let (m, _, _, _) = classify("/Users/x/.local/share/claude/versions/2.1.228/claude");
        assert_eq!(m, Manager::Native);

        let (m, _, _, _) = classify("/Users/x/work/proj/node_modules/.bin/pi");
        assert_eq!(m, Manager::Local);

        // 用户级 ~/node_modules(用真实 HOME,classify 依赖环境变量)
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap();
        let (m, _, _, _) = classify(&format!("{}/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js", home));
        assert_eq!(m, Manager::User);
    }

    #[test]
    fn update_commands_follow_manager() {
        let npm = det_for(&AGENTS[3], "/Users/x/.local/share/fnm/node-versions/v24/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
        let cmd = build_update_cmd(&npm).unwrap();
        // npm 可执行文件按环境解析(真实路径/ PATH),断言用结尾匹配
        assert!(cmd[0].ends_with("npm"), "cmd[0] = {}", cmd[0]);
        assert_eq!(&cmd[1..], &["update", "-g", "--prefix", "/Users/x/.local/share/fnm/node-versions/v24/installation", "@earendil-works/pi-coding-agent"]);

        let brew_cask = det_for(&AGENTS[1], "/opt/homebrew/Caskroom/codex/0.1/bin/codex");
        let cmd = build_update_cmd(&brew_cask).unwrap();
        assert_eq!(cmd, vec!["brew", "upgrade", "--cask", "codex"]);

        let native = det_for(&AGENTS[0], "/Users/x/.local/share/claude/versions/2.1.228/claude");
        let cmd = build_update_cmd(&native).unwrap();
        assert_eq!(cmd, vec!["/Users/x/.local/share/claude/versions/2.1.228/claude", "update"]);

        let local = det_for(&AGENTS[3], "/Users/x/proj/node_modules/.bin/pi");
        assert!(build_update_cmd(&local).is_none());

        // npx 缓存:用 npx 拉最新版刷新缓存(dsh 官方 npx 用法)
        let dsh = det_for(&AGENTS[2], "/Users/x/.npm/_npx/abc/node_modules/.bin/dsh");
        let cmd = build_update_cmd(&dsh).unwrap();
        assert!(cmd[0].ends_with("npx"), "cmd[0] = {}", cmd[0]);
        assert_eq!(&cmd[1..], &["--yes", "@deepseek-ai/dsh@latest", "--version"]);

        // 项目本地依赖:跳过
        let local = det_for(&AGENTS[3], "/Users/x/proj/node_modules/.bin/pi");
        assert!(build_update_cmd(&local).is_none());
    }

    #[test]
    fn version_parse_and_compare() {
        assert_eq!(parse_version("2.1.228 (Claude Code)").as_deref(), Some("2.1.228"));
        assert_eq!(parse_version("omp/17.2.15").as_deref(), Some("17.2.15"));
        assert_eq!(parse_version("0.84.1").as_deref(), Some("0.84.1"));
        assert_eq!(parse_version("0.1.0-rc.6").as_deref(), Some("0.1.0-rc.6"));
        assert_eq!(parse_version("no version here"), None);
        assert!(compare_versions("1.0.0", "0.9.9") > 0);
        assert!(compare_versions("0.84.1", "0.84.2") < 0);
        assert_eq!(compare_versions("1.0.0", "1.0.0"), 0);
        assert!(compare_versions("1.0.10", "1.0.9") > 0);
        assert!(compare_versions("0.1.0-rc.5", "0.1.0-rc.6") < 0); // rc 后缀参与比较
        assert!(compare_versions("0.1.0-rc.6", "0.1.0-rc.6") == 0);
        assert!(compare_versions("0.1.0", "0.1.0-rc.6") > 0); // 正式版 > rc
    }

    #[test]
    fn registry_has_install_methods_for_all_agents() {
        for a in AGENTS {
            assert!(!a.install_methods.is_empty(), "{} 缺安装方式", a.name);
            assert!(a.npm_package.is_some(), "{} 缺 npm 包(用于 latest 检查)", a.name);
        }
    }

    #[test]
    fn clean_output_strips_ansi_and_splits_carriage_return() {
        // ANSI 颜色码去除
        let l = clean_output_line("\u{1b}[32m✔ done\u{1b}[0m");
        assert_eq!(l, vec!["✔ done".to_string()]);
        // 进度条 \r 刷新切分为独立行
        let l = clean_output_line("\u{1b}[2K\u{1b}[1G[####] 50%\r[########] 100%");
        assert_eq!(l, vec!["[####] 50%".to_string(), "[########] 100%".to_string()]);
        // 空白行过滤
        assert!(clean_output_line("   \r  ").is_empty());
    }

    #[test]
    fn manager_commands_detected_for_cmd_routing() {
        assert!(is_manager_cmd("npm install -g foo"));
        assert!(is_manager_cmd("bun add -g foo"));
        assert!(is_manager_cmd("pnpm add -g foo"));
        assert!(is_manager_cmd("brew install foo"));
        assert!(!is_manager_cmd("irm https://x/install.ps1 | iex"));
        assert!(!is_manager_cmd("curl -fsSL https://x | sh"));
    }

    #[test]
    fn windows_filters_out_brew_and_uses_powershell_variants() {
        // Windows 下:brew 不可用;curl 脚本换 PowerShell 变体;npm/bun 保留
        for a in AGENTS {
            let methods: Vec<_> = a.install_methods.iter().filter(|m| method_available_on(m, true)).collect();
            assert!(!methods.is_empty(), "{} 在 Windows 无可用安装方式", a.name);
            for m in methods {
                assert!(!m.command.starts_with("brew "), "{}: brew 不应出现在 Windows", a.name);
                if m.command.contains("| sh") || m.command.contains("| bash") {
                    assert!(m.windows.is_some(), "{}: curl|sh 方式缺 Windows 变体", a.name);
                }
            }
        }
        // claude 的 curl 方式在 Windows 走 PowerShell 变体
        let claude = &AGENTS[0];
        let curl = claude.install_methods.iter().find(|m| m.id == "curl").unwrap();
        assert_eq!(curl.windows, Some("irm https://claude.ai/install.ps1 | iex"));
        // unix 下全部可用
        for a in AGENTS {
            assert_eq!(a.install_methods.iter().filter(|m| method_available_on(m, false)).count(), a.install_methods.len());
        }
    }
}
