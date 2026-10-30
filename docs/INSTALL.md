# 安装、升级与验证

本手册适用于 **0.2.15 预览版**。安装后核对实际版本及组件状态，再运行下方协作例子。使用预构建包无需克隆源码或运行构建。

## 首次安装与升级

当前公开源码为 **0.2.15**，npm 包尚未正式发布。需要已安装 DeepSeek Harness；终端中运行 `dsh --help` 检查命令可用。macOS 找不到命令时，可在应用菜单中选择“管理 dsh 命令…”，或使用 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。

```bash
dsh plugin --profile desktop add 'git+https://github.com/cxydaizihao520/dsh-session-coordinator.git#main'
```

Git 安装会获取源码并执行 prepare 构建，构建环境要求见下一节。若安装器要求批准构建，只批准它打印的准确包名及本次提交，不全局放行任意脚本。固定版本时，将命令中的 `#main` 替换为已核对的完整 Git 提交 SHA；升级时重新执行上述 main 命令并核对实际版本。

安装到其他 profile 不会更新当前桌面实例。先处理运行中的任务，再正常重启应用；只刷新前端不能证明宿主已经换版。无需删除工作区或聊天。

如果已经取得本版预构建文件，也可以从本地安装；本仓库当前没有声明已发布的 npm 或 Release 下载地址：

```bash
dsh plugin --profile desktop add ./dsh-session-coordinator-0.2.15.tgz
```

本地预构建 tgz 无需 Git prepare 构建。待 npm 正式发布并验收后，才可使用按包名安装；当前不要运行尚未生效的 npm 包名命令。

在插件管理中核对插件和组件启用、实际版本为 `0.2.15`，然后进行下方真实协作验证。不要仅凭安装命令退出 0 就认定使用流程通过。

## 从本候选源码构建

这部分仅面向开发者，需取得完整源码检出后执行，不能在 npm 安装目录中直接构建。使用 Node `22.18+`（22 系列）或 `24.11+`、pnpm `10.30.3`。构建工具要求高于插件清单中的 Node >=20。最低声明 Harness `0.2.1-rc.1`，跨版本实机结果以对应验收记录为准。

在完整源码目录逐条执行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm pack
dsh plugin --profile desktop add ./dsh-session-coordinator-0.2.15.tgz
```

Git 来源安装可能需要为指定提交批准 prepare 构建；请仅允许安装器给出的准确包名及提交，不全局放行任意脚本。预构建 npm 包和 tgz 不运行本插件的 prepare 构建。

## 安装后的真实验证

在一个测试聊天中输入：

> 请新建一个独立会话“核算复核”，与当前会话持续协作。第一轮计算 17+26，收到真实结果后让同一个会话换一种方法复核；我当前会话核对两次结果，再完成这次任务与协作。只联系这个新会话，不读写文件、不安装依赖。本任务内允许自动往返，首次审批后继续。

核对实际创建的是可独立打开的主会话，首次审批目标、成员和预算符合要求；两次真实结果均为 43，后续没有人工消息解锁；任务和范围都有完成状态。拒绝首次审批时不应创建或派工，取消不代表撤销外部副作用。

会话头部应提供“导出协作日志”；下载后确认版本、发送链及拒绝／失败阶段可关联，默认无正文和原始错误。该导出只保存到本机，不自动上传。命令兼容入口不替代图形入口验收。

本次隔离安装结果见[本版验收](ACCEPTANCE.md)。隔离 web profile 的结果不自动代表当前业务 Electron desktop profile、全部图形交互或其他平台均已验证。

## 卸载与反馈

```bash
dsh plugin --profile desktop remove dsh-session-coordinator
```

正常重启后核对移除状态，无需删除工作区和聊天。反馈到 [GitHub Issues](https://github.com/cxydaizihao520/dsh-session-coordinator/issues)，附版本、预期行为、实际错误和必要的脱敏复现信息。不要上传密钥、完整私人日志或业务数据。
