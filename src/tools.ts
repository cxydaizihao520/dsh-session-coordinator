/**
 * dsh-session-coordinator 模型面向工具：create / send / resume / wait / read / find。
 * 全部经插件宿主 ctx 操作真实 DSH 会话（顶层主会话与任意其它会话）。
 */
import { createHash } from 'node:crypto'
import { recordCreation } from './coordination-records.ts'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  BridgeFindItem,
  BridgeMessageRow,
  BridgeStatusSnapshot,
  BridgeWaitResult,
  LiveAgentLike,
} from './core.ts'
import {
  archivedEntries,
  foldMessages,
  inspectPersistedSession,
  isStalled,
  maxSeq,
  resolveTargetCwd,
  segmentsSince,
  sessionEvents,
  statusSnapshot,
  titleOf,
  waitForReply,
  workspaceByPath,
  workspaceBySession,
} from './core.ts'
import { createBridgeSession, resumeBridgeSession, validateBridgeSessionModel, type ResumeArgs, type BridgeSessionCaller } from './session-create.ts'
import { HOP_RULE_TEXT } from './hop.ts'
import { registerReceipt } from './receipts.ts'
import { requireCoordination, type CoordinationGrants } from './coordinate.ts'
import { SessionDelivery, InformationDeliveryError, requestCoordinationApproval } from './delivery.ts'
import type { BridgeRegistry } from './registry.ts'
import type { SessionMonitor, MonitorConfig, MonitorEntryState, CoTRule } from './monitor.ts'
import type { LoopPolicy } from './config.ts'
import { installCollaboration } from './collaboration-tools.ts'
import { registerCollaborationMaterialTools } from './collaboration-material-tools.ts'
import { readNativeSessionReferences } from './collaboration-materials.ts'

export interface BridgeEnv {
  ctx: Context
  registry: BridgeRegistry
  monitor: SessionMonitor
  /** 插件级循环策略（总开关 + 全局默认值）：渲染与默认值都读它。 */
  policy: LoopPolicy
  /** 会话级协调授权（见 coordinate.ts）：跨会话动作必须由用户先授权。 */
  grants: CoordinationGrants
  delivery?: SessionDelivery
}

function asJson(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>
}

const MAX_WAIT_MS = 3_600_000

function clampTimeout(ms: number | undefined, fallback = 180_000): number {
  if (ms === undefined) return fallback
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(ms)}`)
  return Math.min(ms, MAX_WAIT_MS)
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: expected a positive integer, got ${JSON.stringify(limit)}`)
  return Math.min(limit, max)
}

/** 结构取活 agent（ctx.agents 的返回类型按 dsh-agent 的 Agent 形状；这里用结构面）。 */
function liveAgent(env: BridgeEnv, sessionId: string): LiveAgentLike | undefined {
  const agents = env.ctx.agents as unknown as { get(id: string): LiveAgentLike | undefined }
  return agents.get(sessionId)
}

function liveAgents(env: BridgeEnv): LiveAgentLike[] {
  const agents = env.ctx.agents as unknown as { list(): LiveAgentLike[] }
  return agents.list()
}

/** 等待结果里的状态附注行（wait / send / create 三处渲染共用）。 */
function waitNotes(reply: Record<string, unknown>): string[] {
  const notes: string[] = []
  if (reply.timedOut === true) notes.push('[wait timed out]')
  if (reply.stale === true) notes.push('[stale] pre-existing reply — nothing new arrived during the wait')
  if (reply.aborted === true) notes.push('[wait aborted]')
  return notes
}

/** 渲染等待结果为 JSON 友好值。 */
function renderWait(wait: BridgeWaitResult): Record<string, unknown> {
  const row = wait.message
  return {
    message: row === null ? null : {
      seq: row.seq,
      role: row.role,
      ...(row.text !== undefined ? { text: row.text } : {}),
      ...(row.reasoning !== undefined ? { reasoning: row.reasoning } : {}),
      images: row.images,
      toolCalls: row.toolCalls ?? [],
    },
    seq: wait.seq,
    turnEnded: wait.turnEnded,
    timedOut: wait.timedOut,
    ...(wait.stale === true ? { stale: true } : {}),
    aborted: wait.aborted,
    waitedMs: wait.waitedMs,
  }
}

/** Approval is execution-local; neither tool arguments nor persisted records can grant it. */
async function approveOnce(env: BridgeEnv, exec: { agent?: unknown; signal: AbortSignal; callId?: string }, toolName: string, payload: unknown): Promise<void> {
  await requestCoordinationApproval(env.ctx, exec, toolName, 'Approve this one collaboration action only: ' + JSON.stringify(payload))
}

interface CreateArgs {
  replyHandling?: 'continue' | 'receive-only'
  workspaceId?: string
  cwd?: string
  title?: string
  prompt?: string
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  waitForReply?: boolean
  timeoutMs?: number
}

