mod agent_update;
mod commands;
pub mod proxy;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
#[cfg(target_os = "macos")]
use tauri::RunEvent;

/// 托盘「打开主界面」:显示并聚焦主窗口。
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // macOS:恢复 Dock 图标(关窗时已隐藏),窗口可见时表现为正常应用。
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 托盘「退出并停止代理」:先停掉 Codex 转换代理,再真正退出。
fn quit_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = crate::proxy::stop(&dir.to_string_lossy());
    }
    app.exit(0);
}

/// 系统托盘:左键点击恢复主窗口;右键菜单「打开主界面 / 退出并停止代理」。
/// 真正退出只走托盘菜单——关闭窗口(CloseRequested)一律拦截并隐藏到托盘,Codex 转换
/// 代理进程与 GUI 相互独立,关窗/退出 GUI 均不影响 Codex 继续可用。
fn setup_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出并停止代理", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| tauri::image::Image::new(&[], 0, 0)))
        .tooltip("Axon LLM dispenser")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            // 关闭按钮仅隐藏到托盘;真正退出走托盘「退出并停止代理」。
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                // macOS:窗口隐藏后移除 Dock 运行态,只留菜单栏图标。
                #[cfg(target_os = "macos")]
                let _ = window.app_handle().set_dock_visibility(false);
                api.prevent_close();
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动:通知已在运行的实例显示主窗口,本进程随即退出。
            show_main_window(app);
        }))
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::home_dir,
            commands::path_join,
            commands::config_dir,
            commands::read_file,
            commands::write_file,
            commands::chmod,
            commands::rename_file,
            commands::delete_file,
            commands::validate_config,
            commands::exists,
            commands::read_dir,
            commands::mkdir,
            commands::detect_cli,
            commands::detect_cli_in,
            commands::fetch_models,
            commands::open_url,
            commands::app_version,
            commands::proxy_start,
            commands::proxy_status,
            commands::proxy_stop,
            agent_update::agent_check,
            agent_update::agent_update,
            agent_update::agent_install,
            agent_update::pi_extensions_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building axon-llm-dispenser")
        .run(|_app_handle, event| match event {
            // macOS:点击 Dock 图标 / Finder 重新打开应用时恢复主窗口。
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main_window(_app_handle),
            _ => {}
        });
}
