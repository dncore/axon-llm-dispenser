// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 独立代理模式:由 GUI 以 `--proxy-server <port> <upstream> <pattern>` 拉起,
    // 脱离窗口常驻,Codex 的 base_url 指向它(127.0.0.1)。
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--proxy-server" {
        let port: u16 = args
            .get(2)
            .and_then(|s| s.parse().ok())
            .unwrap_or(axon_llm_dispenser_lib::proxy::DEFAULT_PORT);
        let upstream = args.get(3).cloned().unwrap_or_default();
        let pattern = args
            .get(4)
            .cloned()
            .unwrap_or_else(|| axon_llm_dispenser_lib::proxy::DEFAULT_CONVERT_PATTERN.to_string());
        // 监听地址列表(逗号分隔,默认 127.0.0.1)与 codex 主机名(默认 localhost)
        let bind_ips = args
            .get(5)
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let _codex_host = args.get(6).cloned().unwrap_or_else(|| "localhost".to_string());
        axon_llm_dispenser_lib::proxy::run_server_blocking(port, bind_ips, upstream, pattern);
        return;
    }
    axon_llm_dispenser_lib::run();
}