function registerCreate(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_create',
    description: 'Create a real independent main chat, visible in the sidebar with its own history and available for later conversation. Use for a user-requested new chat/session (新会话/独立会话), rather than a temporary team/subagent. This entry grants native approval for one task/reply only; for joint delivery, review/rework or continued rounds use collaboration_start with newSessions. Defaults to the current workspace/model. Asynchronous by default; waitForReply waits for this task reply, not assistant text. On uncertain creation/delivery inspect the returned identity; do not create another chat or resend automatically.',
    parameters: {
      workspaceId: { type: 'string', description: 'Target workspace id (from session_coordinator_find). Takes precedence over cwd.' },
      cwd: { type: 'string', description: 'Target working directory for the new session (absolute path or any spelling).' },
      title: { type: 'string', description: 'Optional name for the new session, applied to the native sidebar when the host title service is available; also remembered for find-by-name.' },
      prompt: { type: 'string', required: true, description: 'First task, delivered once through the verified reply chain.' },
      replyHandling: { type: 'string', enum: ['continue', 'receive-only'], description: 'How the originator receives the reply; defaults to continue.' },
      agentPreset: { type: 'string', description: 'Optional agent preset id for composition.' },
      provider: { type: 'string', description: 'Omit to inherit the calling chat’s provider. Override only for an explicit need after verifying the target provider/model route is available.' },
      model: { type: 'string', description: 'Omit to inherit the calling chat’s model. Override only for an explicit need after verifying the exact model is available on the selected provider.' },
      reasoningEffort: { type: 'string', description: 'Omit to inherit the caller’s configured effort. Override only for an explicit need after verifying the selected provider/model supports the exact value. Effort levels are model-specific; do not assume a universal low/medium/high enum or silently substitute a fallback.' },
      waitForReply: { type: 'boolean', description: 'When true and prompt is given, wait for this task’s correlated reply (default false).' },
      timeoutMs: { type: 'number', description: 'Wait timeout in milliseconds (default 180000, max 3600000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const lines: string[] = [`created main session ${String(v.sessionId)}`]
        if (typeof v.cwd === 'string') lines.push(`cwd: ${v.cwd}`)
        if (typeof v.title === 'string') lines.push(`title: ${v.title}`)
        const reply = v.reply as Record<string, unknown> | undefined
        if (typeof v.messageId === 'string') lines.push(`requestId: ${v.messageId} (pass to session_coordinator_wait)`)
        if (reply !== undefined) {
          lines.push(`reply: ${String((reply.message as Record<string, unknown> | null)?.text ?? '(no text)')}`)
          lines.push(...waitNotes(reply))
        }
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: CreateArgs, exec) {
      args = structuredClone(args)
      const caller = exec.agent as LiveAgentLike | undefined
      if (caller === undefined || !exec.callId) throw new Error('cannot determine creating session/call')
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('create requires a non-empty first task')
      if (args.replyHandling !== undefined && !['continue', 'receive-only'].includes(args.replyHandling)) throw new Error('invalid replyHandling')
      const prompt = args.prompt
      const timeout = clampTimeout(args.timeoutMs)
      env.delivery!.assertNewTask(caller)
      const check = env.delivery!.authorizationCheckpoint(caller.id)
      const cwd = await resolveTargetCwd(env.ctx, caller.session.header.cwd, args)
      const route = caller.session.requestHeader?.()?.config
      args = { ...args, provider: args.provider || route?.provider, model: args.model || route?.model, reasoningEffort: args.reasoningEffort || route?.reasoningEffort }
      await validateBridgeSessionModel(env.ctx, args, exec.signal)
      const requestId = 'create-' + createHash('sha256').update(JSON.stringify([caller.id, exec.callId])).digest('hex')
      const sessionId = 'sb-' + requestId
      await approveOnce(env, exec, 'session_coordinator_create', { ...args, cwd, sessionId })
      check(); exec.signal.throwIfAborted()
      await recordCreation(env.ctx, caller.session, requestId, sessionId, cwd)
      check(); exec.signal.throwIfAborted()
      let created
      try {
        created = await createBridgeSession(env.ctx, env.registry, {
          ...args, prompt: undefined, sessionId, cwd, callerCwd: caller.session.header.cwd, signal: exec.signal,
          caller: { ctx: caller.ctx, session: caller.session as unknown as BridgeSessionCaller['session'] },
        })
        check(); exec.signal.throwIfAborted()
        const sent = await env.delivery!.send({ sessionId, message: prompt, replyHandling: args.replyHandling }, caller, undefined,
          { authorize: async () => { check(); exec.signal.throwIfAborted() }, signal: exec.signal, messageId: requestId })
        const reply = args.waitForReply === true ? await env.delivery!.waitForRequest(caller.id, sessionId, sent.messageId, timeout, exec.signal) : undefined
        return asJson({ ...sent, cwd: created.cwd, ...(args.title === undefined ? {} : { title: args.title }), ...(created.workspaceId === undefined ? {} : { workspaceId: created.workspaceId }), ...(reply === undefined ? {} : { reply }) })
      } catch (error) {
        throw new Error('Creation/delivery needs inspection; do not create or resend automatically. sessionId=' + sessionId + ', requestId=' + requestId +
          ', creationConfirmed=' + String(created !== undefined) + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }))
}

interface SendArgs {
  intent?: 'information'
  requestId?: string
  retryFailed?: boolean
  requireRunning?: boolean
  replyHandling?: 'continue' | 'receive-only'
  sessionId?: string
  sessionIds?: string[]
  message: string
  mode?: 'queue' | 'steer'
  waitForReply?: boolean
  timeoutMs?: number
  replyTo?: string
}

function registerSend(env: BridgeEnv): void {
  const batches = new Map<string, { fingerprint: string; run: Promise<Record<string, unknown>> }>()
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_send',
    description: 'Legacy one-task/reply or information delivery; source.kind=session-collaboration uses collaboration_send/result instead and has its own approved multi-round scope. Deliver an outgoing task with existing target authorization or native approval for this one call, or the ONE eligible reply to a verified legacy incoming task. For an eligible reply use its sender session id and task messageId. A received result-context is the result already delivered to its originator; receive-only results are context without a separate summary, while other results complete the human task. mode=steer (default) schedules the next step without aborting; mode=queue schedules the next turn. Offline targets resume after permission is checked. waitForReply=true waits for the correlated task reply, not assistant text or idleness. A terminal legacy reply never waits for another reply. ' + HOP_RULE_TEXT,
    parameters: {
      intent: { type: 'string', enum: ['information'], description: 'Information sharing only: retain context without waking idle targets, granting a reply or starting a task. Omit for existing task/reply behavior.' },
      requestId: { type: 'string', description: 'For information sharing: stable 8-120 character request identity, reuse for retries; never change recipients or content under this id.' },
      retryFailed: { type: 'boolean', description: 'For a known information batch: retry its unsuccessful recipients with the original requestId and complete original recipient set. Unknown outcomes are inspected rather than resent.' },
      requireRunning: { type: 'boolean', description: 'Information from a running-only recipient snapshot: skip a recipient if it is no longer running at submission. Does not wake idle sessions.' },
      sessionId: { type: 'string', description: 'One target id; mutually exclusive with sessionIds. For a reply, use the original sender.' },
      sessionIds: { type: 'array', items: { type: 'string' }, description: 'Information-only fan-out to a complete explicit recipient snapshot. Use find pagination first; exclude yourself. Requires intent=information. Each result has its own status; a failure never replays successful targets.' },
      message: { type: 'string', required: true, description: 'Message text to send as a user turn.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'steer (default): next step boundary, running target is not aborted, idle target starts a turn. queue: append a whole turn after the current one finishes.' },
      replyHandling: { type: 'string', enum: ['continue', 'receive-only'], description: 'For a NEW task: continue (default) wakes the originator on reply. receive-only retains the reply as context without waking an idle originator; a running originator may use it at its next step. On a reply, omit this field: the original request owns this choice. This grants no extra permission.' },
      waitForReply: { type: 'boolean', description: 'For a new task, wait for its correlated reply (default false). Ignored on terminal replies.' },
      timeoutMs: { type: 'number', description: 'Wait timeout in milliseconds (default 180000, max 3600000).' },
      replyTo: { type: 'string', description: 'For an eligible task reply, use that incoming task messageId. The replyTo field of a received result-context identifies the already answered original request; it is not a new reply permission. The host infers omitted ids from the current incoming message and rejects unknown, consumed, wrong-target and terminal ids.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        const v = value as Record<string, unknown>
        if (Array.isArray(v.results)) return [{ type: 'text' as const, text: 'information batch ' + String(v.requestId) + '\n' + (v.results as Array<Record<string, unknown>>).map(item => String(item.sessionId) + ': ' + String(item.status) + (item.error ? ' — ' + String(item.error) : '')).join('\n') }]
        const reply = v.reply as Record<string, unknown> | null | undefined
        const terminal = v.terminal === true
        // 回信成功后仅回显实际交付正文；流程诊断留在结构化结果，防环由宿主执行。
        const lines = v.intent === 'information' ? ['information retained in ' + String(v.sessionId) + '; messageId: ' + String(v.messageId) + '; no reply requested'] : terminal
          ? [args.message]
          : ['sent to ' + String(v.sessionId)]
        if (!terminal) {
          if (typeof v.messageId === 'string') lines.push('messageId: ' + v.messageId + ' (pass as requestId to session_coordinator_wait)')
          if (typeof v.reason === 'string') lines.push('terminal: ' + v.reason)
          if (typeof v.sinceSeq === 'number') lines.push('sinceSeq: ' + String(v.sinceSeq) + ' (legacy assistant-text cursor; use messageId as requestId for this task)')
        }
        if (reply !== null && reply !== undefined) {
          lines.push('reply: ' + String((reply.message as Record<string, unknown> | null)?.text ?? '(no text)'))
          lines.push(...waitNotes(reply))
        }
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: SendArgs, exec) {
      args = structuredClone(args)
      const timeout = clampTimeout(args.timeoutMs)
      if (typeof args.message !== 'string' || args.message.trim() === '') throw new Error('invalid message: expected a non-empty string')
      if (args.intent === 'information' && (args.waitForReply === true || args.replyTo !== undefined || args.replyHandling === 'continue')) throw new Error('information cannot request a reply or continuation')
      const caller = exec.agent as LiveAgentLike | undefined
      if (args.sessionIds !== undefined) {
        if (args.sessionId !== undefined || args.intent !== 'information' || caller === undefined || !Array.isArray(args.sessionIds) || args.sessionIds.length === 0 || args.sessionIds.some(id => typeof id !== 'string' || id.trim() === '' || id.trim() === caller.id)) throw new Error('invalid information recipient set')
        const targets = [...new Set(args.sessionIds.map(id => id.trim()))].sort()
        const requestId = args.requestId ?? 'batch-' + createHash('sha256').update(JSON.stringify([caller.id, exec.callId])).digest('hex')
        if (!/^[\w-]{8,120}$/.test(requestId)) throw new Error('invalid requestId')
        env.delivery!.assertNewTask(caller)
        env.delivery!.reserveInformation(caller.id, requestId, targets, args.message, args.mode ?? 'steer', args.requireRunning === true)
        const fingerprint = JSON.stringify([targets, args.message, args.mode ?? 'steer', args.requireRunning === true])
        const key = JSON.stringify([caller.id, requestId])
        const prior = batches.get(key)
        let priorResults: Array<Record<string, unknown>> = []
        if (prior !== undefined) {
          if (prior.fingerprint !== fingerprint) throw new Error('requestId already used for another batch')
          if (args.retryFailed !== true) return asJson(await prior.run)
          priorResults = (await prior.run).results as Array<Record<string, unknown>>
          // Another retry may already own this batch after the await.
          if (batches.get(key) !== prior) return asJson(await batches.get(key)!.run)
        } else if (args.retryFailed === true) {
          throw new Error('batch predates reload or is unknown; inspect instead of retrying')
        }
        const preserved = priorResults.filter(item => ['accepted', 'unknown', 'skipped'].includes(String(item.status)))
        const pendingTargets = targets.filter(id => !preserved.some(item => item.sessionId === id))
        const checkpoint = env.delivery!.authorizationCheckpoint(caller.id)
        const run = Promise.resolve().then(async () => {
          exec.signal?.throwIfAborted()
          const allGranted = pendingTargets.every(id => env.grants.isGranted(caller.id, id))
          if (!allGranted) await approveOnce(env, exec, 'session_coordinator_send', { intent: 'information', sessionIds: pendingTargets, message: args.message, mode: args.mode ?? 'steer', requestId })
          checkpoint()
          const results: Array<Record<string, unknown>> = []
          for (const sessionId of targets) {
            const accepted = preserved.find(item => item.sessionId === sessionId)
            if (accepted !== undefined) { results.push(accepted); continue }
            try {
              exec.signal?.throwIfAborted(); checkpoint()
              if (allGranted && !env.grants.isGranted(caller.id, sessionId)) throw new Error('coordination authorization changed before delivery')
              const sent = await env.delivery!.send({ sessionId, message: args.message, mode: args.mode, intent: 'information', requestId, requireRunning: args.requireRunning }, caller, undefined,
                { signal: exec.signal, informationRecipients: targets, authorize: async () => { checkpoint() } })
              results.push({ sessionId, status: 'accepted', messageId: sent.messageId })
            } catch (error) {
              results.push({ sessionId, status: error instanceof InformationDeliveryError ? error.outcome : exec.signal.aborted ? 'aborted' : 'failed', error: error instanceof Error ? error.message : String(error) })
            }
          }
          return { requestId, results, complete: results.every(item => item.status === 'accepted') }
        })
        batches.set(key, { fingerprint, run })
        run.catch(() => batches.delete(key))
        return asJson(await run)
      }
      if (args.retryFailed !== undefined) throw new Error('retryFailed requires an information batch')
      if (args.requireRunning !== undefined && args.intent !== 'information') throw new Error('requireRunning requires information intent')
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const sent = await env.delivery!.send({ ...args, sessionId: args.sessionId }, caller, undefined, { signal: exec.signal, authorize: () => approveOnce(env, exec, 'session_coordinator_send', args) })
      if (sent.terminal && caller !== undefined && !exec.signal.aborted && env.delivery!.canConclude(caller, sent.messageId)) exec.concludeTurn?.()
      const reply = args.waitForReply === true && !sent.terminal
        ? await env.delivery!.waitForRequest(caller!.id, sent.sessionId, sent.messageId, timeout, exec.signal)
        : undefined
      return asJson({ ...sent, ...(reply === undefined ? {} : { reply }) })
    },
  }))
}

