# 安装 0.2.20

日常使用从 DeepSeek Harness 的 **插件 → 插件市场** 安装。没有市场页签时，先从 **插件 → 添加插件** 安装并启用 `dshmarket`。在市场搜索 `dsh-session-coordinator`，确认安装后，按提示刷新页面。在已安装列表确认版本为 0.2.20、组件正在运行。此流程已在干净的 macOS DSH 0.2.2-rc.5 上验证。

需要传递或留存固定安装包时，从 [GitHub 0.2.20 正式发布](https://github.com/cxydaizihao520/dsh-session-coordinator/releases/tag/v0.2.20)下载 `dsh-session-coordinator-0.2.20.tgz`，按发布页核对 SHA-256。

## 固定 npm 版本

在插件管理的 **添加插件** 中输入 `dsh-session-coordinator@0.2.20`，安装并启用。这个 [npm 版本](https://www.npmjs.com/package/dsh-session-coordinator/v/0.2.20) 与 GitHub 正式附件使用同一个验收包。

## 源码安装

从 GitHub 源码安装可使用：

```bash
dsh plugin --profile desktop add 'git+https://github.com/cxydaizihao520/dsh-session-coordinator.git#main'
```

如需固定源码版本，将 main 替换为完整提交 SHA。Git 安装需要构建。仅对已审查的提交使用安装器提示的准确 `allowBuilds` 键。构建环境使用 Node.js 22.18+（22 系列）或 24.11+、pnpm 10.30.3。

重启后用测试会话检查查找、创建和发送。首次操作按宿主审批确认目标与用途。验收边界见[本版验收](ACCEPTANCE.md)。
