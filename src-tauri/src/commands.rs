// 薄 I/O 层:把前端需要的文件/路径/CLI 检测/拉取模型/打开链接映射到 Rust 命令。
// 所有命令返回 Result<T, String>,错误消息直接展示给用户。

use std::fs;
use std::path::Path;
use std::time::Duration;

use tauri::Manager;

/// 用户主目录。
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    dirs_home().ok_or_else(|| "无法解析用户主目录".to_string())
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

/// GET {base_url}/models,带 Bearer 鉴权,返回模型 id 列表(去重排序)。
/// async 命令:阻塞 HTTP 放到后台线程,避免卡住 UI;显式关闭环境代理检测,
/// 防止内网网关被本机 http_proxy 代理劫持导致连接被重置。
#[tauri::command]
pub async fn fetch_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_models_blocking(base_url, api_key))
        .await
        .map_err(|e| format!("请求任务失败: {}", e))?
}

fn fetch_models_blocking(base_url: String, api_key: String) -> Result<Vec<String>, String> {
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

    let mut ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
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