function registerResume(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_resume',
    description: 'Legacy standalone session management: load one persisted chat for session-level monitoring or an explicitly requested whole-chat reopen. Requires a target-specific /coordinate grant; a collaboration approval is not that grant. For a paused/interrupted collaboration, use session_coordinator_collaboration_control(action=resume) for the scope/task, then session_coordinator_collaboration_send for remaining work; that send loads an offline member automatically. Do not call this as a prerequisite to collaboration work or read-only history: session_coordinator_read reads persisted history without reopening. If already live this is a no-op. Provider/model default to the target session previous config.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to resume (persisted log must exist).' },
      provider: { type: 'string', description: 'Optional provider override.' },
      model: { type: 'string', description: 'Optional model override.' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort override.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: (v.alreadyLive === true
          ? 'session ' + String(v.sessionId) + ' is already live'
          : 'resumed session ' + String(v.sessionId) + (typeof v.cwd === 'string' ? ' (cwd: ' + v.cwd + ')' : '')) }]
      },
    },
    async execute(args: ResumeArgs, exec) {
      requireCoordination(env.grants, (exec.agent as LiveAgentLike | undefined)?.id ?? '', 'resume', args.sessionId)
      return asJson(await resumeBridgeSession(env.ctx, env.registry, args))
    },
  }))
}

interface WaitArgsTool {
  requestId?: string
  sessionId: string
  sinceSeq?: number
  timeoutMs?: number
  requireTurnEnd?: boolean
  waitFor?: 'reply' | 'segment'
}

function registerWait(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_wait',
    description: 'With requestId from send, wait for the committed reply to that outgoing task owned by the calling session; this does not require a live target or assistant text and never falls back to old answers. After reload, only a complete owned two-sided delivery/reply record can return a read-only recovered result; missing/conflicting evidence fails explicitly without resuming or resending. Without requestId, wait for a session next assistant output: blocks (polling the session log) until a NEW assistant output appears after sinceSeq (default: the latest seq at call time). waitFor=reply returns as soon as a new assistant TEXT reply is readable; waitFor=segment returns as soon as any new COMPLETED output segment appears (an assistant/message step — text, reasoning, or tool-call turn), i.e. it does NOT wait for the whole turn, so you can observe the chain-of-thought/output paragraph by paragraph as it is produced. If no new output arrives within the budget, the latest PRE-EXISTING reply/segment is returned with stale=true (so an already-landed reply is never lost as "(no text)"). Returns the output summary, or timedOut/aborted when the deadline or caller cancellation ends the wait. Use it to consume output produced asynchronously by another session (e.g. a session you sent a message to, or one working on its own); to read a reply that may already exist, pass the sinceSeq anchor returned by send/create.',
    parameters: {
      requestId: { type: 'string', description: 'Task messageId returned by send. Selects correlated reply waiting; cannot combine with sinceSeq, waitFor or requireTurnEnd.' },
      sessionId: { type: 'string', required: true, description: 'Session id to wait on.' },
      sinceSeq: { type: 'number', description: 'Only replies after this event seq count (default: latest seq at call time; -1 = count every event, the anchor returned by create for a brand-new session).' },
      timeoutMs: { type: 'number', description: 'Wait budget in milliseconds (default 180000, max 3600000); timed out waits return the partial result instead of failing.' },
      requireTurnEnd: { type: 'boolean', description: 'When true, wait for the reply turn/end to settle before returning (default false; false returns as soon as the reply text is readable).' },
      waitFor: { type: 'string', enum: ['reply', 'segment'], description: 'reply (default) waits for a new assistant TEXT reply; segment waits for any new completed output segment (an assistant/message step, incl. reasoning/tool turns) and returns it immediately, without waiting for the whole turn.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const reply = v.reply as Record<string, unknown> | null | undefined
        if (reply === null || reply === undefined) return [{ type: 'text' as const, text: 'no reply observed' }]
        if (reply.kind === 'request-reply') return [{ type: 'text' as const, text: [reply.received === true ? String((reply.message as Record<string, unknown>).text) : 'no correlated reply received', ...waitNotes(reply)].join('\n') }]
        const message = (reply.message as Record<string, unknown> | null)
        const lines = [message === null
          ? 'no new reply within ' + String(reply.waitedMs ?? '?') + 'ms (no assistant text in this session)'
          : 'reply seq ' + String(reply.seq) + ': ' + String(message.text ?? '(no text)')]
        if (typeof reply.turnEnded === 'boolean') lines.push('turnEnded: ' + String(reply.turnEnded))
        lines.push(...waitNotes(reply))
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: WaitArgsTool, exec) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      if (args.requestId !== undefined) {
        if (typeof args.requestId !== 'string' || args.requestId.trim() === '') throw new Error('invalid requestId')
        if (args.sinceSeq !== undefined || args.waitFor !== undefined || args.requireTurnEnd !== undefined) throw new Error('requestId cannot be combined with text/turn waiting options')
        const reply = await env.delivery!.waitForRequest((exec.agent as LiveAgentLike | undefined)?.id ?? '', args.sessionId.trim(), args.requestId, clampTimeout(args.timeoutMs), exec.signal)
        return asJson({ sessionId: args.sessionId.trim(), reply })
      }
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live — call session_coordinator_resume first (waiting requires a live session)')
      }
      // 默认 baseline = 调用时刻的日志最大 seq（即工具描述承诺的 "latest seq at call
      // time"，两种 waitFor 模式统一）：只等待之后新出现的输出。既有回复不会被误当成
      // 新输出，但也绝不会被吞掉 —— waitForReply 在零新输出时会回落它并置 stale:true。
      // 调用方若要在"回复早已落地"之后再精确取回它，应传 send/create 返回的 sinceSeq 锚点。
      const baseline = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= -1
        ? args.sinceSeq
        : maxSeq(sessionEvents(agent.session))
      const result = await waitForReply({
        session: agent.session,
        baselineSeq: baseline,
        timeoutMs: clampTimeout(args.timeoutMs),
        signal: exec.signal,
        requireTurnEnd: args.requireTurnEnd === true,
        ...(args.waitFor === 'segment' ? { waitForSegment: true } : {}),
      })
      env.registry.touch(args.sessionId)
      return asJson({
        sessionId: args.sessionId,
        sinceSeq: baseline,
        reply: renderWait(result),
        running: agent.status === 'running',
      })
    },
  }))
}

interface SegmentsArgs {
  sessionId: string
  sinceSeq?: number
  limit?: number
}
function registerSegments(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_segments',
    description: 'Read the completed output segments of a session incrementally - each finished assistant step (one assistant/message paragraph), without waiting for the whole turn. Pass sinceSeq to page forward. Use this to watch a session produce its chain-of-thought / output paragraph by paragraph as each step finishes.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to read segments from (live or offline).' },
      sinceSeq: { type: 'number', description: 'Only return completed segments after this event seq (paging cursor).' },
      limit: { type: 'number', description: 'Maximum number of segments to return (default 10, max 50).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const segs = (v.segments as Array<Record<string, unknown>> | null) ?? []
        if (segs.length === 0) return [{ type: 'text' as const, text: '(no completed segments)' }]
        const lines = segs.map((sg) => {
          const head = 'seg #' + String(sg.seq) + ' (turn ' + String(sg.turn) + ' step ' + String(sg.step) + ')'
          const text = typeof sg.text === 'string' ? sg.text : ''
          const reason = typeof sg.reasoning === 'string' && sg.reasoning !== '' ? ' [reasoning ' + sg.reasoning.length + ' chars]' : ''
          const tools = Array.isArray(sg.toolCalls) && sg.toolCalls.length > 0 ? ' [tools: ' + sg.toolCalls.join(',') + ']' : ''
          return head + tools + reason + ': ' + text.slice(0, 160)
        })
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: SegmentsArgs) {
      const agent = liveAgent(env, args.sessionId)
      let events: readonly SessionEvent[]
      let live: boolean
      if (agent !== undefined) {
        events = sessionEvents(agent.session)
        live = true
      } else {
        try {
          const inspection = await inspectPersistedSession(env.ctx, args.sessionId)
          events = inspection.events
          live = false
        } catch (error) {
          throw new Error(String(error))
        }
      }
      const sinceSeq = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : 0
      const limit = clampLimit(args.limit, 10, 50)
      const segs = segmentsSince(events, sinceSeq)
      env.registry.touch(args.sessionId)
      const nextCursorSeq = segs.length === 0 ? sinceSeq : (segs[segs.length - 1]?.seq ?? sinceSeq)
      return asJson({
        sessionId: args.sessionId,
        live,
        nextCursorSeq,
        segments: segs.map((sg) => ({
          seq: sg.seq,
          time: sg.time,
          turn: sg.turn,
          step: sg.step,
          openTurn: sg.openTurn,
          ...(sg.text === undefined ? {} : { text: sg.text }),
          ...(sg.reasoning === undefined ? {} : { reasoning: sg.reasoning }),
          ...(sg.toolCalls.length > 0 ? { toolCalls: sg.toolCalls } : {}),
        })),
      })
    },
  }))
}

