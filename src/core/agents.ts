// 各 agent 的 CLI 检测信息:bin 名 + 候选安装目录(按官方安装方式汇总)。
// 目录支持 `~` 前缀与 glob 通配;检测时先查 PATH,再逐个查这些目录。

export type AgentCli = { bin: string; dirs: string[]; note?: string };

/** npm 全局 / Node 版本管理器 / Homebrew 的常见 bin 目录(macOS + Windows + Linux)。 */
const COMMON_BINS = [
  "~/.local/bin", // 原生安装器(Claude Code / Codex)与 npm 全局默认 prefix
  "~/.npm-global/bin",
  "~/.nvm/versions/node/*/bin", // nvm(POSIX)
  "~/.local/share/fnm/node-versions/*/installation/bin", // fnm(POSIX)
  "~/Library/Application Support/fnm/node-versions/*/installation/bin", // fnm(macOS data 目录)
  "~/.fnm/node-versions/*/installation", // fnm 旧版基目录(~/.fnm)
  "~/.volta/bin",
  "~/Library/pnpm", // pnpm(macOS)
  "~/.local/share/pnpm", // pnpm(Linux)
  "~/.pnpm", // pnpm 兜底目录
  "~/.bun/bin", // bun(跨平台)
  "/opt/homebrew/bin", // Homebrew(Apple Silicon)
  "/usr/local/bin", // Homebrew(Intel)
  "~/AppData/Roaming/npm", // Windows:npm 全局
  "C:/Program Files/nodejs", // Windows:node MSI 与 nvm-windows 的活动版本符号链接
  "~/AppData/Roaming/nvm/*", // Windows:nvm-windows 各版本目录(全局 bin 与 node.exe 同目录)
  "~/AppData/Local/Volta/bin", // Windows:Volta
  "~/AppData/Roaming/fnm/node-versions/*/installation", // Windows:fnm(%APPDATA%\fnm)
  "~/AppData/Local/pnpm", // Windows:pnpm(%LOCALAPPDATA%\pnpm)
  "~/scoop/shims", // Windows:Scoop
];

export const AGENT_CLIS: Record<string, AgentCli> = {
  claude: {
    bin: "claude",
    // 原生安装器:launcher 在 ~/.local/bin,版本二进制在 ~/.local/share/claude/versions/*
    dirs: [...COMMON_BINS, "~/.local/share/claude/versions/*"],
  },
  codex: {
    bin: "codex",
    // 官方原生安装器:POSIX 装到 ~/.local/bin,Windows(install.ps1)装到 %LOCALAPPDATA%\Programs\OpenAI\Codex\bin
    dirs: [...COMMON_BINS, "~/AppData/Local/Programs/OpenAI/Codex/bin"],
  },
  dsh: {
    bin: "dsh",
    // 官方方式为 npx @deepseek-ai/dsh:npx 会把包缓存到 ~/.npm/_npx/<hash>/
    dirs: [
      ...COMMON_BINS,
      "~/.npm/_npx/*/node_modules/.bin", // macOS/Linux:npx 缓存
      "~/AppData/Local/npm-cache/_npx/*/node_modules/.bin", // Windows:npx 缓存
    ],
    note: "官方推荐 npx @deepseek-ai/dsh 运行,检测已覆盖 npm 的 npx 缓存",
  },
  pi: {
    bin: "pi",
    // curl 安装器(pi.dev/install.sh)与 npm/pnpm/bun 全局安装均落在 npm 全局目录
    dirs: [...COMMON_BINS],
  },
  omp: {
    bin: "omp",
    // curl 安装器(omp.sh/install)→ ~/.local/bin;brew tap can1357/tap/omp;bun 全局 @oh-my-pi/pi-coding-agent
    dirs: [...COMMON_BINS],
  },
  reasonix: {
    bin: "reasonix",
    // npm i -g reasonix / brew install esengine/reasonix/reasonix
    dirs: [...COMMON_BINS],
  },
};
