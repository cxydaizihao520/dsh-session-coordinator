/** Lossy diagnostics only: never an authority, replay source or model-visible message. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { appendPluginRecord, pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { getLiveAgent, type LiveAgentLike } from './core.ts'
import { ownEvents } from './coordination-records.ts'

const pluginVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const RECORD = 'plugin:dsh-session-coordinator/diagnostic'
const processId = randomUUID()
const observing = new WeakSet<Context>()
const included = new WeakMap<Session, Set<string>>()
const context = new AsyncLocalStorage<Record<string, JsonValue>>()
const pending = new WeakMap<Session, Promise<void>>()
const persistence = new WeakMap<Session, 'flushed' | 'unavailable'>()
const warned = new WeakSet<Session>()
const queued = new WeakMap<Session, number>()
const dropped = new WeakMap<Session, number>()
const categories: Record<string, readonly string[]> = {
  reason: ['legacy-terminal','invalid-parent','reply-consumed','authorization-denied','budget-exhausted','identity-or-revision','wrong-entry-or-source','target-unavailable','scope-or-task-stopped','unclassified-error','command-rejected'],
  protocol: ['persistent','information','legacy-single'],
  stage: ['attempt','returned','failed','cancelled','hop-check','submit-started','accepted','transport-returned','native-history','native-claim','model-inclusion'],
  delivery: ['not-sent','unknown','not-confirmed','accepted','accepted-before-error','appended','claimed','model-request'],
  mode: ['context','queue','steer'], intent: ['information','task','context','steer','result'],
  action: ['pause','resume','revise','finish','cancel','block','fail','revalidate','question','edit','withdraw'],
  state: ['active','paused','blocked','budget-exhausted','usage-limited','recovery-required','completed','cancelled','failed','prepared','submitted','claimed','admitted','rejected','scheduled','withdrawn'],
}
const stringFields = ['attemptId', 'callId', 'tool', 'stage', 'reason', 'delivery', 'mode', 'intent', 'action', 'state', 'sessionId', 'senderSessionId', 'ownerSessionId', 'scopeId', 'taskId', 'operationId', 'messageId', 'rootMessageId', 'replyTo', 'requestId', 'resultId', 'errorCode', 'protocol', 'targetSessionId']
const numberFields = ['taskRevision', 'hopCount', 'parentHop', 'attemptedHop', 'hopLimit', 'sinceSeq', 'durationMs', 'maxOperations', 'maxNoProgress', 'maxElapsedMs', 'maxObservedTokens', 'observedTokens', 'operationCount', 'noProgress']
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-session-coordinator/diagnostic': JsonValue }
}
function fields(value: unknown): Record<string, JsonValue> {
  const row = value as Record<string, unknown> | null | undefined, clean: Record<string, JsonValue> = {}
  if (!row || typeof row !== 'object') return clean
  for (const key of stringFields) {
    const value = row[key]
    if (typeof value !== 'string') continue
    if (categories[key] ? categories[key].includes(value) : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) clean[key] = value
  }
  for (const key of numberFields) if (typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0) clean[key] = row[key]
  if (typeof row.terminal === 'boolean') clean.terminal = row.terminal
  return clean
}
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/reply is terminal|third hop|two.hop|hop limit/.test(message)) return 'legacy-terminal'
  if (/replyTo is not an active|no verified reply identity/.test(message)) return 'invalid-parent'
  if (/already.*one reply|already received|consum/.test(message)) return 'reply-consumed'
  if (/not authorized|approval.*reject|permission.*denied/.test(message)) return 'authorization-denied'
  if (/budget exhausted|budget.*exhaust/.test(message)) return 'budget-exhausted'
  if (/unambiguous|exact task operation|task revision|revision changed/.test(message)) return 'identity-or-revision'
  if (/scoped collaboration must|incoming collaboration cannot/.test(message)) return 'wrong-entry-or-source'
  if (/not found|not live|did not become live|目标会话已归档/.test(message)) return 'target-unavailable'
  if (/paused|cancelled|completed|recovery.required/.test(message)) return 'scope-or-task-stopped'
  return 'unclassified-error'
}

/** Queue outside Session publication: appending within session/event is reentrant. */
export function recordDiagnostic(ctx: Context, session: Session | undefined, data: Record<string, unknown>): Promise<void> {
  if (!session || typeof session.append !== 'function') return Promise.resolve()
  const active = context.getStore()
  if (active && data.stage === 'submit-started') active.transportState = 'unknown'
  if (active && data.stage === 'accepted') active.transportState = 'accepted'
  if ((queued.get(session) ?? 0) >= 128) {
    dropped.set(session, (dropped.get(session) ?? 0) + 1)
    return Promise.resolve()
  }
  queued.set(session, (queued.get(session) ?? 0) + 1)
  const row = { schemaVersion: 1, pluginVersion, processId, ...fields(context.getStore()), ...fields(data), recordedAt: Date.now(), recordedBy: session.id }
  const task = (pending.get(session) ?? Promise.resolve()).then(async () => {
    try {
      appendPluginRecord(session, RECORD, row)
      if (typeof ctx.sessions?.flush !== 'function' || !await ctx.sessions.flush(session)) throw new Error('diagnostic durability unavailable')
      if (persistence.get(session) !== 'unavailable') persistence.set(session, 'flushed')
    } catch {
      persistence.set(session, 'unavailable')
      if (!warned.has(session)) { warned.add(session); console.warn('[session-coordinator] diagnostics incomplete: native log persistence unavailable; delivery policy is unchanged') }
    } finally { queued.set(session, (queued.get(session) ?? 1) - 1) }
  })
  pending.set(session, task)
  return task
}