interface ReadArgs {
  sessionId: string
  sinceSeq?: number
  limit?: number
  role?: 'user' | 'assistant' | 'both'
  includeReasoning?: boolean
}

function registerRead(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_read',
    description: 'Read messages from any session — live or persisted (offline) — folding its event log into user/assistant text rows. By default returns the latest 20 messages; use limit for more (max 100) and sinceSeq to page forward from an event seq. role filters user/assistant rows; includeReasoning=false drops reasoning blocks.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to read (any session, even offline).' },
      sinceSeq: { type: 'number', description: 'Only return messages with seq greater than this value (paging).' },
      limit: { type: 'number', description: 'Number of most recent messages to return (default 20, max 100).' },
      role: { type: 'string', enum: ['user', 'assistant', 'both'], description: 'role filter (default both).' },
      includeReasoning: { type: 'boolean', description: 'Include assistant reasoning blocks (default true).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const messages = (v.messages as Array<Record<string, unknown>> | null) ?? []
        if (messages.length === 0) return [{ type: 'text' as const, text: '(no messages)' }]
        const lines = messages.map((m) => {
          const head = m.role === 'user' ? 'user' : 'assistant'
          const text = typeof m.text === 'string' ? m.text : '(no text)'
          return head + ' #' + String(m.seq) + ': ' + text
        })
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: ReadArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      let events: readonly SessionEvent[]
      let live: boolean
      let cwd: string | undefined
      if (agent !== undefined) {
        events = sessionEvents(agent.session)
        live = true
        cwd = agent.session.header.cwd
      } else {
        let inspection: { events: readonly SessionEvent[]; meta: { cwd?: string } }
        try {
          inspection = await inspectPersistedSession(env.ctx, args.sessionId)
        } catch (error) {
          throw new Error('cannot read session ' + JSON.stringify(args.sessionId) + ': ' + (error instanceof Error ? error.message : String(error)))
        }
        events = inspection.events
        live = false
        cwd = inspection.meta.cwd
      }
      let rows = foldMessages(events)
      if (args.role === 'user') rows = rows.filter((r) => r.role === 'user')
      if (args.role === 'assistant') rows = rows.filter((r) => r.role === 'assistant')
      if (args.includeReasoning === false) rows = rows.map((r) => ({ ...r, reasoning: undefined }))
      const sinceSeq = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : undefined
      if (sinceSeq !== undefined) rows = rows.filter((r) => r.seq > sinceSeq)
      const limit = clampLimit(args.limit, 20, 100)
      rows = rows.slice(-limit)
      const workspaceId = workspaceByPath(env.ctx, cwd)
      env.registry.touch(args.sessionId, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
      })
      return asJson({
        sessionId: args.sessionId,
        live,
        ...(cwd === undefined ? {} : { cwd }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        title: titleOf(events) ?? null,
        messages: rows.map((r) => ({
          seq: r.seq,
          time: r.time,
          role: r.role,
          ...(r.text === undefined ? {} : { text: r.text }),
          ...(r.reasoning === undefined ? {} : { reasoning: r.reasoning }),
          images: r.images,
          ...(r.toolCalls === undefined ? {} : { toolCalls: r.toolCalls }),
        })),
        nextSeq: maxSeq(events),
        totalEvents: events.length,
      })
    },
  }))
}

interface FindArgs {
  query?: string
  sessionId?: string
  title?: string
  workspaceId?: string
  cwd?: string
  liveOnly?: boolean
  running?: boolean
  archived?: boolean
  mainOnly?: boolean
  excludeSessionIds?: string[]
  cursor?: string
  limit?: number
}

