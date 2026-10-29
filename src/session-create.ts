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
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
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
  const presets = ctx.agentPresets as unknown as { composedPreset(agentCtx: Context): string | undefined; composeFrom(agentCtx: Context, parentCtx: Context): string | undefined; mount(agentCtx: Context, id: string): Promise<unknown> }
  const persistedPreset = requestedPreset ?? (caller ? presets.composedPreset(caller.ctx) : undefined)
  options.signal?.throwIfAborted()
  const handle = await agents.create({
    sessionId,
    meta: {
      cwd: targetCwd,
      ...(persistedPreset === undefined ? {} : { agentPreset: persistedPreset }),
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
        await presets.mount(agentCtx, requestedPreset)
      } else if (caller !== undefined) {
        if (presets.composeFrom(agentCtx, caller.ctx) !== persistedPreset) throw new Error('caller preset changed before session composition; retry creation after inspection')
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

/** Native headless only registers a live lookup; compose cold targets through the same public setup APIs. */
async function resumeComposedSession(ctx: Context, args: ResumeArgs): Promise<LiveAgentLike> {
  const query = ctx.get?.('sessionQuery') as { observeSession(id: string): Promise<{
    header: { id: string; cwd?: string; origin?: string; agentPreset?: string }
    events: readonly SessionEvent[]
    projections?: { values: { agentPreset?: string | null; modelSelection?: { lastUsed: ModelSelectionRef['current'] | null; next: ModelSelectionRef['current'] | null } } }
    [Symbol.dispose](): void
  }> } | undefined
  if (!query) throw new Error('cold session composition requires native sessionQuery support')
  const observation = await query.observeSession(args.sessionId)
  try {
    if (observation.header.id !== args.sessionId || !observation.header.cwd) throw new Error('cold session has no exact persisted working directory')
    if (observation.header.origin === 'subagent') throw new Error('cold subagent session must use native subagent routing')
    const values = observation.projections?.values
    if (values?.agentPreset === undefined && (observation.header.agentPreset || observation.events.some(event => event.type === 'agent-preset/selected'))) throw new Error('cold session requires its native agentPreset projection')
    if (!values?.modelSelection && observation.events.some(event => (event.type as string) === 'model/selection')) throw new Error('cold model selection requires its native modelSelection projection')
    const logged = observation.events.filter(event => event.type === 'request/header').at(-1)?.data.header
    const defaults = ctx.get?.('agentDefaultModel') as { currentSelection(): ModelSelectionRef['current'] } | undefined
    const fromHeader = (header: typeof logged) => header ? {
      provider: header.config.provider, model: header.config.model,
      ...(header.config.reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: header.config.reasoningEffort }),
    } : defaults?.currentSelection()
    const prior = fromHeader(logged)
    const select = (prior: ModelSelectionRef['current']) => {
      const routeChanged = args.provider !== undefined && args.provider !== prior?.provider || args.model !== undefined && args.model !== prior?.model
      const selected = { ...prior, ...(routeChanged ? { reasoningEffort: undefined } : {}),
        ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}),
        ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}) }
      if (!selected.provider || !selected.model) throw new Error('cold session has no native model selection to restore')
      return selected
    }
    const presets = ctx.get?.('agentPresets') as { resolve(id: string): Promise<{ id: string }>; mount(agentCtx: Context, id: string): Promise<unknown> } | undefined
    const presetId = values?.agentPreset ?? undefined
    if (presetId && !presets) throw new Error('cold session preset composition is unavailable')
    const preset = presetId ? await presets!.resolve(presetId) : undefined
    const install = (agentApi as unknown as { installModelSelection?: (agentCtx: Context, selection: ModelSelectionRef) => () => void }).installModelSelection
    if (!install) throw new Error('cold session requires native installModelSelection support')
    const agents = ctx.agents as unknown as { resume(options: { resumeSessionId: string; agentOptions: Record<string, unknown>; setup(agentCtx: Context, agent: LiveAgentLike): Promise<void> }): Promise<{ agent: LiveAgentLike }> }
    const projection = ctx.get?.('sessionProjections') as { stateOf(session: LiveAgentLike['session'], key: string): { pending: ModelSelectionRef['current'] | null } | undefined } | undefined
    const handle = await agents.resume({ resumeSessionId: args.sessionId, agentOptions: select(prior ?? values?.modelSelection?.next ?? undefined),
      setup: async (agentCtx, agent) => {
        // Observation values are wire views {lastUsed,next}; native stateOf retains exact pending intent.
        const state = values?.modelSelection ? projection?.stateOf(agent.session, 'modelSelection') : undefined
        if (values?.modelSelection && !state) throw new Error('cold model selection requires its native modelSelection state')
        if (!state && sessionEvents(agent.session).some(event => (event.type as string) === 'model/selection')) throw new Error('cold model selection requires its native modelSelection state')
        const selected = select(state?.pending ?? fromHeader(agent.session.requestHeader()))
        await validateBridgeSessionModel(ctx, selected)
        install(agentCtx, { current: selected })
        if (preset) await presets!.mount(agentCtx, preset.id)
      },
    })
    return handle.agent
  } finally { observation[Symbol.dispose]() }
}

async function resumeBridgeSessionOnce(ctx: Context, registry: BridgeRegistry, args: ResumeArgs): Promise<Record<string, unknown>> {
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
  const agentOptions: Record<string, unknown> = {}
  if (typeof args.provider === 'string' && args.provider !== '') agentOptions.provider = args.provider
  if (typeof args.model === 'string' && args.model !== '') agentOptions.model = args.model
  if (typeof args.reasoningEffort === 'string' && args.reasoningEffort !== '') agentOptions.reasoningEffort = args.reasoningEffort
  // 桌面解析器同时恢复模型选择与预设；裸 agents.resume 缺少 prompt 装配。
  const typert = (ctx as unknown as { typert?: { lookups: { get(key: string): { resolve(id: string): Promise<LiveAgentLike | undefined> } | undefined } } }).typert
  const resolver = typert?.lookups.get('agent')
  // Native desktop policy errors are authoritative; fallback only when no cold resolver handles this identity.
  const resolved = resolver !== undefined && Object.keys(agentOptions).length === 0 ? await resolver.resolve(args.sessionId) : undefined
  const agent = resolved ?? await resumeComposedSession(ctx, args)
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
    title: titleOf(sessionEvents(agent.session)) ?? null,
  }
}

// Native controller deduplicates cold resumes; headless needs the same boundary before opening a writer.
const coldResumes = new WeakMap<Context, Map<string, { fingerprint: string; promise: Promise<Record<string, unknown>> }>>()
export async function resumeBridgeSession(ctx: Context, registry: BridgeRegistry, args: ResumeArgs): Promise<Record<string, unknown>> {
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
  if (getLiveAgent(ctx, args.sessionId)) return resumeBridgeSessionOnce(ctx, registry, args)
  const pending = coldResumes.get(ctx) ?? new Map()
  const fingerprint = JSON.stringify([args.provider, args.model, args.reasoningEffort])
  const existing = pending.get(args.sessionId)
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error('cold session resume already pending with another model selection')
    return existing.promise
  }
  const promise = resumeBridgeSessionOnce(ctx, registry, args).finally(() => { pending.delete(args.sessionId) })
  pending.set(args.sessionId, { fingerprint, promise }); coldResumes.set(ctx, pending)
  return promise
}
