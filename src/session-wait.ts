/** Cursor-based observation of native history; waiting never resumes or stops agents. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { ownEvents, type DeliveryEvidence } from './coordination-records.ts'
import { foldMessages, getLiveAgent, maxSeq } from './core.ts'

export interface SessionWaitTarget { sessionId: string; afterCursor: string; replyTo?: string }
export function sessionWaitCursor(sessionId: string, seq: number): string {
  return Buffer.from(JSON.stringify([2, sessionId, seq])).toString('base64url')
}
export function sessionWaitTarget(sessionId: string, seq: number, replyTo?: string): SessionWaitTarget {
  return { sessionId, afterCursor: sessionWaitCursor(sessionId, seq), ...(replyTo === undefined ? {} : { replyTo }) }
}
function cursorSeq(target: SessionWaitTarget): number {
  try {
    const value = JSON.parse(Buffer.from(target.afterCursor, 'base64url').toString())
    if (value[0] !== 2 || value[1] !== target.sessionId || !Number.isSafeInteger(value[2]) || value[2] < -1 || value.length !== 3) throw new Error()
    return value[2]
  } catch { throw new Error('invalid afterCursor: use the cursor for this exact session') }
}
export async function waitSessions(ctx: Context, callerId: string, targets: SessionWaitTarget[], mode: 'any' | 'all', timeoutMs: number, signal: AbortSignal) {
  const cursors = new Map<string, number>(), errors: Array<{ sessionId: string; error: string }> = []
  const updates: Array<{ sessionId: string; messages: unknown[]; stateChanges: unknown[] }> = []
  let pendingInput = false
  for (const target of targets) {
    try { cursors.set(target.sessionId, cursorSeq(target)) }
    catch (error) { errors.push({ sessionId: target.sessionId, error: (error as Error).message }) }
  }
  const started = Date.now()
  while (!signal.aborted) {
    await Promise.all(targets.map(async target => {
      if (!cursors.has(target.sessionId) || updates.some(update => update.sessionId === target.sessionId) || errors.some(error => error.sessionId === target.sessionId)) return
      try {
        const events = await ownEvents(ctx, target.sessionId, signal)
        const fresh = events.filter(event => event.seq > cursors.get(target.sessionId)!)
        const messages: unknown[] = target.replyTo ? fresh.flatMap(event => {
          const record = pluginRecordOf(event)
          const value = record?.data as unknown as DeliveryEvidence | undefined
          if (record?.type !== 'plugin:dsh-session-coordinator/delivery' || value?.version !== 2 || value.stage !== 'delivered' || value.owner !== target.sessionId || value.target !== callerId || value.message?.source?.replyTo !== target.replyTo || value.message.source.senderSessionId !== target.sessionId || value.message.id !== value.requestId) return []
          return [{ seq: event.seq, messageId: value.message.id, source: value.message.source, text: value.text }]
        }) : foldMessages(fresh).map(row => ({ seq: row.seq, role: row.role, text: row.text ?? '' }))
        const stateChanges = target.replyTo ? [] : fresh.filter(event => ['turn/start', 'turn/end'].includes(event.type)).map(event => ({ seq: event.seq, type: event.type, data: event.data }))
        cursors.set(target.sessionId, Math.max(cursors.get(target.sessionId)!, maxSeq(events)))
        if (messages.length || stateChanges.length) updates.push({ sessionId: target.sessionId, messages, stateChanges })
      } catch (error) {
        if (!signal.aborted) errors.push({ sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }))
    const complete = mode === 'any' ? updates.length > 0 : updates.length === targets.length
    // Let the native driver claim steering instead of waiting on input parked behind this tool.
    pendingInput = (getLiveAgent(ctx, callerId)?.inbox?.nextStep?.length ?? 0) > 0
    if (complete || pendingInput || errors.length === targets.length || Date.now() - started >= timeoutMs || signal.aborted) break
    try { await delay(Math.min(25, timeoutMs - (Date.now() - started)), undefined, { signal }) } catch { break }
  }
  const complete = mode === 'any' ? updates.length > 0 : updates.length === targets.length
  return { updates, cursors: targets.filter(target => cursors.has(target.sessionId)).map(target => sessionWaitTarget(target.sessionId, cursors.get(target.sessionId)!, target.replyTo)), errors, ...(pendingInput ? { pendingInput: true } : {}), timedOut: !signal.aborted && !pendingInput && !complete && Date.now() - started >= timeoutMs, aborted: signal.aborted }
}