function registerFind(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_find',
    description: 'Find sessions across all workspaces by name, id, project or directory. Also returns exact native @ references of the current human input, before any collaboration setup; these identify sessions and grant no send permission. For other running chats use running=true, archived=false, mainOnly=true and excludeSessionIds=[your id]; pass requireRunning=true when sending to that snapshot. For all nonarchived chats omit running/liveOnly. Follow nextCursor with the same filters until absent; complete=false means discovery is incomplete and must not be described as all chats. A changed result set invalidates the cursor: restart discovery before dispatching a group. Titles and aliases are not unique identities. Metadata discovery never wakes sessions.',
    parameters: {
      query: { type: 'string', description: 'Substring matched against session id, title, and cwd (case-insensitive).' },
      sessionId: { type: 'string', description: 'Only sessions whose id contains this substring.' },
      title: { type: 'string', description: 'Only sessions whose title contains this substring (offline titles resolved lazily).' },
      workspaceId: { type: 'string', description: 'Only sessions in this workspace id.' },
      cwd: { type: 'string', description: 'Only sessions whose cwd contains this substring (path or basename).' },
      liveOnly: { type: 'boolean', description: 'When true, only live sessions are returned (default false).' },
      running: { type: 'boolean', description: 'Filter actual running state, not just live/loaded. False includes idle and offline sessions.' },
      archived: { type: 'boolean', description: 'False: only nonarchived; true: only archived. Omitted preserves legacy inclusion of both.' },
      mainOnly: { type: 'boolean', description: 'Exclude child/subagent sessions from ordinary chat recipient sets.' },
      excludeSessionIds: { type: 'array', items: { type: 'string' }, description: 'Exact ids to exclude, e.g. the sender and explicit exceptions.' },
      cursor: { type: 'string', description: 'nextCursor from the previous page, with the same filters. Restart when the set changes.' },
      limit: { type: 'number', description: 'Maximum items (default 10, max 50).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const items = (v.items as Array<Record<string, unknown>> | null) ?? []
        const lines = items.map((item) => {
          const id = String(item.sessionId)
          const title = typeof item.title === 'string' ? item.title : '(untitled)'
          const state = item.live === true ? (item.running === true ? 'running' : 'idle') : 'offline'
          const cwd = typeof item.cwd === 'string' ? item.cwd : ''
          return state + (item.archived === true ? ' archived' : '') + ' ' + id + ' (' + title + ')' + (cwd === '' ? '' : ' @ ' + cwd)
        })
        if (lines.length === 0) lines.push('(no sessions found)')
        if (Array.isArray(v.nativeReferences) && v.nativeReferences.length > 0) lines.unshift('Native references (identity only, no send permission): ' + JSON.stringify(v.nativeReferences))
        if (v.complete === false) lines.unshift('INCOMPLETE discovery: ' + String((v.issues as string[]).join('; ')))
        if (typeof v.nextCursor === 'string') lines.push('More sessions: repeat the same filters with cursor=' + v.nextCursor)
        lines.push('matched: ' + String(v.total) + (v.complete === false ? ' (known matches only)' : ''))
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: FindArgs, exec) {
      const limit = clampLimit(args.limit, 10, 50)
      exec.signal?.throwIfAborted()
      if (args.excludeSessionIds !== undefined && (!Array.isArray(args.excludeSessionIds) || args.excludeSessionIds.some(id => typeof id !== 'string' || id.trim() === ''))) throw new Error('invalid excludeSessionIds')
      for (const key of ['running', 'archived', 'mainOnly', 'liveOnly'] as const) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error('invalid ' + key)
      let offset = 0, expectedFingerprint: string | undefined
      if (args.cursor !== undefined) {
        try {
          if (typeof args.cursor !== 'string' || args.cursor.length > 512) throw new Error()
          const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'))
          if (cursor.version !== 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1 || typeof cursor.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint)) throw new Error()
          offset = cursor.offset; expectedFingerprint = cursor.fingerprint
        } catch { throw new Error('invalid discovery cursor') }
      }
      const issues: string[] = []
      const archivedIds = env.ctx.workspaceRegistry.archivedSessionIds
      const archiveKnown = Array.isArray(archivedIds)
      const archived = new Set(archiveKnown ? archivedIds.map(String) : [])
      if (!archiveKnown) issues.push('archive state unavailable')
      const excluded = new Set(args.excludeSessionIds ?? [])
      const wsById = workspaceBySession(env.ctx)
      const items: BridgeFindItem[] = []
      for (const agent of liveAgents(env)) {
        const headerCwd = agent.session.header.cwd
        const wsId = wsById.get(agent.id) ?? workspaceByPath(env.ctx, headerCwd)
        items.push({
          sessionId: agent.id,
          title: titleOf(sessionEvents(agent.session)),
          ...(headerCwd === undefined ? {} : { cwd: headerCwd }),
          ...(wsId === undefined ? {} : { workspaceId: wsId }),
          live: true,
          running: agent.status === 'running',
          ...(agent.session.header.parentSession === undefined ? {} : { parentSession: agent.session.header.parentSession }),
          ...(agent.session.header.origin === undefined ? {} : { origin: agent.session.header.origin }),
          createdAt: agent.session.header.createdAt,
          ...(agent.session.header.agentPreset === undefined ? {} : { agentPreset: agent.session.header.agentPreset }),
        })
      }
      if (args.liveOnly !== true) {
        try {
          // dsh >= 0.1.5-alpha.1：list() 返回 { header: SessionHeader, revision, ... } 快照，
          // 不再平铺 id/cwd；旧版直接返回 header 平铺字段。两者都按新形状读，向下兼容。
          const persistence = env.ctx.sessionPersistence as unknown as { list(): Promise<readonly { header: { id: string; cwd?: string; parentSession?: string; origin?: 'subagent'; createdAt: number; agentPreset?: string } }[]> }
          for (const rec of await persistence.list()) {
            const header = rec.header
            if (items.some((item) => item.sessionId === header.id)) continue
            items.push({
              sessionId: header.id,
              ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
              ...(wsById.get(header.id) === undefined ? {} : { workspaceId: wsById.get(header.id) }),
              live: false,
              ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
              ...(header.origin === undefined ? {} : { origin: header.origin }),
              createdAt: header.createdAt,
              ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
            })
          }
        } catch (error) {
          issues.push('offline listing unavailable')
          console.warn('[dsh-session-coordinator] offline listing failed:', error instanceof Error ? error.message : String(error))
        }
      }
      let registryRecords: Array<{ sessionId: string; title?: string }> = []
      try { registryRecords = await env.registry.all() } catch { issues.push('session aliases unavailable') }
      const bridgeTitles = new Map<string, string>()
      for (const item of items) {
        const rec = registryRecords.find((r) => r.sessionId === item.sessionId)
        if (rec?.title !== undefined) {
          if (item.title === undefined) item.title = rec.title
          bridgeTitles.set(item.sessionId, rec.title)
        }
      }
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const idFilter = typeof args.sessionId === 'string' ? args.sessionId.trim().toLowerCase() : ''
      const titleFilter = typeof args.title === 'string' ? args.title.trim().toLowerCase() : ''
      const wsFilter = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
      const cwdFilter = typeof args.cwd === 'string' ? args.cwd.trim().toLowerCase() : ''
      const needsOfflineTitle = titleFilter !== '' || (query !== '' && items.some((item) => !item.live))
      if (needsOfflineTitle) {
        for (const item of items) {
          exec.signal?.throwIfAborted()
          if (item.live || item.title !== undefined) continue
          try {
            const inspection = await inspectPersistedSession(env.ctx, item.sessionId)
            item.title = titleOf(inspection.events)
          } catch {
            issues.push('title unavailable: ' + item.sessionId)
          }
        }
      }
      const filtered = items.filter((item) => {
        if (excluded.has(item.sessionId)) return false
        if (args.mainOnly === true && item.origin === 'subagent') return false
        if (args.running !== undefined && (item.running === true) !== args.running) return false
        if (args.archived !== undefined && (!archiveKnown || archived.has(item.sessionId) !== args.archived)) return false
        if (idFilter !== '' && !item.sessionId.toLowerCase().includes(idFilter)) return false
        if (titleFilter !== '') {
          const titles = ((item.title ?? '') + ' ' + (bridgeTitles.get(item.sessionId) ?? '')).toLowerCase()
          if (!titles.includes(titleFilter)) return false
        }
        if (wsFilter !== '' && item.workspaceId !== wsFilter) return false
        if (cwdFilter !== '' && !(item.cwd ?? '').toLowerCase().includes(cwdFilter)) return false
        if (query !== '') {
          const haystack = item.sessionId.toLowerCase() + ' ' + (item.title ?? '').toLowerCase() + ' ' + (item.cwd ?? '').toLowerCase() + ' ' + (bridgeTitles.get(item.sessionId) ?? '').toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      filtered.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1
        return (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.sessionId.localeCompare(b.sessionId)
      })
      exec.signal?.throwIfAborted()
      const filters = [query, idFilter, titleFilter, wsFilter, cwdFilter, args.liveOnly === true, args.running ?? null, args.archived ?? null, args.mainOnly === true, [...excluded].sort()]
      const fingerprint = createHash('sha256').update(JSON.stringify([filters, issues, filtered.map(item => [item.sessionId, item.title, item.live, item.running, archived.has(item.sessionId)])])).digest('hex')
      if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) throw new Error('discovery set changed; restart without cursor before dispatch')
      const nextOffset = offset + limit
      const caller = exec.agent as LiveAgentLike | undefined
      const input = caller && liveAgent(env, caller.id) === caller ? sessionEvents(caller.session).findLast(event => event.type === 'user/message' && event.data.source?.kind === 'user') : undefined
      const nativeReferences = input?.type === 'user/message' ? readNativeSessionReferences(caller!.session, input.data.id) : []
      return asJson({
        nativeReferences,
        items: filtered.slice(offset, nextOffset).map((item) => ({
          sessionId: item.sessionId,
          ...(item.title === undefined ? {} : { title: item.title }),
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          ...(item.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }),
          live: item.live,
          ...(archiveKnown ? { archived: archived.has(item.sessionId) } : {}),
          ...(item.running === undefined ? {} : { running: item.running }),
          ...(item.parentSession === undefined ? {} : { parentSession: item.parentSession }),
          ...(item.origin === undefined ? {} : { origin: item.origin }),
          ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
          ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
          ...(item.agentPreset === undefined ? {} : { agentPreset: item.agentPreset }),
        })),
        total: filtered.length,
        truncated: nextOffset < filtered.length,
        complete: issues.length === 0,
        issues,
        ...(nextOffset < filtered.length ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, offset: nextOffset, fingerprint })).toString('base64url') } : {}),
      })
    },
  }))
}

/**
 * 工具注册表：**加一个工具的唯一入口**。
 *
 * 加工具的完整动作 = 写一个 `registerXxx(env)` + 往这张表加一行 + 在
 * `dsh.plugin.json` 的 `contributes.tools` 加名字（那份是给市场和插件清单看的
 * 元数据；漏了会被 `pnpm smoke` 当场判死，不会静默漂移）。
 *
 * 之前这 12 行是手写调用，加工具要读 `registerBridgeTools` 找插入位置；
 * 现在顺序就是表的顺序，谁也不用再改函数体。
 */
const BRIDGE_TOOL_REGISTRARS: ReadonlyArray<(env: BridgeEnv) => void> = [
  registerCreate,
  registerSend,
  registerResume,
  registerWait,
  registerSegments,
  registerRead,
  registerFind,
  registerStatus,
  registerCancel,
  registerMonitor,
  registerArchive,
  // 只读回执查询（#5）走 ctx 而不是 env：它是自包含模块，不碰 registry / monitor。
  (env) => registerReceipt(env.ctx),
  (env) => { registerCollaborationMaterialTools(env, installCollaboration(env)) },
]

/** 注册全部工具（顺序即 {@link BRIDGE_TOOL_REGISTRARS} 的顺序）。 */
export function registerBridgeTools(env: BridgeEnv): void {
  env.delivery ??= new SessionDelivery(env.ctx, env.registry, env.grants)
  for (const register of BRIDGE_TOOL_REGISTRARS) register(env)
}

interface MonitorStartArgs {
  sessionId: string
  intervalMs?: number
  stalledMs?: number
  maxStuckCycles?: number
  doneKeywords?: string[]
  useLlm?: boolean
  onStallSteer?: string
  onOffTrackSteer?: string
  label?: string
  coRules?: Array<{ match?: string; field?: string; value?: string; action?: string; message?: string }>
  cotMinHits?: number
  loopGuard?: boolean
  loopField?: string
  loopMinCycles?: number
  loopMinRepeats?: number
  loopMinConfidence?: number
  loopMinHits?: number
  loopCooldownMs?: number
  loopMaxTransfers?: number
  loopTransfer?: boolean
  loopAutoMonitor?: boolean
  loopDescendants?: string
  loopHandoffPrompt?: string
  loopTransferDepth?: number
}

/** 校验并规范化 coRules 参数为 CoTRule[]；非法项抛清晰错误。 */
function parseCoRules(raw: Array<{ match?: string; field?: string; value?: string; action?: string; message?: string }>): CoTRule[] {
  return raw.map((rule, index) => {
    const match = rule.match === 'contains' || rule.match === 'not-contains' ? rule.match : (() => { throw new Error('coRules[' + index + '].match must be "contains" or "not-contains"') })()
    const field = rule.field === 'reasoning' || rule.field === 'text' || rule.field === 'both' ? rule.field : (() => { throw new Error('coRules[' + index + '].field must be "reasoning", "text" or "both"') })()
    const action = rule.action === 'steer' || rule.action === 'cancel' ? rule.action : (() => { throw new Error('coRules[' + index + '].action must be "steer" or "cancel"') })()
    const value = typeof rule.value === 'string' && rule.value.trim() !== '' ? rule.value.trim() : (() => { throw new Error('coRules[' + index + '].value must be a non-empty string') })()
    return {
      match,
      field,
      action,
      value,
      ...(typeof rule.message === 'string' && rule.message.trim() !== '' ? { message: rule.message.trim() } : {}),
    }
  })
}

