import { exportDiagnostics, exportRelatedDiagnostics } from './diagnostics.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 命令名（注册到 `ctx.commands`）。 */
export const COORDINATE_COMMAND = 'coordinate'

/** 受闸门约束的动作：都是"会改变别人会话状态"的。 */
export const GATED_ACTIONS = ['send', 'create', 'resume', 'cancel', 'monitor_start', 'monitor_stop', 'archive', 'unarchive'] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]

/** 仅在当前进程有效的 (来源, 目标) 授权。 */
export interface CoordinationGrants {
  grant(sessionId: string, targets: readonly string[]): void
  revoke(sessionId: string): void
  isGranted(sessionId: string, targetId?: string): boolean
  list(sessionId: string): string[]
}

export function createGrants(): CoordinationGrants {
  const granted = new Map<string, Set<string>>()
  return {
    grant(sessionId, targets) {
      if (sessionId === '' || targets.length === 0 || targets.some(id => id === '' || id === '*' || id === sessionId)) {
        throw new Error('必须指定其它会话的完整 id，不支持通配符')
      }
      granted.set(sessionId, new Set(targets))
    },
    revoke(sessionId) { granted.delete(sessionId) },
    isGranted(sessionId, targetId) { return targetId !== undefined && granted.get(sessionId)?.has(targetId) === true },
    list(sessionId) { return [...(granted.get(sessionId) ?? [])] },
  }
}

export function denialMessage(sessionId: string, action: GatedAction, targetId?: string): string {
  return 'session ' + JSON.stringify(sessionId) + ' is not authorized to coordinate other sessions: ' + action +
    ' refused for ' + JSON.stringify(targetId ?? '(new session)') +
    '. This is the legacy single-exchange entry. For a human-requested ongoing collaboration, the originating chat must use collaboration_start and its native scope approval, not /coordinate on. For an explicitly single exchange, ask the human to run /coordinate on <target-session-id ...>. Only the specified targets are allowed; ' +
    'a verified incoming task permits one reply to its sender without another grant. Read-only tools are never gated. ' +
    (action === 'create' ? 'Create sessions in the UI first, then authorize their ids.' : '')
}

export function requireCoordination(grants: CoordinationGrants, sessionId: string, action: GatedAction, targetId?: string): void {
  if (grants.isGranted(sessionId, targetId)) return
  throw new Error(denialMessage(sessionId, action, targetId))
}

/** 命令返回值（dsh-commands 的契约）。 */
export interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

/** Bare `on` never grants blanket access. Target ids retain their case. */
export function parseCoordinateInput(rawInput: string | undefined): { verb: 'on' | 'off' | 'status'; targets: string[] } | undefined {
  const [word = 'status', ...targets] = (rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const verb = word.toLowerCase()
  if (verb === 'on' && targets.length > 0 && targets.every(id => id !== '*')) return { verb, targets }
  if ((verb === 'off' || verb === 'status') && targets.length === 0) return { verb, targets }
  return undefined
}

export function runCoordinateCommand(grants: CoordinationGrants, sessionId: string, rawInput: string | undefined): CommandResult {
  const input = parseCoordinateInput(rawInput)
  if (input === undefined) return { kind: 'error', text: '用法：/coordinate on <目标会话id ...> | off | status；on 必须指定目标，不能用 *' }
  if (sessionId === '') return { kind: 'error', text: '拿不到当前会话 id，无法授权' }
  if (input.verb === 'on') {
    try { grants.grant(sessionId, input.targets) } catch (error) { return { kind: 'error', text: String(error) } }
  }
  if (input.verb === 'off') grants.revoke(sessionId)
  const targets = grants.list(sessionId)
  return { kind: 'success', text: targets.length === 0
    ? '本会话未授权任何目标。只读查询仍可用；/coordinate on <目标会话id ...> 指定目标。'
    : '单次模式：已授权本会话仅协调：' + targets.join(', ') + '。每次单次任务的接收方可向发送者回信一次，无需单独授权；这不是持续协作的轮数限制。多轮协作请在原发起会话提出持续任务，由 collaboration_start 审批范围后自动推进。本单次授权重启失效；/coordinate off 收回。' }
}

interface CommandsLike {
  register(command: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (payload: { rawInput?: string; agent?: { id?: string } }) => CommandResult | Promise<CommandResult>
  }): unknown
}

/**
 * 注册 `/coordinate` 命令。`commands` 服务是**可选**的：旧 harness 上没有它时静默跳过
 * （插件照常工作，只是没法用命令授权——那时闸门恒为"未授权"，只读工具仍可用）。
 * @param ctx - 插件根上下文
 * @param grants - 授权表
 */
export function registerCoordinateCommand(
  ctx: Context, grants: CoordinationGrants,
  send?: (callerId: string, rawInput: string) => Promise<CommandResult>,
  revoke?: (callerId: string) => void,
): void {
  const candidate = ctx as unknown as { inject?: (names: string[], cb: (child: unknown) => void) => unknown }
  if (typeof candidate.inject !== 'function') return
  try {
    candidate.inject(['commands'], (child) => {
      const commands = (child as { commands?: CommandsLike }).commands
      if (commands === undefined || typeof commands.register !== 'function') return
      commands.register({
        name: COORDINATE_COMMAND,
        description: '指定可协调的会话：/coordinate on <目标id ...>；off 收回，status 查询；logs [对方id ...] 导出不含正文的排障日志。',
        input: { hint: 'on <目标会话id ...> | off | status | logs [对方id ...]' },
        handler: (payload) => {
          const callerId = payload.agent?.id ?? ''
          const raw = (payload.rawInput ?? '').trim()
          if (raw === 'logs-related') return exportRelatedDiagnostics(ctx, callerId).then(value => ({ kind: 'success' as const, text: JSON.stringify(value) }), () => ({ kind: 'error' as const, text: '无法导出协作日志，请稍后重试。' }))
          if (raw === 'logs' || raw.startsWith('logs ')) return exportDiagnostics(ctx, callerId, raw.split(/\s+/).slice(1)).then(value => ({ kind: 'success' as const, text: JSON.stringify(value, null, 2) }), () => ({ kind: 'error' as const, text: '无法导出协作日志；请核对当前会话和明确的对方会话ID。' }))
          if (raw.startsWith('send ') && send !== undefined) return send(callerId, raw.slice(5))
          const result = runCoordinateCommand(grants, callerId, raw)
          if (result.kind === 'success' && parseCoordinateInput(raw)?.verb !== 'status') revoke?.(callerId)
          return result
        },
      })
    })
  } catch {
    // 注入失败不该影响插件其余部分。
  }
}
