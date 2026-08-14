# axon-llm-dispenser

把**你自有的 OpenAI 兼容网关**（任意 `base_url` + `api_key`）一键接入常见的编码 / Agent 工具：

- **Codex CLI**
- **Reasonix**
- **DeepSeek Harness (dsh)**

并支持为 Reasonix 生成 / 关闭固定鉴权 Token。桌面应用（Tauri v2），macOS 与 Windows 便携运行，**免安装**。

## 功能

- **连接设置**：输入 provider 名（默认 `axon`，可自定义）、base_url、api_key，一键测试连接（`GET /models`）。
- **模型目录**：自动拉取 `/models`，支持手动增删模型 ID。
- **工具接入**：把网关写入各工具的**官方配置文件**，密钥写入各自的凭据文件（0600），写入前自动备份原文件：
  - Codex：`~/.codex/config.toml` + `~/.codex/models.json`
  - Reasonix：`~/.reasonix/config.toml` + `~/.reasonix/.env`
  - dsh：`~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`
- **Reasonix 鉴权**：生成固定 Token（`[serve]` 段）、关闭鉴权、查看状态。
- **检查更新**：查询 GitHub Releases，发现新版本跳转浏览器下载。

## 下载

从 [Releases](../../releases) 下载对应平台压缩包，解压即用：

| 平台 | 产物 | 说明 |
|------|------|------|
| macOS | `axon-llm-dispenser-macos-<版本>.zip` | 解压得到 `.app`，拖入「应用程序」双击运行 |
| Windows | `axon-llm-dispenser-windows-<版本>.zip` | 解压后双击 `axon-llm-dispenser.exe` |

### 首次打开（未签名）说明

应用暂未做代码签名，系统可能拦截：

- **macOS**：右键点 app →「打开」→ 弹窗里再点「打开」；或终端执行
  `xattr -dr com.apple.quarantine /Applications/axon-llm-dispenser.app`
- **Windows**：SmartScreen 提示时点「更多信息 → 仍要运行」

> 后续可接入 Apple Developer ID / Windows 代码签名证书彻底消除提示（预留了 CI 签名位）。

## 使用

1. 打开应用，在「连接设置」填入：
   - **Provider 名**：写入各工具的路由名，默认 `axon`（仅 `A-Za-z0-9._-`）
   - **Base URL**：如 `https://gateway.example.com/v1`
   - **API Key**：网关凭据
2. 点「测试连接」拉取模型列表（可手动增删）。
3. 在「工具接入」里点对应工具的「配置」，确认后即写入其官方配置文件。
4. 需要局域网访问 Reasonix 时点「生成 Token」。

配置保存在系统标准配置目录（macOS `~/Library/Application Support/com.axonllm.dispenser/config.json`、Windows `%APPDATA%\com.axonllm.dispenser\config.json`），更换应用二进制不丢配置。

## 从源码构建

```bash
# 前置：Node 20+、Rust（Tauri 依赖）、macOS 需 Xcode
npm install
npx tauri dev      # 开发运行
npx tauri build    # 产出 .app / .dmg（mac）或 .exe（win）
```

## 升级

手动升级：下载新版本压缩包解压替换即可（配置与各工具接入状态不受影响）。

## 技术栈

Tauri v2 + TypeScript（Vite）。核心配置逻辑为纯函数（`src/core/`），用 `vitest` 覆盖。

## License

MIT