function renderMonitorState(entry: MonitorEntryState, policy?: LoopPolicy): string[] {
  const lines: string[] = []
  lines.push(`monitoring ${entry.config.sessionId}${entry.config.label === undefined ? '' : ' ("' + entry.config.label + '")'}`)
  lines.push(`interval: ${entry.config.intervalMs}ms | stalled: ${String(entry.config.stalledMs ?? 60000)}ms | maxStuck: ${String(entry.config.maxStuckCycles ?? 3)}`)
  lines.push(`cycles: ${entry.cycles} | stuck: ${entry.stuckCount} | lastAction: ${entry.lastAction}`)
  const cotCount = (entry.config.coTRules ?? []).length
  if (cotCount > 0) lines.push(`coRules: ${cotCount} rule(s) (minHits ${String(entry.config.cotMinHits ?? 1)})`)
  if (entry.config.loopGuard === false) {
    lines.push('loopGuard: off (this monitor only)')
  } else if (policy !== undefined && !policy.enabled()) {
    lines.push('loopGuard: off (plugin switch — /cot-loop on, or Settings → Plugins → dsh-session-coordinator)')
  } else {
    const loopState = entry.loop
    const transfers = loopState === undefined ? [] : loopState.transfers
    const depth = entry.config.loopTransferDepth ?? 0
    const path = transfers.length === 0 ? '' : ' (' + transfers.map((t) => t.from + ' → ' + t.to).join(', ') + ')'
    lines.push(`loopGuard: on field=${entry.config.loopField ?? 'reasoning'} ${String(entry.config.loopMinCycles ?? 2)}x${String(entry.config.loopMinRepeats ?? 3)} conf>=${String(entry.config.loopMinConfidence ?? 0.6)} descendants=${entry.config.loopDescendants ?? 'report'}${depth === 0 ? '' : ' depth=' + String(depth)}`
      + ` | transfers: ${transfers.length}${path}, subagent cancels: ${String(loopState === undefined ? 0 : loopState.subagentCancels)}`)
  }
  if (entry.lastNote !== '') lines.push(`note: ${entry.lastNote}`)
  if (entry.done) lines.push('done: yes')
  return lines
}

function registerMonitor(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_monitor_start',
    description: 'Start a background watchdog on a main session: poll its progress at an interval, and automatically schedule — steer the session when it stalls (or, with useLlm, when it drifts off-track), cancel it when it stays stuck past maxStuckCycles, and stop when a done keyword appears while idle. It can also enforce chain-of-thought rules via coRules: e.g. coRules=[{match:"not-contains",field:"reasoning",value:"I\'m",action:"cancel"}] stops the session the moment its live reasoning stops containing I\'m (evaluated on each poll while running). This is the "monitor worker" that watches a main task thread and corrects/stops it. Uses session_coordinator_status-style facts; pass sessionId of a live session. Returns the watchdog state.'
      + ' It also detects chain-of-thought LOOPS by default — the same content repeated over and over (e.g. "写。好。Go。写。好。Go。写。好。Go。"). A stall check cannot catch this (every cycle lands new events, so the target never looks stalled), so on a loop the watchdog interrupts the session and TRANSFERS the task to a new session, which receives a handoff prompt (original session id, task, recent context, and the descendant list) and is watched by default. Subagents: still-running descendants are left running and listed in the handoff (default loopDescendants="report" — never cancelled), loopDescendants="stop" cancels them before transferring, "ignore" drops them. A subagent session that loops is only cancelled, never transferred (that would break the execution tree). Knobs: loopGuard, loopField (reasoning|text|both), loopMinCycles, loopMinRepeats, loopMinConfidence, loopMinHits, loopCooldownMs, loopMaxTransfers (default 3, also the transfer-depth cap), loopTransfer, loopAutoMonitor, loopDescendants, loopHandoffPrompt, loopTransferDepth. A PLUGIN-LEVEL switch (config field loopGuard, toggled with the /cot-loop slash command or Settings → Plugins → dsh-session-coordinator) disables loop detection for every monitor at once; passing loopGuard=false here does the same for this monitor alone.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target main session id to watch (must be live).' },
      intervalMs: { type: 'number', description: 'Poll interval in ms (default 10000, min 5000).' },
      stalledMs: { type: 'number', description: 'Treat as stalled when no event for this many ms (default 60000).' },
      maxStuckCycles: { type: 'number', description: 'Cancel the session after this many consecutive stall ticks (default 3).' },
      doneKeywords: { type: 'array', items: { type: 'string' }, description: 'Any of these strings in the reply (while idle) marks the task done and stops the watchdog.' },
      useLlm: { type: 'boolean', description: 'When true, use the LLM to also detect off-track (default false, rules only).' },
      onStallSteer: { type: 'string', description: 'Steer text injected on a stall/nudge (default: ask to summarize progress and continue).' },
      onOffTrackSteer: { type: 'string', description: 'Steer text injected when LLM judges the task off-track (default: ask to return to the original goal).' },
      label: { type: 'string', description: 'Optional human label for logs/display.' },
      coRules: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        match: { type: 'string', required: true, enum: ['contains', 'not-contains'], description: 'contains = must include value in the chosen field; not-contains = must NOT include it.' },
        field: { type: 'string', required: true, enum: ['reasoning', 'text', 'both'], description: 'Match on reasoning (chain-of-thought), text (reply), or both (either).' },
        value: { type: 'string', required: true, description: 'The substring to match (non-empty).' },
        action: { type: 'string', required: true, enum: ['steer', 'cancel'], description: 'steer injects a guiding message; cancel terminates the session.' },
        message: { type: 'string', description: 'Custom steer text (default is a guidance prompt).' },
      } }, description: 'Chain-of-thought rules: when a rule stays matched for cotMinHits consecutive polls (default 1), trigger its action. Example: [{match:"not-contains",field:"reasoning",value:"I\'m",action:"cancel"}] stops the session the moment its live reasoning no longer contains I\'m.' },
      cotMinHits: { type: 'number', description: 'How many consecutive matched polls before a CoT rule fires (default 1 = immediately).' },
      loopGuard: { type: 'boolean', description: 'Chain-of-thought LOOP detection with automatic task transfer: false disables it (default true).' },
      loopField: { type: 'string', enum: ['reasoning', 'text', 'both'], description: 'Which field to scan for loops (default reasoning = live chain-of-thought).' },
      loopMinCycles: { type: 'number', description: 'Minimum number of repeated cycles (default 2).' },
      loopMinRepeats: { type: 'number', description: 'Minimum repeats of the unit (default 3); the effective floor is max(loopMinCycles, loopMinRepeats).' },
      loopMinConfidence: { type: 'number', description: 'Confidence threshold 0..1 (default 0.6).' },
      loopMinHits: { type: 'number', description: 'Consecutive polls with the same loop signature before firing (default 1 = first hit).' },
      loopCooldownMs: { type: 'number', description: 'Cooldown in ms before the same signature may fire again (default max(intervalMs*2, 30000)).' },
      loopMaxTransfers: { type: 'number', description: 'Max task transfers (default 3); also the transfer-depth cap.' },
      loopTransfer: { type: 'boolean', description: 'When false a detected loop only cancels the session (default true = transfer the task to a new session).' },
      loopAutoMonitor: { type: 'boolean', description: 'When false the newly created successor session is not watched (default true).' },
      loopDescendants: { type: 'string', enum: ['report', 'stop', 'ignore'], description: 'Subagent policy: report (default) lists running subagents in the handoff and leaves them running; stop cancels them before transferring; ignore drops them entirely.' },
      loopHandoffPrompt: { type: 'string', description: 'Custom handoff prompt template. Placeholders: {{sessionId}} {{cwd}} {{reason}} {{task}} {{evidence}} {{descendants}}.' },
      loopTransferDepth: { type: 'number', description: 'Current transfer depth (internal; the watchdog passes depth+1 to the successor session).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const entry = v.monitor as MonitorEntryState | null
        if (entry === null || entry === undefined) return [{ type: 'text' as const, text: 'monitor not started' }]
        return [{ type: 'text' as const, text: renderMonitorState(entry, env.policy).join('\n') }]
      },
    },
    async execute(args: MonitorStartArgs, exec) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      requireCoordination(env.grants, (exec.agent as LiveAgentLike | undefined)?.id ?? '', 'monitor_start', args.sessionId.trim())
      const config: MonitorConfig = {
        coordinatorId: (exec.agent as LiveAgentLike).id,
        sessionId: args.sessionId.trim(),
        intervalMs: typeof args.intervalMs === 'number' && args.intervalMs >= 5000 ? Math.floor(args.intervalMs) : 10000,
        ...(typeof args.stalledMs === 'number' && args.stalledMs > 0 ? { stalledMs: Math.floor(args.stalledMs) } : {}),
        ...(typeof args.maxStuckCycles === 'number' && args.maxStuckCycles >= 1 ? { maxStuckCycles: Math.floor(args.maxStuckCycles) } : {}),
        doneKeywords: Array.isArray(args.doneKeywords) ? args.doneKeywords.filter((k) => typeof k === 'string' && k.trim() !== '') : [],
        ...(args.useLlm === true ? { useLlm: true } : {}),
        ...(typeof args.onStallSteer === 'string' && args.onStallSteer.trim() !== '' ? { onStallSteer: args.onStallSteer.trim() } : {}),
        ...(typeof args.onOffTrackSteer === 'string' && args.onOffTrackSteer.trim() !== '' ? { onOffTrackSteer: args.onOffTrackSteer.trim() } : {}),
        ...(typeof args.label === 'string' && args.label.trim() !== '' ? { label: args.label.trim() } : {}),
        ...(Array.isArray(args.coRules) && args.coRules.length > 0 ? { coTRules: parseCoRules(args.coRules) } : {}),
        ...(typeof args.cotMinHits === 'number' && Number.isInteger(args.cotMinHits) && args.cotMinHits >= 1 ? { cotMinHits: Math.floor(args.cotMinHits) } : {}),
        ...(args.loopGuard === false ? { loopGuard: false } : {}),
        ...(args.loopField === 'reasoning' || args.loopField === 'text' || args.loopField === 'both' ? { loopField: args.loopField } : {}),
        ...(typeof args.loopMinCycles === 'number' ? { loopMinCycles: Math.floor(args.loopMinCycles) } : {}),
        ...(typeof args.loopMinRepeats === 'number' ? { loopMinRepeats: Math.floor(args.loopMinRepeats) } : {}),
        ...(typeof args.loopMinConfidence === 'number' ? { loopMinConfidence: args.loopMinConfidence } : {}),
        ...(typeof args.loopMinHits === 'number' ? { loopMinHits: Math.floor(args.loopMinHits) } : {}),
        ...(typeof args.loopCooldownMs === 'number' ? { loopCooldownMs: Math.floor(args.loopCooldownMs) } : {}),
        ...(typeof args.loopMaxTransfers === 'number' ? { loopMaxTransfers: Math.floor(args.loopMaxTransfers) } : {}),
        loopTransfer: false,
        ...(args.loopAutoMonitor === false ? { loopAutoMonitor: false } : {}),
        ...(args.loopDescendants === 'report' || args.loopDescendants === 'stop' || args.loopDescendants === 'ignore' ? { loopDescendants: args.loopDescendants } : {}),
        ...(typeof args.loopHandoffPrompt === 'string' && args.loopHandoffPrompt.trim() !== '' ? { loopHandoffPrompt: args.loopHandoffPrompt } : {}),
        ...(typeof args.loopTransferDepth === 'number' ? { loopTransferDepth: Math.floor(args.loopTransferDepth) } : {}),
      }
      const entry = env.monitor.start(config)
      env.registry.touch(args.sessionId)
      return asJson({ sessionId: args.sessionId, monitor: { ...entry, config: { ...entry.config } } })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_monitor_stop',
    description: 'Stop the background watchdog on a session (keep the session itself running). Returns whether a watchdog was active and stopped.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: (v.wasActive === true ? 'stopped monitor ' : 'no active monitor ') + String(v.sessionId) }]
      },
    },
    async execute(args: { sessionId: string }, exec) {
      requireCoordination(env.grants, (exec.agent as LiveAgentLike | undefined)?.id ?? '', 'monitor_stop', args.sessionId?.trim())
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const wasActive = env.monitor.stop(args.sessionId.trim())
      return asJson({ sessionId: args.sessionId, wasActive })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_monitor_list',
    description: 'List all active watchdogs started via session_coordinator_monitor_start, with their poll interval, stall threshold, stuck count, last action, and done status.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const entries = (v.monitors as MonitorEntryState[] | null) ?? []
        if (entries.length === 0) return [{ type: 'text' as const, text: '(no active monitors)' }]
        return [{ type: 'text' as const, text: entries.map((e) => renderMonitorState(e, env.policy).join('\n')).join('\n---\n') }]
      },
    },
    async execute() {
      const monitors = env.monitor.list().map((e) => ({ ...e, config: { ...e.config } }))
      return asJson({ monitors })
    },
  }))
}

