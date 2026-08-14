# macOS App 图标规范（Apple HIG 官方，供本项目复用）

来源：Apple Human Interface Guidelines（App Icons）+ Apple Design Resources（macOS App Icon Template），
以及 Tauri 官方讨论与多项目踩坑验证。

## 核心规范

| 项 | 值 |
|----|-----|
| 画布 | 1024×1024（透明 PNG） |
| 图标主体 | **824×824 居中**（(100,100)~(924,924)） |
| 主体圆角半径 | **≈185**（22% of 824） |
| 四周透明边距 | **100px** |

**关键：主体不铺满画布。** 源图必须带透明边距，否则 Dock/Launchpad 里图标会比原生应用大一圈。
圆角在源图内就要做好（系统同时会套 squircle 遮罩，双保险）。

## 常见错误

- ❌ 背景铺满 1024 → 大一圈、无圆角感
- ❌ 主体整体内缩（x0=R）→ 太小、浮在画布中间
- ❌ 细线条复杂图形 → 小尺寸发糊（用粗线条 + 简单对称）

## 本仓库图标

- 源图：`app-icon.png`（1024×1024）
- 生成：手写 PNG 光栅化脚本 → `npx tauri icon app-icon.png` → `tauri build` → `codesign --force --deep --sign -`
- 刷新缓存：`killall Dock; killall Finder`
- 图形：简单对称神经元（细胞体 + 8 对称辐射树突 + 末端圆点），深蓝渐变底
