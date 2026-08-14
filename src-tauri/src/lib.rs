mod commands;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::home_dir,
            commands::path_join,
            commands::config_dir,
            commands::read_file,
            commands::write_file,
            commands::chmod,
            commands::exists,
            commands::read_dir,
            commands::mkdir,
            commands::detect_cli,
            commands::fetch_models,
            commands::open_url,
            commands::app_version,
                                                                                            ])
        .run(tauri::generate_context!())
        .expect("error while running axon-llm-dispenser");
}
