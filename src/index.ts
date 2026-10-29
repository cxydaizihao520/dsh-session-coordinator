/**
 * dsh-session-coordinator host half: 注册会话协调工具
 * (create / send / resume / wait / read / find / status / cancel / monitor_* )，
 * 让当前 agent 能通过提示词创建主会话、向任意会话发消息、等待 / 读取回复、
 * 跨工作区查找会话，以及作为"监控 worker"对主任务会话做后台守护 —
 * 轮询进度、卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、完成即收尾。
 * 监控守护循环是插件自身的组件（见 monitor.ts），非独立插件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BridgeRegistry } from './registry.ts'
import { SessionMonitor } from './monitor.ts'
import { registerBridgeTools, type BridgeEnv } from './tools.ts'
import { Config, createLoopPolicy } from './config.ts'
import { createConfigWriter, registerLoopCommands } from './commands.ts'
import { HOP_RULE_TEXT, COLLABORATION_RULE_TEXT } from './hop.ts'
import { createGrants, registerCoordinateCommand } from './coordinate.ts'

/** 插件配置：思维链循环自动中断的开关与全局默认值（设置页表单与 /cot-loop 共用同一份）。 */
export { Config }

/** Plugin identity for cordis rows. */
export const name = 'dsh-session-coordinator'

/** Services required before mounting. */
export const inject = ['sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'agentPresets', 'tools', 'timer', 'typert', 'storage']

/** `systemPrompt` 服务的结构面：它不是本插件的必需依赖，旧 harness 上不存在。 */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * 先说明会话对象与持续协作，再给仅限旧单次模式的两跳规则；文案与工具描述同源。
 * order 取字面量 2350：紧跟在 DSH 的 session 查询工具段（2300）之后、goal 段（2400）
 * 之前；不调 `getSectionOrder('TOOL_SESSION_QUERY')` 是因为更老的 systemPrompt 版本
 * 未必有这个槽位，拿到 undefined 会让注册抛错——静态序这里只影响位置，不影响渲染。
 */
const HOP_SECTION = { name: 'dsh-session-coordinator:hop-rule', order: 2350, text: COLLABORATION_RULE_TEXT + '\n\n' + HOP_RULE_TEXT }

/** Host plugin body. */
export function apply(ctx: Context, config?: unknown): void {
  const registry = new BridgeRegistry()
  void registry.load().catch((error: unknown) => {
    console.warn('[dsh-session-coordinator] registry load failed:', error instanceof Error ? error.message : String(error))
  })
  // 循环策略：总开关与全局默认值都从 Config 的 volatile 引用实时读取，
  // 所以设置页/命令改开关后，运行中的守护下一个 tick 就按新值走（无需重启或重载）。
  const policy = createLoopPolicy(config)
  // 后台监控按来源与目标复核授权。
  const grants = createGrants()
  const monitor = new SessionMonitor(ctx, registry, undefined, policy,
    value => value.coordinatorId !== undefined && grants.isGranted(value.coordinatorId, value.sessionId))
  // 目标级授权表；修改目标或 off 时撤销旧回信权与监控。
  // 内存态、进程退出即失效——不给长期通行证。只读工具不受它约束。
  const env: BridgeEnv = { ctx, registry, monitor, policy, grants }
  registerBridgeTools(env)
  registerCoordinateCommand(ctx, grants,
    (callerId, raw) => env.delivery!.fromCommand(callerId, raw),
    (callerId) => {
      env.delivery!.revoke(callerId)
      for (const entry of monitor.list()) if (entry.config.coordinatorId === callerId) monitor.stop(entry.config.sessionId)
    })
  // 斜杠命令 /cot-loop：与设置页共用同一份配置；commands 服务缺失时静默跳过。
  registerLoopCommands(ctx, { policy, writeConfig: createConfigWriter(ctx) })
  // 防环规则写进系统提示段（#6）。systemPrompt 是可选服务：旧 harness 上不存在，
  // 用动态 inject 而不是静态 inject 清单，缺失时只是这段不生效，插件照常激活。
  ctx.inject(['systemPrompt'], (scope) => {
    const prompt = scope as unknown as { systemPrompt: SystemPromptLike }
    prompt.systemPrompt.section(HOP_SECTION)
  })
  ctx.effect(() => () => monitor.dispose())
}
