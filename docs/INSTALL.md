# 安装 0.2.20 预览版

npm 预览包可用后，在 DeepSeek Harness 的插件管理界面添加 `dsh-session-coordinator@beta`。支持 CLI 管理的 profile 也可运行：

```bash
dsh plugin --profile desktop add dsh-session-coordinator@beta
```

如果 CLI 提示桌面 profile 由运行中的应用独占，请使用应用内的插件管理。安装或升级后正常重启 Harness，在插件管理中核对实际版本。公开 npm 包使用预构建产物。

从 GitHub 源码安装可使用：

```bash
dsh plugin --profile desktop add 'git+https://github.com/cxydaizihao520/dsh-session-coordinator.git#main'
```

如需固定源码版本，将 main 替换为完整提交 SHA。Git 安装需要构建。仅对已审查的提交使用安装器提示的准确 `allowBuilds` 键。构建环境使用 Node.js 22.18+（22 系列）或 24.11+、pnpm 10.30.3。

重启后用测试会话检查查找、创建和发送。首次操作按宿主审批确认目标与用途。验收边界见[本版验收](ACCEPTANCE.md)。
