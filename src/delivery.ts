import { recordDiagnostic, diagnosticCall } from './diagnostics.ts'
/** 工具和人工面板共用的发送路径；回信权只来自本进程实际投递过的消息。 */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { getLiveAgent, maxSeq, sessionEvents, sourceIdentityMessage, titleOf, type LiveAgentLike } from './core.ts'
import { requireCoordination, type CoordinationGrants, type CommandResult } from './coordinate.ts'
import { recordDelivery, reconcileReply } from './coordination-records.ts'
import { nextHop, type HopDecision } from './hop.ts'
import { resumeBridgeSession } from './session-create.ts'
import type { BridgeRegistry } from './registry.ts'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'

const rejectedInputs = new WeakMap<LiveAgentLike['session'], Set<string>>()

function humanApprovalInput(session: LiveAgentLike['session']): { seq: number; key: string } {
  const event = [...sessionEvents(session)].reverse().find(event => event.type === 'user/message' &&
    (event.data.source as { kind?: string } | undefined)?.kind === 'user' && session.isOwnSeq?.(event.seq) !== false)
  return event === undefined ? { seq: -1, key: 'no-human-input' } : { seq: event.seq, key: JSON.stringify([event.seq, (event.data as { id?: string }).id]) }
}

function assertApprovalNotRejected(session: LiveAgentLike['session'], input: { seq: number; key: string }): void {
  let rejected = rejectedInputs.get(session)?.has(input.key) === true
  const asked = new Set<string>()
  for (const event of sessionEvents(session)) {
    if (event.seq <= input.seq || session.isOwnSeq?.(event.seq) === false) continue
    // A decision for a request asked before the next human input belongs to that older input.
    if (event.type === 'user/message' && (event.data.source as { kind?: string } | undefined)?.kind === 'user') break
    const data = event.data as { id?: unknown; toolName?: unknown; outcome?: unknown }
    if (event.type === 'approval/asked' && typeof data.id === 'string' && typeof data.toolName === 'string' && data.toolName.startsWith('session_coordinator_')) asked.add(data.id)
    if (event.type === 'approval/decided' && data.outcome === 'rejected' && typeof data.id === 'string' && asked.has(data.id)) rejected = true
  }
  if (rejected) throw new Error('not authorized: coordination approval was rejected for this human input; wait for a new explicit human request instead of changing tools, call IDs or wording')
}

/** Native rejection closes new approvals for this input, not already approved task authority. */
export async function requestCoordinationApproval(ctx: Context, exec: { agent?: unknown; signal: AbortSignal; callId?: string }, toolName: string, reason: string): Promise<void> {
  exec.signal.throwIfAborted()
  const service = ctx.get?.('approval') as { request(value: unknown): Promise<string> } | undefined
  const caller = exec.agent as LiveAgentLike | undefined
  if (!caller?.session || !exec.callId || service === undefined) throw new Error('not authorized: native approval is unavailable for this call')
  const input = humanApprovalInput(caller.session)
  assertApprovalNotRejected(caller.session, input)
  const outcome = await service.request({ agent: caller, toolName, callId: exec.callId, signal: exec.signal, reason })
  if (outcome === 'rejected') {
    const inputs = rejectedInputs.get(caller.session) ?? new Set<string>()
    inputs.add(input.key); rejectedInputs.set(caller.session, inputs)
  }
  exec.signal.throwIfAborted()
  if (outcome !== 'allowed-once') throw new Error('not authorized: collaboration approval ' + outcome)
  assertApprovalNotRejected(caller.session, input)
}

export class InformationDeliveryError extends Error {
  readonly outcome: 'unknown' | 'skipped'
  constructor(message: string, outcome: 'unknown' | 'skipped') { super(message); this.outcome = outcome }
}
interface DeliveryOptions { authorize?: () => Promise<void>; signal?: AbortSignal; messageId?: string; informationRecipients?: string[] }

type ReplyHandling = 'continue' | 'receive-only'
interface SendInput { intent?: 'information'; requestId?: string; requireRunning?: boolean; replyHandling?: ReplyHandling; sessionId: string; message: string; mode?: 'queue' | 'steer'; replyTo?: string }
interface Sent extends HopDecision { intent?: 'information'; replyHandling: ReplyHandling; accepted: true; sessionId: string; messageId: string; sinceSeq: number }
interface Delivery {
  committed: boolean
  message?: ReturnType<typeof sourceIdentityMessage>
  reply?: { messageId: string; text: string }
  sender: string
  target: string
  text: string
  mode: 'queue' | 'steer'
  replyHandling: ReplyHandling
  replyTo?: string
  result: Sent
  replied: boolean
  revoked: boolean
  human: boolean
  grantBound: boolean
}