type StatusReasoning = 'none' | 'last' | 'live' | 'tail'

interface StatusArgs {
  sessionId: string
  stalledMsThreshold?: number
  recent?: number
  reasoning?: StatusReasoning
}

/** 按 reasoning 选项裁剪快照里的思维链字段（避免入 token 时有 diff 语义差）。 */
function pruneReasoning(snapshot: BridgeStatusSnapshot, mode: StatusReasoning): BridgeStatusSnapshot {
  if (mode === 'tail') return snapshot
  const rest: BridgeStatusSnapshot = { ...snapshot }
  delete (rest as { reasoningTail?: unknown }).reasoningTail
  if (mode === 'none') {
    delete (rest as { lastReasoning?: unknown }).lastReasoning
    delete (rest as { liveReasoning?: unknown }).liveReasoning
  } else if (mode === 'last') {
    delete (rest as { liveReasoning?: unknown }).liveReasoning
  } else { // 'live'
    delete (rest as { lastReasoning?: unknown }).lastReasoning
  }
  return rest
}

/**
 * 渲染监控快照为一行摘要：运行态 + openTurn + 卡住/待处理 + 最新回复(+ 思维链预览)。
 * 卡住判定走 core.isStalled（唯一真源）：只有 running 会话才可能被标 [STALLED] ——
 * 空闲/已收尾的会话"很久没事件"是正常状态，不是卡住（与监控 watchdog 一致）。
 */
function renderStatus(snapshot: BridgeStatusSnapshot, stalledMsThreshold: number): string[] {
  const lines: string[] = []
  const runLabel = snapshot.running === 'running' ? 'running' : 'idle'
  lines.push(`${runLabel} ${snapshot.sessionId}${snapshot.title === undefined ? '' : ` ("${snapshot.title}")`}`)
  if (snapshot.openTurn) lines.push(`openTurn: yes (turn #${snapshot.lastTurn})`)
  else lines.push(`openTurn: no (last turn #${snapshot.lastTurn})`)
  if (snapshot.stalledMs !== null) {
    const stalled = isStalled(snapshot.running, snapshot.stalledMs, stalledMsThreshold)
    lines.push(`lastActivity: now-${snapshot.stalledMs}ms${stalled ? ' [STALLED]' : ''}`)
  }
  if (snapshot.pendingWork) lines.push(`pendingWork: ${snapshot.nextTurnCount} turn + ${snapshot.nextStepCount} step`)
  if (snapshot.lastAssistantText !== undefined) lines.push(`lastReply: ${snapshot.lastAssistantText}`)
  if (snapshot.reasoningTail !== undefined && snapshot.reasoningTail !== '') {
    const preview = snapshot.reasoningTail.length > 160 ? snapshot.reasoningTail.slice(0, 160) + '…' : snapshot.reasoningTail
    lines.push(`reasoning: ${preview}`)
  }
  return lines
}

function registerStatus(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_status',
    description: 'Inspect a session\'s live progress for monitoring/scheduling. Returns running/idle, whether a turn is open, last turn number, time since the last event (for stall detection), pending queued work, and the latest text reply. It also surfaces the session\'s chain-of-thought: lastReasoning is the most recent finalized reasoning block, liveReasoning is the in-flight reasoning streamed for the current handled turn (reasoning-delta), and reasoningTail is a compact merged preview. reasoning=none drops all three to keep tokens small. When stalledMsThreshold is given, marks a RUNNING session as stalled once the time since the last event exceeds it (idle sessions are never flagged — a quiet finished session is not stuck). Live chat execution only. For persistent collaboration task progress or restart recovery use session_coordinator_collaboration_status, which also covers offline members; use session_coordinator_read for offline history. Neither requires standalone resume. Use this live snapshot for authorized whole-session monitoring, not as a prerequisite to collaboration task control or dispatch.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to inspect (must be live).' },
      stalledMsThreshold: { type: 'number', description: 'Mark a RUNNING session STALLED when time since the last event exceeds this many ms (default 60000); idle sessions are never marked.' },
      recent: { type: 'number', description: 'Number of recent messages to include in the snapshot (default 8, max 20).' },
      reasoning: { type: 'string', enum: ['none', 'last', 'live', 'tail'], description: 'Which chain-of-thought fields to include: tail (default) returns lastReasoning/liveReasoning/reasoningTail; last only the finalized reasoning; live only the in-flight reasoning; none drops all reasoning fields.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const snapshot = v.snapshot as BridgeStatusSnapshot | null
        if (snapshot === null || snapshot === undefined) return [{ type: 'text' as const, text: 'session unavailable' }]
        const threshold = typeof v.stalledMsThreshold === 'number' ? v.stalledMsThreshold : 60000
        return [{ type: 'text' as const, text: renderStatus(snapshot, threshold).join('\n') }]
      },
    },
    async execute(args: StatusArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live. Use session_coordinator_collaboration_status for persistent task/scope state or session_coordinator_read for persisted history; neither requires reopening. Collaboration work loads the member through collaboration_send after approved scope/task resume. Standalone session monitoring requires its separate target grant and session_coordinator_resume')
      }
      const threshold = typeof args.stalledMsThreshold === 'number' && Number.isFinite(args.stalledMsThreshold) && args.stalledMsThreshold >= 0 ? args.stalledMsThreshold : 60000
      const reasoningMode: StatusReasoning = args.reasoning === 'none' || args.reasoning === 'last' || args.reasoning === 'live' ? args.reasoning : 'tail'
      const snapshot = pruneReasoning(statusSnapshot(env.ctx, agent), reasoningMode)
      const shown = typeof args.recent === 'number' && Number.isInteger(args.recent) && args.recent >= 0 ? Math.min(args.recent, 20) : 8
      const envCwd = agent.session.header.cwd
      env.registry.touch(args.sessionId, {
        ...(envCwd === undefined ? {} : { cwd: envCwd }),
        ...(workspaceByPath(env.ctx, envCwd) === undefined ? {} : { workspaceId: workspaceByPath(env.ctx, envCwd) }),
      })
      return asJson({
        sessionId: args.sessionId,
        stalledMsThreshold: threshold,
        snapshot: {
          ...snapshot,
          recent: snapshot.recent.slice(-shown).map((row) => ({ ...row })),
        },
      })
    },
  }))
}