function failure(error: unknown, signal?: AbortSignal): Record<string, unknown> {
  const reason = reasonOf(error), state = context.getStore()?.transportState
  const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^(?:COLLABORATION|SESSION|TOOL|ABORT)[A-Z0-9_]{0,64}$/.test(error.code) ? error.code : undefined
  const delivery = state === 'accepted' ? 'accepted-before-error' : state === 'unknown' ? 'unknown' : 'not-sent'
  return { stage: signal?.aborted ? 'cancelled' : 'failed', reason, errorCode, delivery }
}

export async function diagnosticCall<T>(ctx: Context, caller: LiveAgentLike | undefined, tool: string, args: unknown, callId: string | undefined, signal: AbortSignal | undefined, execute: () => Promise<T>): Promise<T> {
  const input = fields(args)
  const route = Object.fromEntries(['scopeId','taskId','taskRevision','operationId','sessionId','requestId','replyTo','mode','intent','action'].filter(key => input[key] !== undefined).map(key => [key, input[key]!]))
  return context.run({ ...route, attemptId: randomUUID(), tool, protocol: tool.includes('collaboration_') ? 'persistent' : (args as { intent?: string } | null)?.intent === 'information' ? 'information' : 'legacy-single', ...(callId ? { callId } : {}) }, async () => {
    const start = Date.now()
    void recordDiagnostic(ctx, caller?.session, { stage: 'attempt' })
    try {
      const value = await execute(), row = value as Record<string, unknown> | undefined
      if (row?.kind === 'error') {
        let message = ''
        try { message = String(JSON.parse(String(row.text)).message ?? '') } catch { /* Unstructured errors remain unclassified. */ }
        void recordDiagnostic(ctx, caller?.session, { ...failure(new Error(message), signal), durationMs: Date.now() - start })
      } else {
        const association = tool.endsWith('collaboration_start') || tool.endsWith('collaboration_control') ? { scopeId: row?.id } : tool.endsWith('collaboration_task') ? { taskId: row?.id } : tool.endsWith('collaboration_send') ? { operationId: row?.id } : {}
        void recordDiagnostic(ctx, caller?.session, { ...fields(value), ...association, ...fields(row?.budget), ...(row?.operations && typeof row.operations === 'object' ? { operationCount: Object.keys(row.operations).length } : {}), stage: 'returned', durationMs: Date.now() - start })
      }
      return value
    } catch (error) {
      void recordDiagnostic(ctx, caller?.session, { ...failure(error, signal), durationMs: Date.now() - start })
      throw error
    }
  })
}

export function diagnosticTool(ctx: Context, tool: ToolDefinition): ToolDefinition {
  if (tool.name.endsWith('collaboration_status') || tool.name.endsWith('collaboration_wait')) return tool
  return { ...tool, execute(args, exec) {
    return diagnosticCall(ctx, exec.agent as unknown as LiveAgentLike, tool.name, args, exec.callId, exec.signal, () => tool.execute(args, exec))
  } }
}

/** Observe actual native history/claim/request inclusion, never infer them from a send receipt. */
export function observeDiagnostics(ctx: Context): void {
  if (observing.has(ctx)) return
  observing.add(ctx)
  const identity = (message: UserMessage) => {
    const source = message?.source as { kind?: string } | undefined
    return message?.role === 'user' && ['session-message', 'session-collaboration'].includes(source?.kind ?? '') ?
      { ...fields(source), messageId: message.id } : undefined
  }
  ctx.on?.('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const data = identity(event.data)
    if (data) void recordDiagnostic(ctx, session, { ...data, stage: 'native-history', delivery: 'appended' })
  })
  ctx.on?.('agent/inbox/claimed', ({ agent, message }) => {
    const data = identity(message)
    if (data) void recordDiagnostic(ctx, agent.session, { ...data, stage: 'native-claim', delivery: 'claimed' })
  })
  ctx.on?.('llm/stream', async function* (request, next) {
    if (isAgentLoopRequest(request) && typeof request.sessionId === 'string') {
      const agent = getLiveAgent(ctx, request.sessionId)
      if (agent) {
        const seen = included.get(agent.session) ?? new Set<string>()
        included.set(agent.session, seen)
        for (const message of request.messages) {
          const data = identity(message as UserMessage)
          if (data && !seen.has(data.messageId)) {
            seen.add(data.messageId)
            if (seen.size > 512) seen.delete(seen.values().next().value!)
            void recordDiagnostic(ctx, agent.session, { ...data, stage: 'model-inclusion', delivery: 'model-request' })
          }
        }
      }
    }
    yield* next()
  })
}

