/**
 * 会话创建：`session_coordinator_create` 工具与守护循环的「循环转移」共用同一条路径。
 *
 * 抽出这一层的理由：转移必须"先建好新会话、确认成功，再取消原会话"，否则创建失败
 * 就会丢任务；两处各写一份创建逻辑迟早漂移（模型继承、预设组合、workspace 记账、
 * 桥侧登记、followup 锚点，任何一处漏掉都会让新会话行为不同）。所以只保留一份实现，
 * tools 与 monitor 都调它。
 *
 * 这是**唯一**需要 `@deepseek-ai/dsh-agent` 运行时值（`installModelSelection`）的模块，
 * 单独成文件是为了让纯逻辑测试（core/loop-guard/handoff）不必加载宿主包。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as agentApi from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import {
  attachSessionToWorkspace,
  getLiveAgent,
  titleOf,
  maxSeq,
  resolveTargetCwd,
  sessionEvents,
  userMessage,
  workspaceByPath,
  type LiveAgentLike,
  type TargetCwdArgs,
} from './core.ts'
import type { BridgeRegistry } from './registry.ts'

interface ModelSelectionRef {
  current: { provider?: string; model?: string; reasoningEffort?: string } | undefined
  assembled?: undefined
}

/** 创建会话时的调用方：模型路由从它的 session 请求头继承，预设从它的 ctx 组合。 */
export interface BridgeSessionCaller {
  ctx: Context
  session: {
    header: { cwd?: string }
    requestHeader?: () => { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
  }
}

/** 创建参数：workspaceId/cwd 目标解析 + 可选标题/首条提示/模型覆盖。 */
export interface CreateBridgeSessionOptions extends TargetCwdArgs {
  /** 调用方（工具调用时的当前 agent）；缺省则不做预设组合与模型继承。 */
  caller?: BridgeSessionCaller
  /** 调用方 cwd（优先于 caller.session.header.cwd，供工具显式传入）。 */
  callerCwd?: string
  title?: string
  prompt?: string
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  /** Internal cancellation for capability validation before creating the session. */
  signal?: AbortSignal
  /** 会话 id 前缀（默认 `sb-`）。 */
  sessionId?: string
  idPrefix?: string
}

export interface CreatedBridgeSession {
  sessionId: string
  cwd: string
  workspaceId?: string
  agent: LiveAgentLike
  /** 发送 prompt 之前的日志锚点；未发送 prompt 时为 undefined。 */
  baselineSeq?: number
}

/** Reuse the host's exact-model validation without dispatching a request or adopting defaults. */
export async function validateBridgeSessionModel(ctx: Context, selection: { provider?: string; model?: string; reasoningEffort?: string }, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!selection.provider && !selection.model && selection.reasoningEffort === undefined) return
  if (!selection.provider || !selection.model) throw new Error('cannot validate model selection without an exact provider and model')
  const llm = ctx.get?.('llm') as { resolveCallConfig(config: { provider: string; model: string; reasoningEffort?: string }, signal?: AbortSignal): Promise<unknown> } | undefined
  if (typeof llm?.resolveCallConfig !== 'function') throw new Error('native model capability validation is unavailable; cannot accept this model selection')
  await llm.resolveCallConfig({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }, signal)
  signal?.throwIfAborted()
}

/**
 * 创建一个真实的顶层 DSH 会话（agent + session + workspace 记账 + 桥侧登记），
 * 可选立即投递首条提示。返回的 agent 已是 live agent。
 */
