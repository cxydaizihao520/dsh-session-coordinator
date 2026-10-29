# dsh-session-coordinator

DeepSeek Harness 会话协调插件，当前试用版 **0.2.2**。支持独立主会话、总控与多个会话持续协作、一次范围审批覆盖多轮往返，以及忙时在当前轮后续步骤承接回信。

公开试用分支：`share/latest-source`。运行源码与本次本地验收产物一致；不含私人会话日志。尚未上架插件市场，完整产品验收仍在进行。

总控协作、指定发送、群体同步、忙时回信等九类需求及完整示例见[使用手册](./docs/USAGE.md)。

## 安装

首次安装、旧版升级、命令缺失及安装后验证见 [安装手册](./docs/INSTALL.md)。可直接把下面这句话交给 DeepSeek Harness：

> 请按 https://github.com/cxydaizihao520/dsh-session-coordinator/blob/share/latest-source/docs/INSTALL.md 安装或升级 share/latest-source 分支的 dsh-session-coordinator 到 desktop profile，完成构建、打包和版本核验；重启前确认运行中的任务，安装后用手册里的独立会话往返例子验证。

```bash
git clone --branch share/latest-source https://github.com/cxydaizihao520/dsh-session-coordinator.git
cd dsh-session-coordinator
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
pnpm pack
dsh plugin --profile desktop add ./dsh-session-coordinator-0.2.2.tgz
```

需要已安装 DeepSeek Harness（实测 0.2.1-rc.3，最低声明 0.2.1-rc.1）、Node.js 22.18+ 或 24.11+，以及 pnpm。构建工具的 Node 要求高于插件运行清单的最低声明。完成后正常重启 Harness，在插件管理中确认 dsh-session-coordinator 0.2.2 已启用。重启前先处理正在运行的任务。

## 已验证与边界

- 真实 Harness：同一任务十次顺序请求和回信完成，最终结果正确；另有桌面十轮往返完成，仅一次范围审批、中途无人工解锁或第三跳拦截。模型出现过参数填写错误并自行纠正，不能承诺零错误。
- 收信卡来源使用原生会话名，保留复制与查看来源；移除返回总控及诊断详情。真实桌面已核对。
- 忙时持续协作：原生实测 B 回信发生于 A 工具执行期间，A 同轮下一步实际读取并合并结果；桌面另以 20 万笔销售批处理核验，B 在约第 11.8 秒回信，A 正常执行完约 60 秒命令后同轮承接，再交回 B 复核并完成。收尾出现过一次缺少结果 ID 的参数错误后自行纠正，未要求人工逐轮解锁。
- 完整附件语义、工作树隔离及全部 Codex 用户旅程未逐项完成验收，不宣称完全等价。

## 开发验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

公开分支包含无需私人日志的单元回归和产物冒烟。依赖私人历史回放的客户端套件及实际模型运行脚本留在开发工作区，未包含在此分支；公开 `pnpm test` 不代替完整桌面验收。
