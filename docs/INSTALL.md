# 安装、升级与验证

面向 DeepSeek Harness 使用者，以及受使用者授权代为安装的 Agent。当前源码试用分支为 `share/latest-source`，版本以 `package.json` 和安装后插件管理页为准。

## 首次安装

1. 检查本机环境：已安装 Harness；终端执行 `node --version`、`pnpm --version`、`dsh --help`。本版构建要求 Node **22.18+（22 系列）或 24.11+**，推荐当前 Node 24 LTS；pnpm 使用仓库 `packageManager` 指定版本。插件最低声明 Harness 0.2.1-rc.1，实际验证宿主为 0.2.1-rc.3。

   macOS 中找不到 `dsh` 时，可在 Harness 应用菜单选择“管理 dsh 命令…”配置命令；或在后续命令中用 `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"` 替代 `dsh`。其他平台使用其本机安装提供的命令位置，尚未实机验证。

2. 在自己选择的源码目录克隆并构建；各命令成功后再执行下一条：

   ```bash
   git clone --branch share/latest-source https://github.com/cxydaizihao520/dsh-session-coordinator.git
   cd dsh-session-coordinator
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build
   pnpm smoke
   pnpm pack
   ```

   完成条件：命令退出码均为 0，`lib/index.js` 存在，并生成 `dsh-session-coordinator-<版本>.tgz`。只有源码目录而没有构建产物，不能视为可安装。

3. 安装刚生成的包到桌面 profile：

   ```bash
   dsh plugin --profile desktop add ./dsh-session-coordinator-0.2.8.tgz
   ```

   版本升级后使用上一步真实生成的包名。安装到其他 profile 不会更新桌面实例。通过打包安装，桌面使用的是包快照；后续修改源码需要重新构建、打包和安装。

4. 正常重启 Harness。先保存工作并处理运行中任务；如果应用提示退出将中断任务，由使用者决定等待或中断。安装授权不自动授权中断其他任务。

5. 打开“插件 → dsh-session-coordinator”，核对版本为 **0.2.8**、插件及组件已启用。发送下面的试用任务，完成条件是实际出现指定独立会话并收到其结果；工具注册或版本号正确不等于任务已跑通。

   > 请新建一个独立主会话，命名“协作试用·核算”，与我当前会话持续协作：第一轮计算 17+26；收到真实结果后，再让同一个会话换一种方法复核；我当前会话核对后交付结论并结束这次协作。只联系这个新会话，不读写文件、不安装依赖。首次审批后允许任务内自动往返。

   首次原生范围审批显示协作目标、成员与预算；确认符合本任务后允许一次。后续轮次在已批准范围内继续。使用者明确拒绝、暂停、取消或预算用尽时，按实际状态停止处理。

## 从旧版升级

**旧克隆迁移提示：** 2026-10-29 公开分支已重新建立为单提交历史。若本地仍是此前克隆，保留原目录，在另一个新目录按“首次安装”重新克隆、构建和安装即可；聊天及工作区无需删除。下面的快进更新步骤仅用于已迁移到新历史的干净克隆。遇到历史分叉时也采用新目录安装，不覆盖本地改动。

1. 在原源码目录执行 `git status --short`。有本地改动时先保留或另选目录克隆；不要用 reset/clean 覆盖使用者文件。
2. 工作树干净时执行：

   ```bash
   git fetch origin
   git switch share/latest-source
   git pull --ff-only origin share/latest-source
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build
   pnpm smoke
   pnpm pack
   dsh plugin --profile desktop add ./dsh-session-coordinator-0.2.8.tgz
   ```

3. 正常重启，按首次安装第 5 步核对版本并实际试用。不需要新建工作区、删除聊天或清空历史。
4. 旧单次消息链仍只有一次回信权，升级不会把旧链或旧审批变成持续授权。要多轮协作，在原发起聊天明确提出持续任务，批准新的范围；后续通过该范围推进。

## 常见问题

| 现象 | 检查与处理 |
|---|---|
| `Unsupported engine` 或构建失败 | 核对 Node 与 pnpm 版本；本版 tsdown 的要求高于插件运行清单中的 Node 最低声明。保留首个错误，修复环境后重新构建。 |
| 安装后仍显示旧版本 | 核对安装的是 `desktop` profile 及最新 tgz，正常退出并重新打开应用；只刷新前端不能证明宿主代码已更新。 |
| 模型说“第三次自动消息被拦” | 查看实际失败工具。旧 `session_coordinator_send` 的单次两跳保护仍生效；持续任务应使用已批准的协作范围。助手的一句归因不能证明宿主全局限制。 |
| 范围批准后再次索取同一授权 | 保留工具名、实际错误及版本反馈；明确拒绝后应等待新的人工请求，不能换入口重试。 |
| 来源名称暂不可用 | 当前原生会话列表缺少标题时会显示该占位；仍保留“查看来源会话”的准确身份，不把长 ID 当名称。 |
| 任务失败、预算用尽或结果待确认 | 查看具体状态与原因；结果待确认时先对账原操作，不能换 ID 盲目重发。 |

## 卸载与反馈

在插件管理中卸载本插件，或执行 `dsh plugin --profile desktop remove dsh-session-coordinator`，然后正常重启。无需删除工作区和聊天。

反馈到 [GitHub Issues](https://github.com/cxydaizihao520/dsh-session-coordinator/issues)，附插件/宿主版本、预期行为、实际工具错误及可复现的脱敏步骤。保留自己的原始日志，仅分享必要片段，避免提交密钥、业务数据和完整私人会话。

本版是源码试用，完整用户旅程仍在补测；公开分支的检查范围见 [README](../README.md)。
