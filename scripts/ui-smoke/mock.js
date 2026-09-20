// UI 冒烟测试用的 Tauri IPC 模拟层(由 run.mjs 注入到构建产物页面,运行在无头浏览器里)。
// 把 __TAURI_INTERNALS__.invoke 实现为内存文件系统 + 固定返回,便于在真实 DOM 上跑交互断言。
(() => {
  // 固定的假网关模型列表(含 1 个 doubao,用于验证「过滤 Doubao」开关生效)
  const GATEWAY_MODELS = [
    "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.3", "glm-5.3-flash", "kimi-k3",
    "qwen3.8-max", "gemini-3.7-flash", "claude-sonnet-5", "grok-4.6", "hy3",
    "hy4", "step-3.7-flash", "MiniMax-M3", "MiMo-V2.5", "qwen3.7-plus",
    "doubao-pro",
  ];

  const entry = (slug, visibility, prefix) => ({
    base_instructions: "",
    context_window: 1000000,
    description: `${prefix}: ${slug} — openai-compatible gateway`,
    display_name: slug,
    experimental_supported_tools: [],
    max_context_window: 1000000,
    priority: 20,
    shell_type: "shell_command",
    slug,
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: [{ effort: "low", description: "Low" }],
    supports_images: false,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: false,
    supports_tools: true,
    truncation_policy: { limit: 1000000, mode: "tokens" },
    use_responses_lite: false,
    visibility,
  });

  // 既有目录:12 条(10 可见 + 2 隐藏);另有 3 个网关模型不在目录里(算"新增")。
  // 描述前缀故意混用(模拟 provider 改名/其它工具写入的旧条目)。
  const VISIBLE = ["glm-5.3", "deepseek-v4-flash", "kimi-k3", "qwen3.8-max", "gemini-3.7-flash",
    "claude-sonnet-5", "grok-4.6", "deepseek-v4-pro", "hy3", "step-3.7-flash"];
  const HIDDEN = ["hy4", "MiMo-V2.5"];
  const CATALOG = JSON.stringify({
    models: [
      ...VISIBLE.map((s, i) => entry(s, "list", i % 2 ? "axon" : "legacy tool")),
      ...HIDDEN.map((s) => entry(s, "hide", "axon")),
    ],
  }, null, 2) + "\n";
  const CONFIG = JSON.stringify({
    provider: "axon",
    displayName: "Axon",
    baseUrl: "https://gw.example/v1",
    apiKey: "sk-test",
    defaultModel: "",
    anthropicBaseUrl: "",
    excludeDoubao: true,
    codexProxy: { enabled: true, port: 17321 },
    models: GATEWAY_MODELS.map((id) => ({ id })),
  }, null, 2) + "\n";
  const CODEX_TOML = 'model_provider = "axon"\nmodel = "deepseek-v4-flash"\n\n[model_providers.axon]\nbase_url = "http://localhost:17321/api/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n';

  const initialFs = () => ({
    "/mock/home/.config/axon/config.json": CONFIG,
    "/mock/home/.codex/config.toml": CODEX_TOML,
    "/mock/home/.codex/models.json": CATALOG,
  });

  const state = { fs: initialFs(), writes: [], calls: [] };
  window.__MOCK__ = state;
  window.__MOCK__.gatewayModels = GATEWAY_MODELS;
  window.__MOCK__.seedVisible = VISIBLE;
  window.__MOCK__.seedHidden = HIDDEN;

  let cbId = 1;
  const callbacks = {};
  const handlers = {
    read_file: (a) => {
      if (!(a.path in state.fs)) throw new Error(`mock: no such file ${a.path}`);
      return state.fs[a.path];
    },
    write_file: (a) => {
      state.fs[a.path] = a.content;
      state.writes.push({ path: a.path, content: a.content, mode: a.mode ?? null });
      return null;
    },
    chmod: () => null,
    rename_file: (a) => { state.fs[a.to] = state.fs[a.from]; delete state.fs[a.from]; return null; },
    delete_file: (a) => { delete state.fs[a.path]; return null; },
    validate_config: () => null,
    exists: (a) => a.path in state.fs,
    read_dir: () => [],
    mkdir: () => null,
    detect_cli: () => null,
    detect_cli_in: () => null,
    agent_check: () => [],
    agent_update: () => null,
    agent_install: () => null,
    pi_extensions_update: () => null,
    fetch_models: () => GATEWAY_MODELS.map((id) => ({ id, ownedBy: "mock" })),
    proxy_start: (a) => ({ port: a.port, pid: 4242, upstream: a.upstreamBaseUrl, pattern: a.convertPattern, codexHost: "localhost", modelsJsonPath: a.modelsJsonPath }),
    proxy_status: () => ({ running: false }),
    proxy_stop: () => null,
    open_url: () => null,
    app_version: () => "0.0.0-smoke",
    check_update: () => ({ current: "0.0.0-smoke", latest: "0.0.0-smoke", url: "", updateAvailable: false }),
    update_macos: () => null,
    home_dir: () => "/mock/home",
    config_dir: () => "/mock/home/.config/axon",
    path_join: (a) => a.parts.filter((p) => p !== "").join("/"),
    "plugin:autostart|is_enabled": () => false,
    "plugin:autostart|enable": () => null,
    "plugin:autostart|disable": () => null,
    "plugin:event|listen": () => cbId,
    "plugin:event|unlisten": () => null,
    "plugin:event|emit": () => null,
  };

  window.__TAURI_INTERNALS__ = {
    callbacks,
    transformCallback(cb) { const id = cbId++; callbacks[id] = cb; return id; },
    unregisterCallback(id) { delete callbacks[id]; },
    runCallback(id, data) { if (callbacks[id]) callbacks[id](data); },
    convertFileSrc: (p) => p,
    metadata: { currentWebview: { label: "main" }, currentWindow: { label: "main" } },
    invoke: async (cmd, args = {}) => {
      state.calls.push(cmd);
      if (cmd in handlers) return handlers[cmd](args);
      console.warn("[ui-smoke] unhandled command:", cmd, args);
      return null;
    },
  };
})();