interface CancelArgs {
  sessionId: string
  keepInbox?: boolean
  cause?: string
}

function registerCancel(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_cancel',
    description: 'Legacy WHOLE-SESSION management: abort the entire active turn of a live chat, including unrelated tasks in that turn; by default also clear all queued work. Requires a target-specific /coordinate grant. Use only when the user explicitly wants to stop that whole chat or for its authorized session-level monitor. To stop, pause or resume a task inside a collaboration, use session_coordinator_collaboration_control with scopeId and taskId instead. To close a collaboration scope use that control without taskId. This tool does not control collaboration task/scope state.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to cancel (must be live).' },
      keepInbox: { type: 'boolean', description: 'Preserve queued/steering input instead of clearing it (default false, i.e. clear pending work).' },
      cause: { type: 'string', description: 'Optional stable reason recorded for the cancellation.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: 'cancelled ' + String(v.sessionId) + ' (running: ' + String(v.running) + (v.keepInbox === true ? ', inbox kept' : ', inbox cleared') + ')' }]
      },
    },
    async execute(args: CancelArgs, exec) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      requireCoordination(env.grants, (exec.agent as LiveAgentLike | undefined)?.id ?? '', 'cancel', args.sessionId.trim())
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live — call session_coordinator_resume first (cancel requires a live session)')
      }
      const cause = typeof args.cause === 'string' && args.cause.trim() !== ''
        ? { kind: 'hook', reason: args.cause.trim() }
        : { kind: 'user' }
      agent.cancel(cause, { keepInbox: args.keepInbox === true })
      const snapshot = statusSnapshot(env.ctx, agent)
      const envCwd = agent.session.header.cwd
      env.registry.touch(args.sessionId, {
        ...(envCwd === undefined ? {} : { cwd: envCwd }),
        ...(workspaceByPath(env.ctx, envCwd) === undefined ? {} : { workspaceId: workspaceByPath(env.ctx, envCwd) }),
      })
      return asJson({
        sessionId: args.sessionId,
        running: agent.status,
        keepInbox: args.keepInbox === true,
        snapshot,
      })
    },
  }))
}

interface ArchiveArgs {
  sessionId: string
  stopActivity?: boolean
}

/** How many archived ids a tool result echoes before it summarizes the rest. */
const ARCHIVE_ECHO_LIMIT = 20

/**
 * 紧凑渲染归档集合：归档集合会无限增长（真实宿主里已有 200+ 个），而每次
 * archive/unarchive 都把整集合回显到工具结果里，会把真正的结果埋进数千 token
 * 的 id 列表里（实测单次约 4k token）。这里只回显最新的一段，`total` 始终给出
 * 准确规模；需要完整列表时用 `session_coordinator_archived`（可传 limit）。
 */
function renderArchived(ids: readonly string[]): string {
  const total = 'total archived: ' + String(ids.length)
  if (ids.length === 0) return total + ' (empty)'
  const shown = ids.slice(-ARCHIVE_ECHO_LIMIT)
  const omitted = ids.length - shown.length
  return total + '\nmost recent: ' + shown.join(', ') + (omitted > 0 ? ' … (+' + String(omitted) + ' earlier omitted)' : '')
}

function registerArchive(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_archive',
    description: 'Archive one session: add it to the workspace registry\'s global archive set so it is hidden from every grouping surface in the UI (Un/grouped, workspaces) while its session history and workspace position are preserved. Mirrors the workspace controller archiveSession. The session must exist (live or in session persistence) and, without stopActivity, must be inactive — otherwise the archive is refused with "the session is active". Returns the affected session id and the resulting archive size (the newest ids only; use session_coordinator_archived for a listing).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to archive.' },
      stopActivity: { type: 'boolean', description: 'When true, stop the session\'s running work (turn, subagents, jobs, schedules) instead of refusing the archive because work is active (default false). The archive is written first and the stops are requested afterwards, exactly like the UI archive action.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const note = v.stopActivity === true ? ' (stopped running work)' : ''
        return [{ type: 'text' as const, text: 'archived ' + String(v.sessionId) + note + '\n' + renderArchived((v.archivedSessionIds as string[] | undefined) ?? []) }]
      },
    },
    async execute(args: ArchiveArgs, exec) {
      requireCoordination(env.grants, (exec.agent as LiveAgentLike | undefined)?.id ?? '', 'archive', args.sessionId?.trim())
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const sessionId = args.sessionId.trim()
      const stopActivity = args.stopActivity === true
      try {
        // `stopActivity` is the official escape hatch for a session whose work is
        // still running: without it the registry refuses the archive with
        // WorkspaceActiveSessionError, which made archiving a live target
        // impossible through the bridge.
        await env.ctx.workspaceRegistry.archiveSession(sessionId as SessionId, stopActivity ? { stopActivity: true } : undefined)
      } catch (error) {
        const hint = stopActivity ? '' : ' (pass stopActivity: true to archive it anyway and stop its running work)'
        throw new Error('cannot archive session ' + JSON.stringify(sessionId) + ': ' + (error instanceof Error ? error.message : String(error)) + hint)
      }
      const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      return asJson({ sessionId, stopActivity, archivedSessionIds: archived, totalArchived: archived.length })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_unarchive',
    description: 'Unarchive one session: drop it from the workspace registry\'s global archive set so it is visible again on every grouping surface at its recorded position (its workspace accounting is never touched by archiving, so the slot is still there). Mirrors the workspace controller unarchiveSession. An unknown or not-archived id is an idempotent no-op. Returns the affected session id and the resulting archive size (the newest ids only; use session_coordinator_archived for a listing).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to unarchive.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: 'unarchived ' + String(v.sessionId) + '\n' + renderArchived((v.archivedSessionIds as string[] | undefined) ?? []) }]
      },
    },
    async execute(args: ArchiveArgs, exec) {
      requireCoordination(env.grants, (exec.agent as LiveAgentLike | undefined)?.id ?? '', 'unarchive', args.sessionId?.trim())
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const sessionId = args.sessionId.trim()
      try {
        await env.ctx.workspaceRegistry.unarchiveSession(sessionId as SessionId)
      } catch (error) {
        throw new Error('cannot unarchive session ' + JSON.stringify(sessionId) + ': ' + (error instanceof Error ? error.message : String(error)))
      }
      const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      return asJson({ sessionId, archivedSessionIds: archived, totalArchived: archived.length })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_archived',
    description: 'List the session ids currently in the workspace registry archive set (hidden from groupings). Optionally resolve titles from the session log. The newest `limit` ids are returned (default 50, max 500) because the archive set grows without bound; `total` always reports the real size. Read-only.',
    parameters: {
      resolveTitles: { type: 'boolean', description: 'When true, resolve each archived session\'s title from its log (default false). Titles are resolved only for the returned ids.' },
      limit: { type: 'number', description: 'Maximum ids to return, taken from the newest end of the archive set (default 50, max 500).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const items = (v.items as Array<{ sessionId: string; title?: string }> | null) ?? []
        if (items.length === 0) return [{ type: 'text' as const, text: '(no archived sessions)' }]
        const total = typeof v.total === 'number' ? v.total : items.length
        const lines = items.map((i) => i.sessionId + (i.title === undefined ? '' : ' ("' + i.title + '")'))
        if (items.length < total) lines.unshift(String(total) + ' archived; newest ' + String(items.length) + ':')
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: { resolveTitles?: boolean; limit?: number }) {
      const limit = clampLimit(args.limit, 50, 500)
      const all = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      // 最新在尾部：截尾返回最新的一段，与 archive/unarchive 的回显方向一致。
      const archived = all.slice(-limit)
      if (args.resolveTitles !== true || archived.length === 0) {
        return asJson({ items: archivedEntries(archived, new Map()), returned: archived.length, total: all.length })
      }
      // 标题来源优先级：bridge 登记表里的别名 > 会话日志里的标题/首条用户消息。
      // 解析不出来的会话就**不带** title 字段返回（绝不写 undefined —— 那会让整个
      // 工具返回值不再是 lossless JSON，宿主会拒绝它，标题缺失不该升级成整体失败）。
      // 只解析返回的这段 id：集合可能有几百个，逐个读日志会拖垮工具调用。
      const titles = new Map<string, string | undefined>()
      try {
        const records = await env.registry.all()
        for (const rec of records) if (rec.title !== undefined) titles.set(rec.sessionId, rec.title)
      } catch { /* best-effort */ }
      for (const sessionId of archived) {
        if (titles.get(sessionId) !== undefined) continue
        try {
          const inspection = await inspectPersistedSession(env.ctx, sessionId)
          titles.set(sessionId, titleOf(inspection.events))
        } catch { /* offline title unavailable */ }
      }
      return asJson({ items: archivedEntries(archived, titles), returned: archived.length, total: all.length })
    },
  }))
}