export async function createBridgeSession(
  ctx: Context,
  registry: BridgeRegistry,
  options: CreateBridgeSessionOptions,
): Promise<CreatedBridgeSession> {
  const caller = options.caller
  const targetCwd = await resolveTargetCwd(ctx, options.callerCwd ?? caller?.session.header.cwd, options)
  const callerHeader = caller?.session.requestHeader?.()
  const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : callerHeader?.config?.provider ?? ''
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : callerHeader?.config?.model ?? ''
  const reasoningEffort = typeof options.reasoningEffort === 'string' && options.reasoningEffort !== ''
    ? options.reasoningEffort
    : callerHeader?.config?.reasoningEffort
  await validateBridgeSessionModel(ctx, { provider, model, reasoningEffort }, options.signal)

  const selection: ModelSelectionRef = {
    current: {
      ...(provider !== '' ? { provider } : {}),
      ...(model !== '' ? { model } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  }
  const installModelSelection = (agentApi as unknown as { installModelSelection?: (agentCtx: Context, selection: ModelSelectionRef) => () => void }).installModelSelection

  const sessionId = options.sessionId ?? `${options.idPrefix ?? 'sb-'}${randomUUID()}`
  const agents = ctx.agents as unknown as {
    create(options: {
      sessionId: string
      meta?: { cwd?: string; agentPreset?: string }
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: Context) => void | Promise<void>
    }): Promise<{ agent: LiveAgentLike }>
  }
  const requestedPreset = typeof options.agentPreset === 'string' && options.agentPreset.trim() !== '' ? options.agentPreset.trim() : undefined
  options.signal?.throwIfAborted()
  const handle = await agents.create({
    sessionId,
    meta: {
      cwd: targetCwd,
      ...(requestedPreset === undefined ? {} : { agentPreset: requestedPreset }),
    },
    agentOptions: {
      ...(provider !== '' ? { provider } : {}),
      ...(model !== '' ? { model } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    setup: async (agentCtx: Context) => {
      if (requestedPreset !== undefined) {
        // 显式 agentPreset 就组合那一个预设。落到下面的 caller-join 会静默忽略请求：
        // id 仍然写进 session header，而 agent 实际跑在调用方的既有组合与工具上。
        const presets = ctx.agentPresets as unknown as { mount(agentCtx: Context, id: string): Promise<unknown> }
        await presets.mount(agentCtx, requestedPreset)
      } else if (caller !== undefined) {
        const presets = ctx.agentPresets as unknown as { composeFrom(agentCtx: Context, parentCtx: Context): string | undefined }
        presets.composeFrom(agentCtx, caller.ctx)
      }
      if (installModelSelection !== undefined) {
        installModelSelection(agentCtx, selection)
        return
      }
      // 兜底：只重写请求配置（模型选择拆分可接受）。
      const hookable = agentCtx as unknown as { on(name: string, listener: (...args: unknown[]) => unknown): unknown }
      hookable.on('agent/request', async (payload: unknown, next: unknown) => {
        const nxt = next as () => Promise<Record<string, unknown>>
        const resolved = await nxt()
        const sel = selection.current
        if (sel === undefined) return resolved
        const { reasoningEffort: _drop, ...rest } = resolved
        return {
          ...rest,
          ...(sel.provider === undefined ? {} : { provider: sel.provider }),
          ...(sel.model === undefined ? {} : { model: sel.model }),
          ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
        }
      })
    },
  })

  const agent = handle.agent
  // 镜像 session-controller.create 的记账：把新会话计入其 cwd 所属的
  // workspace，否则会话出现在 UI "未分组"（workspace sessionIds 只经
  // attach/bootstrap 两条路径记账）。
  const workspaceId = await attachSessionToWorkspace(ctx, sessionId as SessionId, targetCwd) ?? workspaceByPath(ctx, targetCwd)
  registry.record({
    sessionId,
    ...(typeof options.title === 'string' && options.title.trim() !== '' ? { title: options.title.trim() } : {}),
    cwd: targetCwd,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(provider !== '' ? { provider } : {}),
    ...(model !== '' ? { model } : {}),
    source: 'create',
  })

  const title = options.title?.trim()
  if (title) {
    const titles = ctx.get?.('sessionTitle') as { rename(session: LiveAgentLike['session'], title: string): unknown } | undefined
    titles?.rename(agent.session, title)
  }

  // 发送 prompt 之前的日志锚点：交还调用方，供之后精确 wait 取回首条回复。
  // 新建会话的 maxSeq 为 -1（尚无事件），所以"未发送"用 undefined 哨兵而不是数值比较。
  let baselineSeq: number | undefined
  if (typeof options.prompt === 'string' && options.prompt.trim() !== '') {
    baselineSeq = maxSeq(sessionEvents(agent.session))
    agent.followup(userMessage(options.prompt.trim()))
    registry.touch(sessionId)
  }

  return {
    sessionId,
    cwd: targetCwd,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    agent,
    ...(baselineSeq === undefined ? {} : { baselineSeq }),
  }
}

export interface ResumeArgs { sessionId: string; provider?: string; model?: string; reasoningEffort?: string }

export async function resumeBridgeSession(ctx: Context, registry: BridgeRegistry, args: ResumeArgs): Promise<Record<string, unknown>> {
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
  const existing = getLiveAgent(ctx, args.sessionId)
  if (existing !== undefined) {
    registry.touch(args.sessionId)
    return {
      sessionId: args.sessionId,
      alreadyLive: true,
      ...(existing.session.header.cwd === undefined ? {} : { cwd: existing.session.header.cwd }),
      title: titleOf(sessionEvents(existing.session)) ?? null,
      running: existing.status === 'running',
    }
  }
  let headers: readonly { id: string; cwd?: string; createdAt: number }[] = []
  try {
    // dsh >= 0.1.5-alpha.1：list() 返回 { header, ... } 快照；映射回平铺字段。
    const persistence = ctx.sessionPersistence as unknown as { list(): Promise<readonly { header: { id: string; cwd?: string; createdAt: number } }[]> }
    headers = (await persistence.list()).map((rec) => ({
      id: rec.header.id,
      ...(rec.header.cwd === undefined ? {} : { cwd: rec.header.cwd }),
      createdAt: rec.header.createdAt,
    }))
  } catch (error) {
    throw new Error('session persistence unavailable: ' + (error instanceof Error ? error.message : String(error)))
  }
  const header = headers.find((h) => h.id === args.sessionId)
  if (header === undefined) {
    throw new Error('session ' + JSON.stringify(args.sessionId) + ' is unknown (no live agent and no persisted log) — use session_coordinator_find to locate existing sessions')
  }
  const agents = ctx.agents as unknown as {
    resume(options: { resumeSessionId: string; agentOptions?: Record<string, unknown> }): Promise<{ agent: LiveAgentLike }>
  }
  const agentOptions: Record<string, unknown> = {}
  if (typeof args.provider === 'string' && args.provider !== '') agentOptions.provider = args.provider
  if (typeof args.model === 'string' && args.model !== '') agentOptions.model = args.model
  if (typeof args.reasoningEffort === 'string' && args.reasoningEffort !== '') agentOptions.reasoningEffort = args.reasoningEffort
  // 桌面解析器同时恢复模型选择与预设；裸 agents.resume 缺少 prompt 装配。
  const typert = (ctx as unknown as { typert?: { lookups: { get(key: string): { resolve(id: string): Promise<LiveAgentLike> } | undefined } } }).typert
  const resolver = typert?.lookups.get('agent')
  const handle = resolver !== undefined && Object.keys(agentOptions).length === 0
    ? { agent: await resolver.resolve(args.sessionId) }
    : await agents.resume({ resumeSessionId: args.sessionId, ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}) })
  const headerCwd = header.cwd
  const resumeWorkspaceId = await attachSessionToWorkspace(ctx, args.sessionId as SessionId, headerCwd) ?? workspaceByPath(ctx, headerCwd)
  registry.record({
    sessionId: args.sessionId,
    ...(headerCwd === undefined ? {} : { cwd: headerCwd }),
    ...(resumeWorkspaceId === undefined ? {} : { workspaceId: resumeWorkspaceId }),
    source: 'resume',
  })
  return {
    sessionId: args.sessionId,
    resumed: true,
    ...(headerCwd === undefined ? {} : { cwd: headerCwd }),
    title: titleOf(sessionEvents(handle.agent.session)) ?? null,
  }
}
