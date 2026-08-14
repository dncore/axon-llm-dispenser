// 薄 I/O 层:把前端需要的文件/路径/CLI 检测/拉取模型/打开链接映射到 Rust 命令。
// 所有命令返回 Result<T, String>,错误消息直接展示给用户。

use std::fs;
use std::path::Path;
use std::time::Duration;

use tauri::{Emitter, Manager};

/// 用户主目录。
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    dirs_home().ok_or_else(|| "无法解析用户主目录".to_string())
}

/// 跨平台路径拼接(替代 tauri-plugin-path 的 join,避免 ACL 限制)。
#[tauri::command]
pub fn path_join(parts: Vec<String>) -> Result<String, String> {
    let mut p = std::path::PathBuf::new();
    for part in parts {
        if !part.is_empty() {
            p.push(part);
        }
    }
    Ok(p.to_string_lossy().to_string())
}

/// 应用自身配置目录(跨平台标准目录:macOS `~/Library/Application Support/<id>`,
/// Windows `%APPDATA%/<id>`,Linux `~/.config/<id>`)。
#[tauri::command]
pub fn config_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败 {}: {}", path, e))
}

/// 写文本文件;mode 可选(如 0o600)。已存在文件的权限用 chmod 单独修正。
#[tauri::command]
pub fn write_file(path: String, content: String, mode: Option<u32>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {}", parent.display(), e))?;
        }
    }
    fs::write(&path, content).map_err(|e| format!("写入失败 {}: {}", path, e))?;
    if let Some(m) = mode {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(m))
                .map_err(|e| format!("设置权限失败 {}: {}", path, e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn chmod(path: String, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(mode))
            .map_err(|e| format!("设置权限失败 {}: {}", path, e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 列出目录内容(名称/大小/修改时间),用于备份列表。
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("读取目录失败 {}: {}", path, e))?;
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy().to_string(),
            "isFile": meta.is_file(),
            "size": meta.len(),
            "mtimeMs": mtime,
        }));
    }
    Ok(out)
}

#[tauri::command]
pub fn mkdir(path: String, recursive: bool) -> Result<(), String> {
    if recursive {
        fs::create_dir_all(&path).map_err(|e| format!("创建目录失败 {}: {}", path, e))
    } else {
        fs::create_dir(&path).map_err(|e| format!("创建目录失败 {}: {}", path, e))
    }
}

/// 在 PATH 中查找 CLI(不执行任何命令,纯文件系统检查)。
#[tauri::command]
pub fn detect_cli(name: String) -> Option<String> {
    let path_var = std::env::var("PATH").ok()?;
    let exts: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat", ""]
    } else {
        &[""]
    };
    for dir in path_var.split(if cfg!(windows) { ';' } else { ':' }) {
        if dir.is_empty() {
            continue;
        }
        for ext in exts {
            let full = Path::new(dir).join(format!("{}{}", name, ext));
            if full.is_file() {
                return Some(full.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// GET {base_url}/models,带 Bearer 鉴权,返回 [{id, ownedBy}] 列表(去重排序)。
/// async 命令:阻塞 HTTP 放到后台线程,避免卡住 UI;显式关闭环境代理检测,
/// 防止内网网关被本机 http_proxy 代理劫持导致连接被重置。
#[tauri::command]
pub async fn fetch_models(base_url: String, api_key: String) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_models_blocking(base_url, api_key))
        .await
        .map_err(|e| format!("请求任务失败: {}", e))?
}

fn fetch_models_blocking(base_url: String, api_key: String) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false) // 强制不走环境/系统代理,直连网关
        .timeout(Duration::from_secs(15))
        .build();
    let mut req = agent.get(&url);
    if !api_key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", api_key));
    }
    let body = req
        .call()
        .map_err(|e| format!("请求 {} 失败: {}", url, e))?
        .into_string()
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("响应不是合法 JSON: {}", e))?;

    let rows: Vec<&serde_json::Value> = if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
        data.iter().collect()
    } else if let Some(arr) = json.as_array() {
        arr.iter().collect()
    } else {
        return Err("响应中未找到 models 列表(data 数组或顶层数组)".to_string());
    };

    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else { continue };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let owned_by = row.get("owned_by").and_then(|v| v.as_str()).map(|s| s.to_string());
        out.push(serde_json::json!({"id": id, "ownedBy": owned_by}));
    }
    out.sort_by(|a, b| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")));
    Ok(out)
}

