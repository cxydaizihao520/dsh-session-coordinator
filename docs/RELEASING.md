# 发布与插件收录流程

适用于本项目的版本准备、源码更新、可选 npm 分发及 awesome-dsh-plugin 收录。每次执行以[最新贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)为准。本手册不触发发布，也不代替当前任务的授权范围。

## 材料放在哪里

| 内容 | 位置与用途 |
| --- | --- |
| 使用者入口 | README.md、docs/INSTALL.md、docs/USAGE.md |
| 验收范围 | docs/ACCEPTANCE.md；记录版本、宿主、实际结果和未覆盖项 |
| 唯一投稿文件 | docs/submission/data/plugins/cxydaizihao520__dsh-session-coordinator.yml；将来复制到上游同名路径 |
| 投稿说明 | docs/submission/PR.md；只有正文，提交时标题使用 Add cxydaizihao520/dsh-session-coordinator |
| 当前材料状态 | docs/submission/STATUS.md；公开事实摘要，不收录私人原始证据 |

原始会话、模型配置、账号检查输出、缓存和本机操作日志留在仓库外。不要把工作目录整体复制进投稿目录。

## 1. 固定版本与公开源码

1. 先确认工作树、远端 main 和实际 package.json 版本；有其他任务改动时另取干净检出。保留他人修改和已有历史。
2. 固定待验收提交。package.json、dsh.plugin.json 与说明中的版本保持一致，来源以实际 Git 提交为准；后续开发改动不自动继承旧版本验收结论。
3. 清单须有 dsh.bundle.patch，引用文件存在，patch 中挂载的包名与 name 一致。仅 dsh.client 不足以安装。
4. 核对宿主服务依赖的 peer 声明及实际宿主版本。沿用本项目 DSH 下限策略；本项目最低声明与已测版本分别记录，不把下限写成所有新版均已实测。
5. 源码推送、npm 发布、Release 和上游 PR 分别按当前任务已有授权执行；没有授权的步骤保留待执行。不要因“准备材料”自动发布。

## 2. 构建与验收

在完整源码检出中，复用已有命令：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm pack
```

开发工具版本要求见 INSTALL。安装依赖前检查 prepare；本项目源码 prepare 复用 pnpm build，包含类型生成。预构建包还需检查宿主 JS、类型入口、客户端和动态分块是否实际入包。每次对外分发记录固定成品的版本、文件清单和哈希。

- 依赖或程序有变更时，重新执行受影响测试和必要回归；仅改文档或投稿 YAML 时，检查链接、内容及格式，不机械重跑模型业务。
- 用官方安装器把固定 tgz 或精确 Git 提交安装到隔离 profile；确认实际版本和入口，启动并检查工具注册。
- Git prepare 需要审批时，只允许安装器打印的包名、下载地址与完整提交对应的键。GitHub 可能解析成 codeload 地址；不要凭原 git URL 推测授权键，也不要全局放行脚本。
- 真实业务至少覆盖正常协作、拒绝审批和终态停止；升级或恢复行为有变更时另查历史保留、重复派工及恢复边界。原始日志留本机，公开摘要只记必要结果。
- 安装成功、工具注册、模型任务完成是三层证据。写明 SKIP 和未测项目，不能相互替代；已有版本证据可复用，但要核对程序字节和环境变化。
- 源码公开后，从实际 GitHub 精确提交复验安装；本地镜像通过不等于公开下载通过。

## 3. 选择分发方式

| 阶段 | 处理方式 |
| --- | --- |
| 开发与内部试用 | 提供 main 或固定 Git 提交的源码安装，准确说明构建审批 |
| 需要便捷外部试用 | 可准备 npm 预览版本和 beta 标签，明确使用范围 |
| 稳定版本 | 完成相应验收后再准备 latest |

npm、独立图标和截图都不是收录前置条件。没有 npm 时，只要公开源码确实可安装即可；源码完全不能安装时，按指南提供 GitHub Release 的预构建 tarball。

npm 使用已审查的固定 tgz；先核对清单、生命周期脚本和文件，再使用官方 CLI 的 `npm publish <固定tgz> --dry-run --ignore-scripts --registry=https://registry.npmjs.org/` 模拟。dry-run 不证明服务端最终接受包名或发布权限。

