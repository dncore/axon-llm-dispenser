//! App 自身更新检查与升级。
//!
//! - 检查:查询 GitHub Releases 最新 tag,与当前 App 版本比对。
//! - macOS(Homebrew cask 用户):一键执行 `brew upgrade axon-llm-dispenser`
//!   (cask 更新时 preflight 会自动退出运行中的旧版,升级后重开即新版)。
//! - Windows(便携 exe):只负责跳转下载页,由用户手动替换(运行中 exe 不可覆盖)。

use std::time::Duration;

use serde_json::{Value, json};

/// 解析 `vX.Y.Z` 为元组比较;非 `v` 前缀时按原样处理。简易数值比较,忽略预发布段。
fn parse_version(v: &str) -> Vec<u64> {
    let s = v.trim().trim_start_matches('v');
    s.split('.')
        .map(|p| {
            p.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let l = parse_version(latest);
    let c = parse_version(current);
    for i in 0..l.len().max(c.len()) {
        let a = l.get(i).copied().unwrap_or(0);
        let b = c.get(i).copied().unwrap_or(0);
        if a > b {
            return true;
        }
        if a < b {
            return false;
        }
    }
    false
}

/// 查询 GitHub Releases 最新版本信息。返回 { current, latest, url, updateAvailable }。
#[tauri::command]
pub fn check_update(
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use tauri::Manager;
    let current = app.package_info().version.to_string();
    let url = "https://api.github.com/repos/dncore/axon-llm-dispenser/releases/latest";
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false) // 直连;避免本机 http_proxy 劫持(与 fetch_models 一致)
        .timeout(Duration::from_secs(15))
        .build();
    let body = agent
        .get(url)
        .set("User-Agent", "axon-llm-dispenser")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("查询更新失败(GitHub 不可达?): {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let data: Value =
        serde_json::from_str(&body).map_err(|e| format!("GitHub 响应异常: {e}"))?;

    let latest = data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let html_url = data
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/dncore/axon-llm-dispenser/releases")
        .to_string();
    let update_available = !latest.is_empty() && is_newer(&latest, &current);

    Ok(json!({
        "current": current,
        "latest": latest,
        "url": html_url,
        "updateAvailable": update_available,
    }))
}

/// macOS:执行 `brew upgrade axon-llm-dispenser`(流式日志走 agent-update-log 事件)。
/// 升级会由 cask preflight 退出当前旧版;若 brew 不可用则报错。
#[tauri::command]
pub fn update_macos(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        return Err("当前平台请从下载页手动更新".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        run_brew_upgrade(&app)
    }
}

#[cfg(target_os = "macos")]
fn run_brew_upgrade(app: &tauri::AppHandle) -> Result<(), String> {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    use tauri::Emitter;

    let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .find(|b| std::path::Path::new(b).exists())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "brew".to_string());

    let mut child = Command::new(&brew)
        .args(["upgrade", "--cask", "axon-llm-dispenser"])
        .env("HOMEBREW_NO_AUTO_UPDATE", "1") // 跳过 brew update,减少卡顿/耗时
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 brew 升级失败: {e}"))?;

    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let a1 = app.clone();
    let a2 = app.clone();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(out).lines() {
            if let Ok(l) = line {
                a1.emit("agent-update-log", l).ok();
            }
        }
    });
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(err).lines() {
            if let Ok(l) = line {
                a2.emit("agent-update-log", format!("[brew] {l}")).ok();
            }
        }
    });

    let status = child
        .wait()
        .map_err(|e| format!("等待 brew 升级失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("brew 升级退出码 {}", status.code().unwrap_or(-1)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_newer() {
        assert!(is_newer("0.5.17", "0.5.16"));
        assert!(is_newer("0.6.0", "0.5.99"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.5.16", "0.5.16"));
        assert!(!is_newer("0.5.15", "0.5.16"));
        assert!(!is_newer("0.5.16", "0.5.16.1"));
        assert!(is_newer("0.5.16.1", "0.5.16"));
    }
}