/// 打开浏览器(检查更新跳转)。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let cmd = if cfg!(target_os = "macos") {
        ("open", vec![url.as_str()])
    } else if cfg!(windows) {
        ("cmd", vec!["/c", "start", "", url.as_str()])
    } else {
        ("xdg-open", vec![url.as_str()])
    };
    std::process::Command::new(cmd.0)
        .args(cmd.1)
        .spawn()
        .map_err(|e| format!("打开浏览器失败: {}", e))?;
    Ok(())
}

/// 跨平台主目录(不额外引 dirs crate,直接读 HOME/USERPROFILE)。
fn dirs_home() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(home);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.is_empty() {
                return Some(profile);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 自动更新(下载/解压/替换/重启)
// ---------------------------------------------------------------------------

use std::io::Read;

/// 解析可用代理:优先环境变量,其次 macOS 系统代理(scutil --proxy)。
/// 应用经 `open` 启动时不继承 shell 环境变量,必须读系统代理才能访问 GitHub。
fn resolve_proxy() -> Option<ureq::Proxy> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                if let Ok(p) = ureq::Proxy::new(&v) {
                    return Some(p);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("scutil").args(["--proxy"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut host: Option<String> = None;
        let mut port: Option<String> = None;
        let mut enabled = false;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("HTTPSEnable") || line.starts_with("HTTPEnable") {
                if line.contains(": 1") {
                    enabled = true;
                }
            }
            if let Some(v) = line.strip_prefix("HTTPSProxy :") {
                host = Some(v.trim().trim_matches('"').to_string());
            }
            if let Some(v) = line.strip_prefix("HTTPSPort :") {
                port = Some(v.trim().to_string());
            }
            if host.is_none() {
                if let Some(v) = line.strip_prefix("HTTPProxy :") {
                    host = Some(v.trim().trim_matches('"').to_string());
                }
            }
            if port.is_none() {
                if let Some(v) = line.strip_prefix("HTTPPort :") {
                    port = Some(v.trim().to_string());
                }
            }
        }
        if enabled {
            if let (Some(h), Some(p)) = (host, port) {
                if let Ok(proxy) = ureq::Proxy::new(format!("http://{}:{}", h, p)) {
                    return Some(proxy);
                }
            }
        }
    }
    None
}

/// 构建带代理的 ureq agent。
fn build_agent(timeout_secs: u64) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(timeout_secs));
    if let Some(proxy) = resolve_proxy() {
        builder = builder.proxy(proxy);
    }
    builder.build()
}

/// 当前平台标识:macos / windows / linux。/// 当前平台标识:macos / windows / linux。
#[tauri::command]
pub fn platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(windows) {
        "windows".to_string()
    } else {
        "linux".to_string()
    }
}

/// 当前应用目录:macOS 为 .app bundle;其它平台为可执行文件所在目录。
#[tauri::command]
pub fn current_app_dir() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if cfg!(target_os = "macos") {
        if let (Some(macos), Some(contents), Some(bundle)) = (
            exe.parent(),
            exe.parent().and_then(|p| p.parent()),
            exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()),
        ) {
            let _ = (macos, contents);
            if bundle.to_string_lossy().ends_with(".app") {
                return Ok(bundle.to_string_lossy().to_string());
            }
        }
    }
    Ok(exe.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| exe.to_string_lossy().to_string()))
}