/** Explicit current/peer reads only; native read access, no resume, no grants, no history bodies. */
export async function exportDiagnostics(ctx: Context, callerId: string, peers: string[] = []) {
  const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)
  if (!callerId || !validId(callerId)) throw new Error('cannot identify diagnostic owner')
  if (peers.length > 8 || peers.some(id => typeof id !== 'string' || !validId(id))) throw new Error('logs accepts up to eight explicit peer session IDs')
  const sessions = []
  for (const id of [...new Set([callerId, ...peers])]) {
    const live = getLiveAgent(ctx, id)
    let drained = true
    if (live && pending.has(live.session)) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { drained = await Promise.race([pending.get(live.session)!.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000) })]) }
      finally { clearTimeout(timer) }
    }
    try {
      const events = await ownEvents(ctx, id, new AbortController().signal)
      const all = events.flatMap(event => {
        const record = pluginRecordOf(event), row = record?.data as Record<string, unknown> | undefined
        if (record?.type !== RECORD || row?.schemaVersion !== 1 || row.recordedBy !== id) return []
        return [{ ...fields(row), processId: typeof row.processId === 'string' ? row.processId.slice(0, 40) : 'unknown', pluginVersion: typeof row.pluginVersion === 'string' ? row.pluginVersion.slice(0, 40) : 'unknown', schemaVersion: 1, recordedBy: id, recordedAt: event.time, seq: event.seq }]
      })
      sessions.push({ sessionId: id, persistence: !drained ? 'pending' : live ? persistence.get(live.session) ?? 'not-observed' : 'persisted-history', droppedInProcess: live ? dropped.get(live.session) ?? 0 : null, incomplete: live ? !drained || persistence.get(live.session) === 'unavailable' || (dropped.get(live.session) ?? 0) > 0 : null, total: all.length,
        truncated: all.length > 200, records: all.slice(-200) })
    } catch { sessions.push({ sessionId: id, persistence: 'unavailable', droppedInProcess: live ? dropped.get(live.session) ?? 0 : null, incomplete: true, total: 0, truncated: false, records: [] }) }
  }
  return { schemaVersion: 1, pluginVersion, exportedAt: new Date().toISOString(), businessContentIncluded: false,
    note: 'Diagnostic observations only. Missing entries do not prove no delivery. Not-sent describes only this attempt, not business-side-effect rollback. Accepted is not model consumption or business completion. Native team tools are outside this plugin. Old versions have no retroactive diagnostics.', sessions }
}

/** Export only direct peers evidenced by this chat's own recent diagnostic history. */
export async function exportRelatedDiagnostics(ctx: Context, callerId: string) {
  const current = await exportDiagnostics(ctx, callerId)
  const peers = new Set<string>()
  for (const row of [...current.sessions[0]!.records].reverse()) {
    if (!['submit-started', 'accepted', 'transport-returned', 'native-history', 'native-claim', 'model-inclusion'].includes(String((row as Record<string, unknown>).stage))) continue
    for (const key of ['targetSessionId', 'senderSessionId'] as const) {
      const id = (row as Record<string, unknown>)[key]
      if (typeof id === 'string' && id !== callerId) peers.add(id)
    }
  }
  const selected = [...peers].slice(0, 8)
  const exported = selected.length ? await exportDiagnostics(ctx, callerId, selected) : current
  const identities = new Set<string>()
  const keys = ['operationId', 'messageId', 'rootMessageId']
  for (const record of current.sessions[0]!.records) for (const key of keys) {
    const value = (record as Record<string, unknown>)[key]
    if (typeof value === 'string') identities.add(key + ':' + value)
  }
  for (const session of exported.sessions.slice(1)) {
    session.records = session.records.filter(record => keys.some(key => identities.has(key + ':' + (record as Record<string, unknown>)[key])))
    session.total = session.records.length
    if (!session.records.length) session.incomplete = true
  }
  return { ...exported, discovery: { source: 'current-session-recent-diagnostics', peerCount: peers.size, truncated: peers.size > 8 || current.sessions[0]!.truncated, recursive: false } }
}
