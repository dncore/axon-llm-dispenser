# axon-llm-dispenser 设计文档

## 1. 概述

`axon-llm-dispenser` 是一个跨平台桌面应用（Tauri v2），用于把**用户自有的 OpenAI 兼容网关**（base_url + api_key）一键配置到各 Agent 工具（Codex、Claude Code、dsh、Pi、omp、Reasonix 等），并为 Reasonix 生成/关闭 Web 服务鉴权 Token。

它是从 一个 pi-agent 插件中 的「鉴权生成与配置」能力抽取、脱敏、泛化而来：不内置任何公司网关地址、不做团队级模型排除名单，`provider 名`、`base_url`、`api_key` 全部由用户输入。

## 2. 目标与范围

### 2.1 目标

- 用户在 GUI 中输入 `provider 名`（默认 `axon`）、`base_url`、`api_key`。
- 一键把该网关写入 Codex / Reasonix / dsh 的**官方配置文件**，密钥写入各自的凭据文件。
- 支持 Reasonix 的固定 Token 鉴权生成 / 关闭 / 状态查看。
- 便携式产物：macOS `.app`（zip）与 Windows 便携 zip，免安装直接运行。
- 应用内「检查更新」，指向 GitHub Releases 手动升级。

### 2.2 非目标（v1 不做）

- 自动更新（Tauri updater 插件，需 macOS 代码签名）。
- pi agent 的 provider 注册与 web-fetch 提炼模型配置（pi 专属）。
- 团队级模型白名单 / 排除名单（无公司上下文）。
- 代码签名证书与公证（预留 CI 位）。

## 3. 架构

```
axon-llm-dispenser/
├── src-tauri/            # Rust 后端（薄 I/O 层）
│   ├── src/main.rs
│   ├── src/commands.rs   # 文件/路径/CLI检测/拉取模型/打开URL
│   ├── tauri.conf.json
│   └── Cargo.toml
├── src/                  # 前端（Vite + TypeScript，vanilla）
│   ├── main.ts           # 入口 + UI 装配
│   ├── core/             # 从插件移植的纯逻辑（无 Node 依赖）
│   │   ├── codex.ts      # Codex config.toml / models.json 补丁
│   │   ├── reasonix.ts   # Reasonix [[providers]] + [serve] 鉴权
│   │   ├── dsh.ts        # dsh settings.yaml + .credentials.yaml
│   │   ├── models.ts     # 模型元数据（KNOWN_MODELS + 推断）
│   │   └── types.ts
│   ├── bridge.ts         # Tauri invoke 封装（fs/home_dir/config_dir/...）
│   └── ui/               # 视图：连接设置 / 工具接入 / 鉴权 / 状态
├── index.html
├── package.json
└── .github/workflows/release.yml
```

### 3.1 分层原则

- **纯逻辑层（`core/`）**：`patch*` / `status*` / 模型元数据推断都是「字符串进、字符串出」的纯函数，不依赖 Node / DOM，只依赖一个注入的 `Env`（提供 home 目录等）。这层是移植重点，也是可单测的部分。
- **桥接层（`bridge.ts`）**：把纯逻辑需要的文件读写、路径、chmod、`randomBytes`（用 `crypto.getRandomValues`）、CLI 检测、拉取 `/models` 映射到 Tauri `invoke`。
- **UI 层（`ui/`）**：表单 + 按钮 + 状态列表，只调桥接层。

### 3.2 Rust 命令面（薄）

| 命令 | 作用 |
|------|------|
| `home_dir()` | 返回用户主目录 |
| `config_dir()` | 返回应用自身配置目录（跨平台标准目录） |
| `read_file(path)` | 读文本文件 |
| `write_file(path, content, mode?)` | 写文本文件（可指定 mode，如 0600） |
| `chmod(path, mode)` | 显式 chmod |
| `exists(path)` | 存在性 |
| `mkdir(path, recursive)` | 建目录 |
| `detect_cli(name)` | 在 PATH 中查找 CLI（不执行任何命令） |
| `fetch_models(base_url, api_key)` | GET `/models`，返回模型 id 列表 |
| `open_url(url)` | 打开浏览器（检查更新跳转） |

## 4. 脱敏与泛化映射

| 原插件 | 脱敏后 |
|--------|--------|
| provider 名硬编码(原插件固定名) | 用户自定义，默认 `axon`，校验 `[A-Za-z0-9][A-Za-z0-9._-]*` |
| 环境变量(原插件固定名) | `deriveKeyRef(provider名)` = 大写去非法字符 + `_API_KEY`（对齐 dsh 官方规则） |
| 内置默认网关地址 | 删除，用户输入 |
| 团队排除名单 `CODEX_EXCLUDED_MODELS` | 删除，无硬编码排除 |
| 可用性白名单 `CODEX_OK_MODELS` | 删除，/models 拉到的全部可见 |
| 插件自身的 `.env` 路径 | 应用配置 `config_dir()/config.json` |
| pi-web-fetch 提炼模型 | 删除 |
| 默认模型 `deepseek-v4-flash` | 用户可自选，默认取 /models 第一个（无则留空） |
| `KNOWN_MODELS` 110+ 模型元数据 | **保留**（通用模型元数据，非公司信息） |