/// 下载文件(异步,不阻塞 UI;默认 Agent 读取系统代理,适配 GitHub Releases)。
/// 流式写入并定时发送 download-progress 事件 {received, total, done} 供前端显示进度。
#[tauri::command]
pub async fn download_file(app: tauri::AppHandle, url: String, dest: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || download_file_blocking(app, url, dest))
        .await
        .map_err(|e| format!("下载任务失败: {}", e))?
}

fn download_file_blocking(app: tauri::AppHandle, url: String, dest: String) -> Result<(), String> {
    use std::io::{Read, Write};
    let agent = build_agent(180);
    let resp = agent.get(&url).call().map_err(|e| format!("下载失败 {}: {}", url, e))?;
    let total: u64 = resp
        .header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    if let Some(parent) = Path::new(&dest).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = fs::File::create(&dest).map_err(|e| format!("创建文件失败 {}: {}", dest, e))?;
    let mut buf = [0u8; 16384];
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if last_emit.elapsed().as_millis() >= 50 {
            let _ = app.emit(
                "download-progress",
                serde_json::json!({ "received": received, "total": total }),
            );
            last_emit = std::time::Instant::now();
        }
    }
    let _ = app.emit(
        "download-progress",
        serde_json::json!({ "received": received, "total": total, "done": true }),
    );
    Ok(())
}

/// 解压 zip 到目录(异步,不阻塞 UI;安全:防路径穿越,条目限制 512)。
#[tauri::command]
pub async fn unzip_file(zip_path: String, dest_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || unzip_file_blocking(zip_path, dest_dir))
        .await
        .map_err(|e| format!("解压任务失败: {}", e))?
}

fn unzip_file_blocking(zip_path: String, dest_dir: String) -> Result<(), String> {
    let file = fs::File::open(&zip_path).map_err(|e| format!("打开 {} 失败: {}", zip_path, e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压失败: {}", e))?;
    if archive.len() > 512 {
        return Err("更新包条目过多,拒绝解压".to_string());
    }
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // 防路径穿越
        let name = entry.name().replace('\\', "/");
        if name.split('/').any(|seg| seg == "..") {
            return Err(format!("更新包含非法路径: {}", name));
        }
        let out_path = Path::new(&dest_dir).join(&name);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 用解压目录中的新 .app 替换当前应用(macOS),并清理临时目录。
#[tauri::command]
pub fn replace_app(unzip_dir: String) -> Result<(), String> {
    let current = current_app_dir()?;
    let entries = fs::read_dir(&unzip_dir).map_err(|e| e.to_string())?;
    let mut new_app: Option<std::path::PathBuf> = None;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_dir() && entry.file_name().to_string_lossy().ends_with(".app") {
            new_app = Some(entry.path());
        }
    }
    let new_app = new_app.ok_or_else(|| format!("解压目录中未找到 .app: {}", unzip_dir))?;
    // macOS 允许替换运行中的应用 bundle;先移除旧目录再改名
    if Path::new(&current).exists() {
        fs::remove_dir_all(&current).map_err(|e| format!("移除旧应用失败 {}: {}", current, e))?;
    }
    if let Some(parent) = Path::new(&current).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&new_app, &current).map_err(|e| format!("替换应用失败: {}", e))?;
    let _ = fs::remove_dir_all(&unzip_dir);
    Ok(())
}

/// 重启应用。
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

/// 查询 GitHub 最新 Release(系统代理),返回 {tag, htmlUrl, assets:[{name,url}]}。
#[tauri::command]
pub fn github_latest(owner: String, repo: String) -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/{}/{}/releases/latest", owner, repo);
    let agent = build_agent(30);
    let resp = agent
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "axon-llm-dispenser")
        .call()
        .map_err(|e| format!("查询更新失败: {}", e))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let tag = json.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let html_url = json.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let assets: Vec<serde_json::Value> = json
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let name = a.get("name")?.as_str()?;
                    let url = a.get("browser_download_url")?.as_str()?;
                    Some(serde_json::json!({ "name": name, "url": url }))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(serde_json::json!({ "tag": tag, "htmlUrl": html_url, "assets": assets }))
}