正式发布仍需现有任务明确授权，并由账号持有人完成必要的交互验证。每次内容更新使用新版本号；已发布同名同版本不能覆盖。发布后读回版本、标签、dist.integrity，再从 registry 按包名执行隔离安装。GitHub 更新与 npm 更新是独立动作。

若选择 Release tarball，只有实际可下载后才填 tarball 字段。使用 latest/download 时文件名不带版本；带版本文件名须固定 Release tag。不要填写未来地址。

## 4. 准备唯一上游 YAML

- 文件名与仓库路径相符：data/plugins/<owner>__<repo>.yml；本项目使用材料目录内的同名文件。
- url 指向本项目公开仓库，name 与仓库一致；category 按实际能力选择，本项目为 session。
- description.en 为必填单行，zh 可选；都只描述实际能力，句尾加句号。包含冒号和空格的描述加引号。
- 先查上游是否已有本仓库条目和相关插件。已经收录时只更新自己的条目；功能重复由维护者评审，格式通过不代表收录保证。
- 上游仓库只提交这个 YAML。不要手改生成的 README，不修改其他插件条目，不增加 npm 字段；npm 映射依靠发布包的 repository 字段，必须回指该仓库。
- 图标可省略。截图可选；使用时在本项目 package.json 旁声明 screenshots.json，1–8 张已存于仓库的图片，路径不得越界；外部 URL 仅允许指南列出的 GitHub https 托管。不要新增上游旧 data/screenshots.json 条目。

### 复用上游校验器

在独立上游检出中执行；先将 PLUGIN_SOURCE 设置为本项目完整检出的路径，不填写到公开材料中：

```bash
npm ci --ignore-scripts
cp "$PLUGIN_SOURCE/docs/submission/data/plugins/cxydaizihao520__dsh-session-coordinator.yml" data/plugins/
node --input-type=module - <<'JS'
import assert from 'node:assert/strict'
import { readEntries, validateEntries } from './scripts/lib/entries.mjs'
const problems = validateEntries(readEntries())
assert.deepEqual(problems, [])
console.log('Entry validation passed')
JS
git diff --check
git status --short
```

确认差异只涉及本项目单个 YAML。上游的格式、manifest、仓库年龄、站点构建和维护者功能审查是不同环节；本地 YAML 通过不能标记为上游 CI 已通过。

## 5. 提交前的隐私核对

- 对外只保留规范必需的公开仓库定位、插件功能、安装步骤和脱敏验收范围。
- 不附 npm 登录名、邮箱、真实姓名、账号权限／2FA 输出、密码、token、恢复码、设备标识、内部路由、模型凭据、本机路径或私人会话 ID。公开仓库标识用于定位代码，不能用真实姓名或邮箱补充作者介绍。
- 不附原始会话／操作日志；日志及截图即使来自测试，也先人工检查账号、侧边栏标题、目录、业务内容和可关联标识。没有干净证据时省略可选附件。
- 投稿目录使用明确的文件清单。检查实际待提交 diff 和 Git 作者邮箱；需要隐藏个人邮箱时使用经本人确认的 GitHub noreply 地址，不改全局配置或猜测地址。
- 有限模式扫描只能辅助人工核对，不能宣称完整安全审计或保证零泄露。

## 6. 提交与后续维护

取得上游 PR 提交授权后，只提交上述单 YAML，并使用已复核的 PR 正文。合并仅增加发现入口，不代表安全认证或所有场景通过。

收到 held: author 时，按维护者指明的问题更新同一分支，获评论授权后留一条说明；不要用空提交或重复催促触发评审。生成 README 过期、无 merge ref 等上游问题先按最新指南定位，不擅自改其他条目或重写上游历史。

每次对外发版重查本手册依赖的指南、实际公开提交、可下载地址及声明。资料快照和检查日期用于追溯，不自动延续为下次发布通过。