## 5. 各目标工具的写入规范

### 5.1 Codex（`~/.codex/`）

- `config.toml`：`model_provider = "<provider>"`、`model = "<默认模型>"`、`model_catalog_json = "~/.codex/models.json"`、`[model_providers.<provider>]`（`base_url`、`wire_api = "responses"`、`requires_openai_auth = false`、`experimental_bearer_token = <api_key>`）。
- `models.json`：`/models` 结果（+ 手动增删）写成 `{ id, name, context_window, max_tokens, visibility: "list" }`，用 `KNOWN_MODELS` 补元数据。
- 写前自动备份 `config.toml.bak-<时间戳>` / `models.json.bak-<时间戳>`。

### 5.2 Reasonix（`~/.reasonix/`，可 `REASONIX_HOME` 覆盖）

- `config.toml` `[[providers]]`：`name = "<provider>"`、`kind = "openai"`、`base_url`、`models`、`default`、`api_key_env = "<deriveKeyRef>"`、`model_overrides`（context_window）。
- `.env`：`<deriveKeyRef>=<api_key>`（0600）。
- 鉴权：`[serve]` 段写 `auth_mode = "token"` + 固定 `token`（32 字节 base64url）或 `auth_mode = "none"` 并移除 token。

### 5.3 DeepSeek Harness（`~/.dsh/`，可 `DSH_HOME` 覆盖）

- `settings.yaml`：`llm-pi-ai.providers.<provider>`（`apiKeyEnv` 引用 + `api: openai-completions` + `baseURL` + `compat.thinkingFormat` 可选 + `models` 带 contextWindow/maxTokens/reasoningEfforts）+ `agent-default-model`（默认模型指向该 provider）。
- `.credentials.yaml`：`<deriveKeyRef>: <api_key>`（0600）。
- `reasoningEfforts` 只取非 `off` 且值非空的等级（规避 dsh 校验：仅含 off 会被整体拒绝——已在上游踩过坑）。

## 6. 应用自身配置

`config_dir()/config.json`：

```json
{
  "provider": "axon",
  "baseUrl": "https://...",
  "apiKey": "sk-...",
  "defaultModel": "deepseek-v4-flash"
}
```

- `apiKey` 落盘到应用自身配置目录（0600）；更换应用二进制不影响该文件。

## 7. 数据流（一次「配置 dsh」）

1. UI 读取 `config.json` → 展示 provider/base_url/api_key。
2. 用户点「配置」→ `fetch_models(base_url, api_key)` 拉模型列表 → 合并手动增删。
3. 构建 `models` 条目（`models.ts` 补 contextWindow/maxTokens/reasoningEfforts）。
4. `core/dsh.ts` 的 `patchDshProvider` + `patchDshDefaultModel` 生成 settings.yaml 文本。
5. 确认弹窗 → `bridge.write_file`（含备份）+ 写 `.credentials.yaml`（0600）。
6. 展示结果 + Web UI 链接。

## 8. 错误处理

- 所有 Rust 命令返回 `Result<T, String>`，UI 统一 toast 展示中文错误。
- 目标工具未安装不阻塞配置（只写文件）；`detect_cli` 仅用于状态提示。
- `/models` 拉取失败（非 200 / 超时 / 无 data）→ 提示，允许纯手动输入模型列表。
- 写文件前检测内联 YAML/TOML 样式（flow style），遇无法安全 patch 的结构明确报错而非破坏文件。

## 9. 打包与分发

- `tauri build`：
  - macOS：`.app`（ad-hoc 签名）→ 打 zip。
  - Windows：便携 zip（`app.exe` + WebView2 引导 + 资源）。
- 产物命名：`axon-llm-dispenser-<target>-<版本>.zip`。
- GitHub Actions：`macos-latest` + `windows-latest` matrix，构建并上传到 Release。
- 未签名：README 写明 macOS「右键→打开」/ `xattr -dr com.apple.quarantine`、Windows「更多信息→仍要运行」。
- 预留签名位：`APPLE_CERTIFICATE` / `APPLE_ID` 等 Secret 就位后可接入签名 + 公证。

## 10. 升级策略

- 手动升级：GitHub Releases 发布 zip；应用内「检查更新」调 GitHub API，发现新版本提示并 `open_url` 到 Release 页；用户下载解压替换。
- 应用自身配置与各工具的配置都存于系统目录，替换二进制不丢配置。

## 11. 测试

- `core/` 纯函数用 `vitest` 覆盖：各工具 patch 的 4 类用例（空文件 / 有其它段 / 已有目标段 / 更新幂等）+ 模型元数据推断 + `deriveKeyRef`。
- 生成 YAML/TOML 用 `yaml` 库解析校验，保证产物可被目标工具读取。
