import { throwIfCollaborationAborted } from './core.ts'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { matchesSessionContent } from './session-content.ts'
/** Optional, lossy read-only evidence. Records never restore grants or reply rights. */
import { isDeepStrictEqual } from 'node:util'
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { getLiveAgent, sessionEvents, type SourceIdentity } from './core.ts'

const RECORD = 'plugin:dsh-session-coordinator/delivery'
const CREATION = 'plugin:dsh-session-coordinator/creation'
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-session-coordinator/delivery': JsonValue
    'plugin:dsh-session-coordinator/creation': JsonValue
  }
}
export interface DeliveryEvidence {
  version: 1 | 2
  owner: string
  target: string
  requestId: string
  stage: 'intent' | 'delivered'
  text: string
  message: { id: UserMessage['id']; role: 'user'; source: { kind: 'session-message' } & Omit<SourceIdentity, 'senderLabel'>; content: ContentBlock[] }
}

export async function recordCreation(ctx: Context, session: Session, requestId: string, target: string, cwd: string): Promise<void> {
  if (typeof ctx.sessions?.flush !== 'function') throw new Error('creation requires a session durability checkpoint')
  const prior = sessionEvents(session).map(pluginRecordOf).find(r => r?.type === CREATION && (r.data as { requestId?: string })?.requestId === requestId)
  if (prior !== undefined) throw new Error('creation already reserved; inspect instead of repeating: ' + JSON.stringify(prior.data))
  appendPluginRecord(session, CREATION, { version: 1, owner: session.id, requestId, target, cwd })
  if (!await ctx.sessions.flush(session)) throw new Error('creation reservation has no durability listener')
}

export async function recordDelivery(ctx: Context, session: Session, evidence: DeliveryEvidence): Promise<boolean> {
  // Older/test hosts can still deliver, but cannot claim recoverable evidence.
  if (typeof ctx.sessions?.flush !== 'function') return false
  if (evidence.stage === 'intent' && sessionEvents(session).some(e => {
    const prior = pluginRecordOf(e)
    return prior?.type === RECORD && (prior.data as { requestId?: string })?.requestId === evidence.requestId
  })) throw new Error('request already recorded; inspect instead of resending automatically: ' + evidence.requestId)
  appendPluginRecord(session, RECORD, evidence as unknown as JsonValue)
  if (!await ctx.sessions.flush(session)) throw new Error('delivery evidence has no durability listener')
  return true
}

export async function ownEvents(ctx: Context, id: string, signal: AbortSignal): Promise<readonly SessionEvent[]> {
  throwIfCollaborationAborted(signal)
  const live = getLiveAgent(ctx, id)
  if (live !== undefined) {
    if (live.session.id !== id || typeof live.session.isOwnSeq !== 'function') throw new Error('cannot verify owned history')
    return sessionEvents(live.session).filter(e => live.session.isOwnSeq(e.seq))
  }
  const handle = await ctx.sessionPersistence.open(id as SessionId, 'read', { signal })
  try {
    if (handle.header.id !== id || !Number.isSafeInteger(handle.inheritedEventCount)) throw new Error('cannot verify persisted owner')
    return (await handle.read(undefined, undefined, { signal })).events.filter(e => e.seq >= handle.inheritedEventCount)
  } finally { await handle.close() }
}

function records(events: readonly SessionEvent[], owner: string, target: string, requestId?: string): DeliveryEvidence[] {
  const found: DeliveryEvidence[] = []
  for (const event of events) {
    const record = pluginRecordOf(event)
    if (record?.type !== RECORD) continue
    const value = record.data as unknown as DeliveryEvidence
    if (value === null || typeof value !== 'object' || value.owner !== owner || value.target !== target ||
      typeof value.requestId !== 'string' || (requestId !== undefined && value.requestId !== requestId)) continue
    if (value.version !== 1 && value.version !== 2) throw new Error('unknown delivery evidence version')
    const m = value.message
    if (!m || m.id !== value.requestId || m.role !== 'user' || m.source?.kind !== 'session-message' ||
      m.source.senderSessionId !== owner || m.source.messageId !== value.requestId ||
      !Array.isArray(m.content) || typeof value.text !== 'string' ||
      (value.version === 2 && m.source.contentSnapshot ? m.source.protocolVersion !== 2 || !matchesSessionContent(value.text,m.content,m.source.contentSnapshot) :
      m.content.length !== 1 || m.content[0]?.type !== 'text' || typeof m.content[0].text !== 'string' ||
      (value.version === 2 ? m.source.protocolVersion !== 2 || m.content[0].text !== value.text : m.content[0].text.split('\n').slice(2).join('\n') !== value.text))) throw new Error('conflicting delivery evidence')
    if (!['intent', 'delivered'].includes(value.stage)) throw new Error('unknown delivery evidence stage')
    found.push(value)
  }
  return found
}