export class SessionDelivery {
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<Sent> }>()
  private readonly informationRequests = new Map<string, { fingerprint: string; result: Promise<Sent> }>()
  private readonly informationOperations = new Map<string, string>()
  private readonly unattemptedInformation = new Set<string>()
  private readonly revocations = new Map<string, number>()
  private readonly messages = new Map<string, Delivery>()
  private readonly turns = new WeakMap<LiveAgentLike['session'], number>()

  private active = true
  private readonly settling = new Set<LiveAgentLike>()
  private readonly received = new Map<LiveAgentLike, Map<string, UserMessage>>()

  private readonly ctx: Context
  private readonly registry: BridgeRegistry
  private readonly grants: CoordinationGrants

  constructor(ctx: Context, registry: BridgeRegistry, grants: CoordinationGrants) {
    this.ctx = ctx; this.registry = registry; this.grants = grants
    ctx.on?.('session/event', (session, event) => {
      if (event.type === 'turn/start') this.turns.set(session, event.seq)
      if (event.type === 'agent/inbox/spliced' && (!Array.isArray(event.data.inserted) || event.data.inserted.some(message => (message?.source as { kind?: string } | null | undefined)?.kind !== 'runtime-context'))) this.turns.delete(session)
      if (event.type === 'turn/end') this.turns.delete(session)
    })
    ctx.effect?.(() => () => { this.active = false; this.received.clear() })
    ctx.on?.('agent/created', async ({ agent }) => { this.recoverReceived(agent); await this.flushReceived(agent); return undefined })
    ctx.on?.('agent/status', ({ agent, status }) => {
      if (status === 'idle') void this.flushReceived(agent).catch(error => console.warn('[session-coordinator] receipt context pending:', error))
    })
    ctx.on?.('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      const pending = this.received.get(agent)
      if (!this.active || signal.aborted || decision.kind !== 'enter' || pending === undefined) return decision
      // A follow-up can start before whenIdle settles; restore only context no longer in any batch/queue.
      const present = new Set([
        ...sessionEvents(agent.session).filter(event => event.type === 'user/message').map(event => event.data.id),
        ...messages.map(message => message.id), ...decision.messages.map(message => message.id),
        ...agent.inbox.nextStep.map(message => message.id), ...agent.inbox.nextTurn.map(message => message.id),
      ])
      const recovered = [...pending.values()].filter(message => !present.has(message.id))
      return recovered.length === 0 ? decision : { ...decision, messages: [...recovered, ...decision.messages] }
    })
    ctx.on?.('agent/disposed', ({ agent }) => this.materializeReceived(agent))
    for (const agent of ctx.agents?.list?.() ?? []) {
      this.recoverReceived(agent)
      void this.flushReceived(agent).catch(error => console.warn('[session-coordinator] receipt context pending:', error))
    }
  }

  /** Only a live, observed turn containing exactly this verified task may finish. */
  canConclude(caller: LiveAgentLike, replyId: string): boolean {
    const reply = this.messages.get(replyId)
    const root = reply?.replyTo === undefined ? undefined : this.messages.get(reply.replyTo)
    const start = this.turns.get(caller.session)
    if (!this.active || !reply?.committed || reply.sender !== caller.id || !root?.committed ||
      root.target !== caller.id || root.reply?.messageId !== replyId || root.revoked || start === undefined ||
      caller.inbox === undefined || caller.inbox.nextStep === undefined || caller.inbox.nextTurn === undefined ||
      caller.inbox.nextStep.length !== 0 || caller.inbox.nextTurn.length !== 0) return false
    const events = sessionEvents(caller.session).filter(event => event.seq >= start)
    if (events[0]?.type !== 'turn/start' || events.some(event => event.type === 'turn/end' || caller.session.isOwnSeq?.(event.seq) === false)) return false
    const inputs = events.filter(event => event.type === 'user/message' && (event.data.source as { kind?: string } | undefined)?.kind !== 'runtime-context')
    return inputs.length === 1 && isDeepStrictEqual(inputs[0]!.data, root.message)
  }

  /** A request receipt is not an assistant message or proof that the target is idle. */
  async waitForRequest(callerId: string, targetId: string, requestId: string, timeoutMs: number, signal: AbortSignal) {
    const request = this.messages.get(requestId)
    if (request === undefined && (signal.aborted || !this.active)) return { kind: 'request-reply' as const, requestId, received: false, message: null, timedOut: false, aborted: true, waitedMs: 0 }
    if (request === undefined) {
      try {
        const message = await reconcileReply(this.ctx, callerId, targetId, requestId, signal)
        if (signal.aborted || !this.active) return { kind: 'request-reply' as const, requestId, received: false, message: null, timedOut: false, aborted: true, waitedMs: 0 }
        return { kind: 'request-reply' as const, requestId, received: true, message, recovered: true, timedOut: false, aborted: false, waitedMs: 0 }
      } catch {
        if (signal.aborted || !this.active) return { kind: 'request-reply' as const, requestId, received: false, message: null, timedOut: false, aborted: true, waitedMs: 0 }
        throw new Error('request predates plugin reload or is unknown: complete owned delivery/reply evidence unavailable; do not resend automatically')
      }
    }
    if (!request?.committed || request.result.intent === 'information' || request.replyTo !== undefined || request.sender !== callerId || request.target !== targetId) {
      throw new Error('requestId is not a committed outgoing task owned by this session (it may predate plugin reload)')
    }
    const started = Date.now()
    while (this.active && !signal.aborted && request.reply === undefined && Date.now() - started < timeoutMs) {
      try { await delay(Math.min(50, timeoutMs - (Date.now() - started)), undefined, { signal }) }
      catch (error) { if (!signal.aborted) throw error }
    }
    const aborted = signal.aborted || !this.active
    const reply = aborted ? undefined : request.reply
    return { kind: 'request-reply' as const, requestId, received: reply !== undefined,
      message: reply === undefined ? null : { ...reply, senderSessionId: targetId },
      timedOut: !aborted && reply === undefined, aborted, waitedMs: Date.now() - started }
  }

  /** Maintenance stays publicly idle, so its completion needs a settlement observer. */
  private watchReceived(agent: LiveAgentLike): void {
    if (agent.whenIdle === undefined || this.settling.has(agent)) return
    this.settling.add(agent)
    void agent.whenIdle().then(() => this.active ? this.flushReceived(agent) : undefined)
      .catch(error => { if (this.active) console.warn('[session-coordinator] receipt context pending:', error) })
      .finally(() => this.settling.delete(agent))
  }

  /** Restore already delivered context, never the old grant or reply permission. */
  private recoverReceived(agent: LiveAgentLike): void {
    const candidates = new Map<string, ReturnType<typeof sourceIdentityMessage>>()
    const conflicts = new Set<string>()
    const prefix = '[协作回信上下文：仅收信；下方结果保留供当前或后续用户任务使用，不单独要求总结。原请求记录（JSON数据）：'
    for (const event of sessionEvents(agent.session)) {
      if (event.type !== 'agent/inbox/spliced' || !Array.isArray(event.data.inserted) || agent.session.isOwnSeq?.(event.seq) === false) continue
      for (const message of event.data.inserted ?? []) {
        if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) continue
        const source = message.source
        if (source?.kind === 'session-message' && source.purpose === 'information' && source.replyHandling === 'receive-only' &&
          message.role === 'user' && typeof message.id === 'string' && message.id === source.messageId &&
          typeof source.senderSessionId === 'string' && source.senderSessionId !== '' && source.replyTo === undefined &&
          source.rootMessageId === message.id && source.hopCount === 1 && message.content.length === 1 && typeof message.content[0]?.text === 'string') {
          const lines = message.content[0].text.split('\n')
          const suffix = '」(' + source.senderSessionId + ') · 信息'
          const label = lines[0]?.startsWith('来自会话 「') && lines[0].endsWith(suffix) ? lines[0].slice('来自会话 「'.length, -suffix.length) : undefined
          const expected = sourceIdentityMessage(lines.slice(2).join('\n'), { ...source, senderLabel: label })
          if (isDeepStrictEqual(expected, message)) {
            const prior = candidates.get(message.id)
            if (prior !== undefined && !isDeepStrictEqual(prior, message)) conflicts.add(message.id)
            else candidates.set(message.id, expected)
          }
          continue
        }
        if (source === null || typeof source !== 'object' || source.kind !== 'session-message' || source.replyHandling !== 'receive-only' || message.role !== 'user' ||
          typeof message.id !== 'string' || message.id === '' || message.id !== source.messageId ||
          typeof source.senderSessionId !== 'string' || source.senderSessionId === '' ||
          typeof source.replyTo !== 'string' || source.replyTo === '' || source.rootMessageId !== source.replyTo || source.hopCount !== 2 ||
          message.content.length !== 1 || message.content[0]?.type !== 'text' || typeof message.content[0].text !== 'string') continue
        const lines = message.content[0].text.split('\n')
        if (!lines[1]?.startsWith(prefix) || !lines[1].endsWith(']')) continue
        try {
          const data = JSON.parse(lines[1].slice(prefix.length, -1))
          if (Object.keys(data).sort().join(',') !== 'automaticSend,originalRequest,originalRequestOrigin,purpose,replyHandling,replyTo,version' ||
            data.version !== 5 || data.replyTo !== source.replyTo || data.purpose !== 'result-context' || data.automaticSend !== false ||
            data.replyHandling !== 'receive-only' || !['human-command', 'model-tool'].includes(data.originalRequestOrigin) ||
            typeof data.originalRequest !== 'string' || data.originalRequest.trim() === '') continue
          const suffix = '」(' + source.senderSessionId + ') · 回信'
          const label = lines[0]?.startsWith('来自会话 「') && lines[0].endsWith(suffix)
            ? lines[0].slice('来自会话 「'.length, -suffix.length) : undefined
          const expected = sourceIdentityMessage(lines.slice(2).join('\n'), { ...source, senderLabel: label }, data.originalRequest, data.originalRequestOrigin)
          if (!isDeepStrictEqual(expected, message)) continue
        } catch { continue }
        const previous = candidates.get(message.id)
        if (previous !== undefined && !isDeepStrictEqual(previous, message)) conflicts.add(message.id)
        else candidates.set(message.id, message as ReturnType<typeof sourceIdentityMessage>)
      }
    }
    for (const id of conflicts) candidates.delete(id)
    if (candidates.size !== 0) this.received.set(agent, candidates)
  }

  /** Only write model history after the driver has settled its tool results. */
  private materializeReceived(agent: LiveAgentLike): void {
    const pending = this.received.get(agent)
    if (pending === undefined) return
    for (const [id, message] of pending) {
      const existing = sessionEvents(agent.session).filter(event => event.type === 'user/message' && event.data.id === id)
      if (existing.some(event => !isDeepStrictEqual(event.data, message))) throw new Error('conflicting received message identity')
      const target = agent.inbox?.nextTurn?.some(item => (item as { id?: string }).id === id) ? 'next-turn' : 'next-step'
      const removed = agent.inbox?.remove?.(id) === true
      try { if (existing.length === 0) agent.session.append('user/message', message, { surfaceOp: 'append' }) }
      catch (error) {
        if (removed) agent.send?.(message, target, false)
        throw error
      }
      pending.delete(id)
    }
    if (pending.size === 0) this.received.delete(agent)
  }

  private flushReceived(agent: LiveAgentLike): Promise<void> {
    if (!this.received.has(agent) || agent.runMaintenance === undefined) return Promise.resolve()
    try { return agent.runMaintenance(async () => { this.materializeReceived(agent) }) }
    catch { this.watchReceived(agent); return Promise.resolve() } // Another driver/maintenance owner will settle first.
  }

  private async receiveOnly(agent: LiveAgentLike, message: UserMessage, mode: 'steer' | 'queue'): Promise<void> {
    if (agent.inject === undefined || agent.send === undefined || agent.whenIdle === undefined || agent.runMaintenance === undefined || agent.inbox?.remove === undefined) {
      throw new Error('仅收信需要支持公开 send、inject、whenIdle、runMaintenance 与 inbox.remove 的宿主')
    }
    let idleWrite: Promise<void> | undefined
    try { idleWrite = agent.runMaintenance(async () => { agent.session.append('user/message', message, { surfaceOp: 'append' }) }) }
    catch { /* Busy: leave model history changes to the next safe step. */ }
    if (idleWrite !== undefined) { await idleWrite; return }
    const pending = this.received.get(agent) ?? new Map()
    pending.set(message.id, message)
    this.received.set(agent, pending)
    try { if (mode === 'queue') agent.send!(message, 'next-turn', false); else agent.inject(message) }
    catch (error) { pending.delete(message.id); if (pending.size === 0) this.received.delete(agent); throw error }
    this.watchReceived(agent)
  }

  /** Trusted scope runtime owns authorization and durable operation identity. */
  async deliverScoped(targetId: string, message: UserMessage, caller: LiveAgentLike, options: {
    mode: 'context' | 'steer' | 'queue'; signal?: AbortSignal
    validate: (target?: LiveAgentLike) => void
    prepareMessage?: (target: LiveAgentLike) => Promise<UserMessage>
    beforeSubmit?: (target: LiveAgentLike) => void
  }): Promise<{ messageId: string; sinceSeq: number }> {
    const checkpoint = (target?: LiveAgentLike) => {
      options.signal?.throwIfAborted()
      if (!this.active) throw new Error('session coordinator is disabled')
      if (getLiveAgent(this.ctx, caller.id) !== caller) throw new Error('calling session changed before delivery')
      if (this.ctx.workspaceRegistry.archivedSessionIds?.some(id => String(id) === targetId)) throw new Error('目标会话已归档，请先恢复它')
      options.validate(target)
    }
    checkpoint()
    if (!message.id || message.role !== 'user' || !Array.isArray(message.content) || message.content.length === 0) throw new Error('invalid scoped message')
    if (typeof this.ctx.sessions?.flush !== 'function') throw new Error('collaboration requires session durability support')
    if (getLiveAgent(this.ctx, targetId) === undefined) await resumeBridgeSession(this.ctx, this.registry, { sessionId: targetId })
    const target = getLiveAgent(this.ctx, targetId)
    if (target === undefined) throw new Error('target did not become live')
    checkpoint(target)
    if (options.prepareMessage !== undefined) {
      const prepared = await options.prepareMessage(target)
      checkpoint(target)
      if (prepared.id !== message.id || prepared.role !== 'user' || !Array.isArray(prepared.content) || prepared.content.length === 0) throw new Error('prepared message changed operation identity')
      message = prepared
    }
    const sinceSeq = maxSeq(sessionEvents(target.session))
    options.beforeSubmit?.(target)
    checkpoint(target)
    if (getLiveAgent(this.ctx, targetId) !== target) throw new Error('target changed before delivery')
    void recordDiagnostic(this.ctx, caller.session, { ...(message.source as unknown as Record<string, unknown>), targetSessionId: targetId, protocol: 'persistent', messageId: message.id, stage: 'submit-started', delivery: 'unknown' })
    try {
      if (options.mode === 'context') await this.receiveOnly(target, message, 'steer')
      else if (options.mode === 'queue') target.followup(message)
      else target.steer(message)
      if (!await this.ctx.sessions.flush(target.session)) throw new Error('target session has no durability listener')
    } catch (error) {
      throw new InformationDeliveryError('scoped delivery outcome unknown: ' + (error instanceof Error ? error.message : String(error)), 'unknown')
    }
    void recordDiagnostic(this.ctx, caller.session, { ...(message.source as unknown as Record<string, unknown>), targetSessionId: targetId, protocol: 'persistent', messageId: message.id, sinceSeq, stage: 'accepted', delivery: 'accepted' })
    return { messageId: message.id, sinceSeq }
  }

  revoke(sender: string): void {
    this.revocations.set(sender, (this.revocations.get(sender) ?? 0) + 1)
    for (const message of this.messages.values()) if (message.sender === sender) message.revoked = true
  }

  /** commands.execute 是现成的人工入口；不能把正文中的来源声明当成回信授权。 */
  async fromCommand(callerId: string, raw: string): Promise<CommandResult> {
    let args: unknown
    try { args = JSON.parse(raw) } catch { args = {} }
    return diagnosticCall(this.ctx, getLiveAgent(this.ctx, callerId), 'coordinate.send', args, undefined, undefined, () => this.commandSend(callerId, raw))
  }

  private async commandSend(callerId: string, raw: string): Promise<CommandResult> {
    try {
      const input: unknown = JSON.parse(raw)
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid send request')
      const value = input as Record<string, unknown>
      if (typeof value.requestId !== 'string' || !/^[\w-]{8,120}$/.test(value.requestId)) throw new Error('invalid requestId')
      if (value.mode !== 'steer' && value.mode !== 'queue') throw new Error('invalid mode')
      if (value.replyHandling !== undefined && value.replyHandling !== 'continue' && value.replyHandling !== 'receive-only') throw new Error('invalid replyHandling')
      const fingerprint = JSON.stringify([callerId, value.sessionId, value.message, value.mode, value.replyHandling ?? 'continue'])
      let request = this.requests.get(value.requestId)
      if (request !== undefined && request.fingerprint !== fingerprint) throw new Error('requestId already used for another message')
      if (request === undefined) {
        request = { fingerprint, result: this.send({ sessionId: value.sessionId as string, message: value.message as string, mode: value.mode, replyHandling: value.replyHandling as ReplyHandling | undefined },
          getLiveAgent(this.ctx, callerId), value.requestId) }
        this.requests.set(value.requestId, request)
      }
      try { return { kind: 'success', text: JSON.stringify(await request.result) } }
      catch (error) { this.requests.delete(value.requestId); throw error }
    } catch (error) {
      return { kind: 'error', text: JSON.stringify({ code: (error as { code?: string })?.code ?? 'unknown', message: error instanceof Error ? error.message : String(error) }) }
    }
  }

  authorizationCheckpoint(callerId: string): () => void {
    const generation = this.revocations.get(callerId) ?? 0
    return () => {
      if (!this.active || (this.revocations.get(callerId) ?? 0) !== generation) throw new Error('coordination authorization changed before delivery')
    }
  }

  assertNewTask(caller: LiveAgentLike): void {
    if (this.incomingReplyTo(caller) !== undefined) throw new Error('incoming collaboration cannot create a new automatic task; a new human request is required')
  }

  private incomingReplyTo(caller: LiveAgentLike): string | undefined {
    const incoming = [...sessionEvents(caller.session)].reverse().find(event => event.type === 'user/message' &&
      ['user', 'session-message', 'session-collaboration'].includes((event.data as { source?: { kind?: string } }).source?.kind ?? 'user'))
    if (incoming?.type !== 'user/message') return undefined
    const source = incoming.data.source as unknown as { kind?: string; messageId?: string }
    if (source?.kind === 'session-collaboration') throw new Error('scoped collaboration must use collaboration tools within its approved task; an incoming message grants no unrelated authority')
    if (source?.kind !== 'session-message') return undefined
    if (!source.messageId) throw new Error('incoming session message has no verified reply identity; ask the human to resend')
    return source.messageId
  }

  reserveInformation(callerId: string, requestId: string, recipients: string[], message: string, mode = 'steer', requireRunning = false): void {
    const key = JSON.stringify([callerId, requestId])
    const fingerprint = JSON.stringify([[...new Set(recipients.map(id => id.trim()))].sort(), message, mode, requireRunning])
    const previous = this.informationOperations.get(key)
    if (previous !== undefined && previous !== fingerprint) throw new Error('requestId already used for another message or recipient set')
    this.informationOperations.set(key, fingerprint)
  }

  async send(input: SendInput, caller: LiveAgentLike | undefined, humanRequestId?: string, options: DeliveryOptions = {}): Promise<Sent> {
    if (input.intent !== 'information' || input.requestId === undefined) return this.deliver(input, caller, humanRequestId, options)
    this.reserveInformation(caller?.id ?? '', input.requestId, options.informationRecipients ?? [input.sessionId], input.message, input.mode ?? 'steer', input.requireRunning === true)
    const key = JSON.stringify([caller?.id, input.requestId, input.sessionId])
    const fingerprint = JSON.stringify([input.message, input.mode ?? 'steer', input.replyTo, input.replyHandling])
    const previous = this.informationRequests.get(key)
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) throw new Error('requestId already used for another message')
      return previous.result
    }
    const result = Promise.resolve().then(() => this.deliver(input, caller, humanRequestId, options))
    this.informationRequests.set(key, { fingerprint, result })
    // Failed before attempting delivery can be retried; unknown outcomes remain reserved in messages.
    result.catch(() => { this.informationRequests.delete(key) })
    return result
  }

  private async deliver(input: SendInput, caller: LiveAgentLike | undefined, humanRequestId: string | undefined, options: DeliveryOptions): Promise<Sent> {
    options.signal?.throwIfAborted()
    if (!this.active) throw new Error('session coordinator is disabled')
    if (caller === undefined || caller.id === '') throw new Error('cannot determine calling session')
    if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') throw new Error('invalid sessionId')
    if (typeof input.message !== 'string' || input.message.trim() === '') throw new Error('invalid message')
    const targetId = input.sessionId.trim()
    if (targetId === caller.id) throw new Error('cannot send to the same session')
    const text = input.message.trim()
    const information = input.intent === 'information'
    if (input.intent !== undefined && !information) throw new Error('invalid intent')
    if (input.requestId !== undefined && (!information || !/^[\w-]{8,120}$/.test(input.requestId))) throw new Error('requestId requires information intent and 8-120 identifier characters')
    if (information && input.replyTo !== undefined) throw new Error('information cannot be a task reply')
    if (information) this.assertNewTask(caller)
    if (information && typeof this.ctx.sessions?.flush !== 'function') throw new Error('information sharing requires session durability support')
    const mode = input.mode === 'queue' ? 'queue' : 'steer'
    if (input.replyHandling !== undefined && input.replyHandling !== 'continue' && input.replyHandling !== 'receive-only') throw new Error('invalid replyHandling')
    const requestedHandling = information ? 'receive-only' : input.replyHandling ?? 'continue'
    const stableId = input.requestId === undefined ? undefined : 'info-' + createHash('sha256').update(JSON.stringify([caller.id, input.requestId, targetId])).digest('hex')
    if (stableId !== undefined) {
      const previous = this.messages.get(stableId)
      if (previous !== undefined) {
        if (previous.sender !== caller.id || previous.target !== targetId || previous.text !== text || previous.mode !== mode || previous.result.intent !== 'information') throw new Error('requestId already used for another message')
        if (!previous.committed) throw new InformationDeliveryError('information delivery outcome unknown; inspect the original messageId instead of resending: ' + stableId, 'unknown')
        return previous.result
      }
    }
    // 人工面板只授权本次发送；重复请求先核对报文，不能用同一个 id 换目标或正文。
    if (humanRequestId !== undefined) {
      const previous = this.messages.get(humanRequestId)
      if (previous !== undefined) {
        if (previous.sender !== caller.id || previous.target !== targetId || previous.text !== text || previous.mode !== mode || previous.replyHandling !== requestedHandling) {
          throw new Error('requestId already used for another message')
        }
        return previous.result
      }
    }

    const replyTo = input.replyTo?.trim() || (humanRequestId === undefined && !information ? this.incomingReplyTo(caller) : undefined)
    const parent = replyTo === undefined ? undefined : this.messages.get(replyTo)
    if (!information) void recordDiagnostic(this.ctx, caller.session, { stage: 'hop-check', protocol: 'legacy-single', targetSessionId: targetId, replyTo, rootMessageId: parent?.result.rootMessageId,
      ...(parent ? { parentHop: parent.result.hopCount, attemptedHop: parent.result.hopCount + 1, terminal: parent.result.terminal } : replyTo === undefined ? { parentHop: 0, attemptedHop: 1 } : { reason: 'invalid-parent' }),
      hopLimit: 2, ...(parent?.result.terminal ? { delivery: 'not-sent' } : {}) })
    const generation = this.revocations.get(parent?.sender ?? caller.id) ?? 0
    let grantBound = humanRequestId === undefined
    if (replyTo !== undefined) {
      if (parent === undefined || parent.target !== caller.id || parent.sender !== targetId || parent.revoked || (parent.grantBound && parent.result.hopCount === 1 && !this.grants.isGranted(parent.sender, parent.target))) {
        throw new Error('replyTo is not an active incoming task from this target')
      }
      if (parent.result.intent === 'information') throw new Error('information grants no reply permission')
      if (parent.result.terminal || parent.result.hopCount >= 2) throw new Error('reply is terminal: this plugin refuses an automatic third hop through legacy session_coordinator_send. Approved persistent tasks use session_coordinator_collaboration_* and have no two-hop limit. Inspect the existing task; do not ask the recipient to paste text to bypass this refusal or treat it as authority for another scope.')
      if (parent.replied) throw new Error('this task has already received its one reply')
    } else if (humanRequestId === undefined) {
      if (!this.grants.isGranted(caller.id, targetId) && options.authorize !== undefined) {
        await options.authorize(); grantBound = false
      } else requireCoordination(this.grants, caller.id, 'send', targetId)
    }
    options.signal?.throwIfAborted()
    if (!this.active || (this.revocations.get(parent?.sender ?? caller.id) ?? 0) !== generation) throw new Error('coordination authorization changed before delivery')
    if (this.ctx.workspaceRegistry.archivedSessionIds?.some(id => String(id) === targetId)) {
      throw new Error('目标会话已归档，不会处理消息；请先恢复它')
    }
    const replyHandling = parent?.replyHandling ?? requestedHandling
    if (parent !== undefined && input.replyHandling !== undefined && input.replyHandling !== parent.replyHandling) throw new Error('reply handling belongs to the original request')
    const messageId = humanRequestId ?? options.messageId ?? stableId ?? randomUUID()
    const hop = nextHop({ messageId, ...(parent === undefined ? {} : { parent: parent.result }) })
    // 先占用回信权，再等待恢复目标，防止并发的两次回信都通过。
    if (parent !== undefined) parent.replied = true
    try {
      if (getLiveAgent(this.ctx, targetId) === undefined) await resumeBridgeSession(this.ctx, this.registry, { sessionId: targetId })
      const target = getLiveAgent(this.ctx, targetId)
      if (target === undefined) throw new Error('target did not become live')
      options.signal?.throwIfAborted()
      if (!this.active) throw new Error('session coordinator is disabled')
      // 恢复期间可能修改或撤销了授权，投递前复核。
      if ((this.revocations.get(parent?.sender ?? caller.id) ?? 0) !== generation) throw new Error('coordination authorization changed before delivery')
      if (parent !== undefined && (parent.revoked || (parent.grantBound && parent.result.hopCount === 1 && !this.grants.isGranted(parent.sender, parent.target)))) throw new Error('reply authorization was revoked')
      if (parent === undefined && grantBound) requireCoordination(this.grants, caller.id, 'send', targetId)
      if (this.ctx.workspaceRegistry.archivedSessionIds?.some(id => String(id) === targetId)) throw new Error('目标会话已归档，不会处理消息；请先恢复它')
      const result: Sent = { ...hop, ...(information ? { intent: 'information' as const, terminal: true, reason: 'information only; no reply requested or permitted' } : {}), replyHandling, accepted: true, sessionId: targetId, messageId, sinceSeq: maxSeq(sessionEvents(target.session)) }
      const delivery: Delivery = { committed: false, sender: caller.id, target: targetId, text, mode, replyHandling, ...(replyTo === undefined ? {} : { replyTo }), result, replied: false, revoked: false, human: humanRequestId !== undefined, grantBound }
      const message = sourceIdentityMessage(text, {
        ...(information || parent !== undefined && replyHandling === 'receive-only' ? { replyHandling: 'receive-only' as const } : {}),
        ...(information ? { purpose: 'information' as const } : {}),
        senderSessionId: caller.id, senderLabel: titleOf(sessionEvents(caller.session)), messageId,
        ...(replyTo === undefined ? {} : { replyTo }), rootMessageId: hop.rootMessageId, hopCount: hop.hopCount,
      }, parent?.text, parent === undefined ? undefined : parent.human ? 'human-command' : 'model-tool')
      if (information) {
        const prior = sessionEvents(caller.session).some(event => {
          const record = pluginRecordOf(event)
          return record?.type === 'plugin:dsh-session-coordinator/delivery' && (record.data as { requestId?: string }).requestId === messageId
        })
        if (prior && !this.unattemptedInformation.has(messageId)) throw new InformationDeliveryError('information delivery outcome unknown after reload; inspect messageId=' + messageId, 'unknown')
        // This process can prove no target method was called. Do not infer this from a persisted intent after restart.
        this.unattemptedInformation.add(messageId)
        if (prior) {
          if (!await this.ctx.sessions.flush(caller.session)) throw new Error('information reservation has no durability listener')
        } else await recordDelivery(this.ctx, caller.session, { version: 1, owner: caller.id, target: targetId, requestId: messageId, stage: 'intent', text, message })
      } else await recordDelivery(this.ctx, caller.session, { version: 1, owner: caller.id, target: targetId, requestId: messageId, stage: 'intent', text, message })
      options.signal?.throwIfAborted()
      if (!this.active || (this.revocations.get(parent?.sender ?? caller.id) ?? 0) !== generation) throw new Error('coordination authorization changed before delivery')
      if (getLiveAgent(this.ctx, targetId) !== target || this.ctx.workspaceRegistry.archivedSessionIds?.some(id => String(id) === targetId)) throw new Error('target changed before delivery')
      if (information && input.requireRunning === true && target.status !== 'running') throw new InformationDeliveryError('recipient is no longer running', 'skipped')
      delivery.message = message
      this.messages.set(messageId, delivery)
      this.unattemptedInformation.delete(messageId)
      void recordDiagnostic(this.ctx, caller.session, { ...result, targetSessionId: targetId, protocol: information ? 'information' : 'legacy-single', stage: 'submit-started', delivery: 'unknown' })
      try {
        if (information || parent !== undefined && replyHandling === 'receive-only') await this.receiveOnly(target, message, mode)
        else if (mode === 'queue') target.followup(message)
        else target.steer(message)
      } catch (error) {
        if (!information) { this.messages.delete(messageId); throw error }
        throw new InformationDeliveryError('information delivery outcome unknown: ' + (error instanceof Error ? error.message : String(error)), 'unknown')
      }
      delivery.committed = true
      let durable = false
      if (parent !== undefined) parent.reply = { messageId, text }
      try {
        if (typeof this.ctx.sessions?.flush === 'function' && !await this.ctx.sessions.flush(target.session)) throw new Error('target has no durability listener')
        durable = await recordDelivery(this.ctx, caller.session, { version: 1, owner: caller.id, target: targetId, requestId: messageId, stage: 'delivered', text, message })
      } catch (error) {
        if (information) {
          delivery.committed = false
          throw new InformationDeliveryError('information durability outcome unknown; inspect messageId=' + messageId + ': ' + (error instanceof Error ? error.message : String(error)), 'unknown')
        }
        console.warn('[session-coordinator] delivered; recovery evidence incomplete:', error)
      }
      this.registry.touch(targetId)
      void recordDiagnostic(this.ctx, caller.session, { ...result, targetSessionId: targetId, protocol: information ? 'information' : 'legacy-single', stage: durable ? 'accepted' : 'transport-returned', delivery: durable ? 'accepted' : 'unknown' })
      return result
    } catch (error) {
      if (parent !== undefined && parent.reply === undefined) parent.replied = false
      throw error
    }
  }
}