function consistent(values: DeliveryEvidence[]): DeliveryEvidence {
  const delivered = values.find(v => v.stage === 'delivered')
  if (delivered === undefined || !values.some(v => v.stage === 'intent') ||
    values.some(v => !isDeepStrictEqual(v.message, delivered.message))) throw new Error('incomplete or conflicting delivery evidence')
  return delivered
}
export function sessionMessageIdentity(message: UserMessage) {
  const source={...message.source} as Record<string,unknown>
  delete source.contentSnapshot
  return {id:message.id,role:message.role,source}
}

function nativeCopies(events: readonly SessionEvent[], id: string): UserMessage[] {
  return events.flatMap(e => e.type === 'user/message' ? [e.data] :
    e.type === 'agent/inbox/spliced' && Array.isArray(e.data.inserted) ? e.data.inserted : [])
    .filter(m => m?.id === id)
}

function compatibleCopy(copy: UserMessage, original: UserMessage): boolean {
  if((original.source as SourceIdentity).protocolVersion!==2)return isDeepStrictEqual(copy,original)
  if(!isDeepStrictEqual(sessionMessageIdentity(copy),sessionMessageIdentity(original))||!Array.isArray(copy.content))return false
  const snapshot=(copy.source as SourceIdentity).contentSnapshot
  try{return snapshot?matchesSessionContent(JSON.stringify(snapshot.input),copy.content,snapshot):copy.content.length===1&&copy.content[0]?.type==='text'&&typeof copy.content[0].text==='string'}catch{return false}
}

function admitted(events: readonly SessionEvent[], message: UserMessage): boolean {
  const copies=nativeCopies(events,message.id)
  return copies.some(copy=>isDeepStrictEqual(copy,message))&&copies.every(copy=>compatibleCopy(copy,message))
}

/** Read the actual current input; an old cached body is not a pending reply. */
export async function currentReply(ctx:Context, owner:string, original:UserMessage, signal:AbortSignal, claimed?:(id:string)=>UserMessage|undefined):Promise<UserMessage> {
  const events=await ownEvents(ctx,owner,signal)
  if(!admitted(events,original))throw new Error('reply evidence identity conflicts')
  const agent=getLiveAgent(ctx,owner)
  const claim=claimed?.(original.id)
  const candidates=[...events.flatMap(event=>event.type==='user/message'?[event.data]:[]),...agent?.inbox?.nextStep??[],...agent?.inbox?.nextTurn??[],...(claim?[claim]:[])]
    .filter((message):message is UserMessage=>!!message&&typeof message==='object'&&(message as UserMessage).id===original.id)
  if(!candidates.length||candidates.some(message=>!compatibleCopy(message,original)||!isDeepStrictEqual(message,candidates[0])))throw new Error('reply is withdrawn, unavailable or has conflicting current versions')
  throwIfCollaborationAborted(signal)
  return structuredClone(candidates[0]!)
}

export async function reconcileReply(ctx: Context, owner: string, target: string, requestId: string, signal: AbortSignal, claimed?:(id:string)=>UserMessage|undefined) {
  // No resume, send, grant, inbox mutation, or latest-answer fallback on this path.
  const a = await ownEvents(ctx, owner, signal), b = await ownEvents(ctx, target, signal)
  const root = consistent(records(a, owner, target, requestId))
  if (root.message.source.replyTo !== undefined || root.message.source.rootMessageId !== requestId || root.message.source.hopCount !== 1 ||
    !admitted(b, root.message)) throw new Error('original delivery evidence incomplete')
  const replies = records(b, target, owner).filter(v => v.message.source.replyTo === requestId)
  if (new Set(replies.map(v => v.requestId)).size !== 1) throw new Error('reply evidence incomplete or ambiguous')
  const reply = consistent(replies)
  if (reply.message.source.rootMessageId !== requestId || reply.message.source.hopCount !== 2 || !admitted(a, reply.message)) throw new Error('reply admission evidence incomplete')
  const current=await currentReply(ctx,owner,reply.message,signal,claimed)
  return { messageId: reply.requestId, ...(reply.version===2 ? {text:current.content.flatMap(part=>part.type==='text'?[part.text]:[]).join(''),...((current.source as SourceIdentity).contentSnapshot?{content:current.content}:{})} : {text:reply.text}), senderSessionId: target }
}

/** The delivered record is written only after the target's native flush succeeds. */
export async function reconcileDeliveryAdmission(ctx:Context,owner:string,target:string,messageId:string,signal:AbortSignal):Promise<void> {
  const original=consistent(records(await ownEvents(ctx,owner,signal),owner,target,messageId))
  if(!admitted(await ownEvents(ctx,target,signal),original.message))throw new Error('target admission evidence incomplete')
  throwIfCollaborationAborted(signal)
}
