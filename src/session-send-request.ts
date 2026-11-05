/** Versioned single/group request bookkeeping around the shared native sender. */
import { createHash } from 'node:crypto'
import { sessionContentWireText, sessionContentParts } from './session-content.ts'
import type { CollaborationArtifact } from './collaboration-materials.ts'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { BridgeEnv, SendArgs } from './tools.ts'
import { sessionWaitTarget, type SessionWaitTarget } from './session-wait.ts'
import { InformationDeliveryError, normalizeControlScope, requestCoordinationApproval } from './delivery.ts'
import { sessionEvents, throwIfCollaborationAborted, type LiveAgentLike } from './core.ts'
import {reconcileDeliveryAdmission} from './coordination-records.ts'

type Exec = { agent?: unknown; callId?: string; rootCallId?: string; parent?: unknown; signal: AbortSignal; concludeTurn?: () => void }
type Result = { sessionId: string; messageId: string; admission: 'accepted' | 'rejected' | 'unknown'; artifacts?: CollaborationArtifact[]; afterCursor?: string; waitTarget?: SessionWaitTarget; skipped?: boolean; error?: { code: string; message: string } }
type Receipt = { protocolVersion: 2; requestId: string; historical?: true; communicationHandle?: string; controlHandle?: string; results: Result[] }
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-session-coordinator/send-request': { version: number; owner: string; requestId: string; fingerprint: string } }
}
const RECORD = 'plugin:dsh-session-coordinator/send-request' as const
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function createSendRequestConsumer(env: BridgeEnv) {
  const requests = new Map<string, { fingerprint: string; run: Promise<Receipt> }>()
  return async (input: SendArgs, exec: Exec): Promise<Receipt> => {
    const args = structuredClone(input), caller = exec.agent as LiveAgentLike | undefined
    if (!caller || !exec.callId) throw new Error('cannot determine sending session/call')
    if (!Array.isArray(args.targets) || args.targets.some(id => typeof id !== 'string' || !id || id !== id.trim() || id.includes('*'))) throw new Error('targets require exact canonical identities, not wildcards or guessed names')
    const targets = [...new Set(args.targets)].filter(id => id !== caller.id).sort()
    if (!targets.length) throw new Error('targets requires at least one non-self recipient')
    if (Array.isArray(args.content)) args.content = sessionContentParts(args.content)
    const wireText = sessionContentWireText(args.content!)
    const mixed = ['sessionId', 'sessionIds', 'message', 'mode', 'intent', 'waitForReply', 'retryFailed'].filter(key => args[key as keyof SendArgs] !== undefined)
    if (mixed.length) throw new Error('do not mix current and legacy send arguments: ' + mixed.join(', '))
    if (args.delivery !== undefined && !['message', 'queue', 'context', 'steer'].includes(args.delivery)) throw new Error('unsupported delivery mode')
    if (args.expectedExecution !== undefined && args.delivery !== 'steer') throw new Error('expectedExecution requires strict steer')
    if (targets.length > 1 && (args.delivery === 'steer' || args.replyTo !== undefined)) throw new Error('strict steer and replyTo require a single exact target')
    const authorization = args.authorizationRequest && { ...args.authorizationRequest, participants: [...new Set(args.authorizationRequest.participants)].sort() }
    if (authorization?.controls !== undefined) {
      if(authorization.extent!=='work')throw new Error('control scope requires an explicit work approval')
      authorization.controls=normalizeControlScope(authorization.controls,authorization.participants,caller.id)
    }
    if (authorization && (!authorization.purpose?.trim() || !['message', 'work'].includes(authorization.extent) || !authorization.participants.includes(caller.id) || !targets.every(id => authorization.participants.includes(id)) || authorization.participants.some(id => !id || id !== id.trim()) || authorization.extent === 'message' && authorization.participants.length !== targets.length + 1 || authorization.extent === 'work' && authorization.reply !== undefined)) throw new Error('authorization must bind the caller, actual recipients, purpose and message/work extent')
    if (args.context && (authorization || !args.context.communicationHandle)) throw new Error('context and authorizationRequest are mutually exclusive')
    if (args.context?.taskHandle !== undefined && (typeof args.context.taskHandle !== 'string' || !args.context.taskHandle.trim())) throw new Error('taskHandle requires an exact task reference')
    const requestId = args.requestId ?? 'request-' + hash([caller.id, exec.callId])
    if (!/^[\w-]{8,120}$/.test(requestId)) throw new Error('invalid requestId')
    const fingerprint = JSON.stringify([targets, args.content, args.delivery ?? 'message', args.replyHandling ?? 'continue', args.replyTo, authorization ? [authorization.participants, authorization.purpose, authorization.extent, authorization.reply ?? null] : null, args.context?.communicationHandle, args.expectedExecution, args.requireRunning === true, ...(args.context?.taskHandle === undefined ? [] : [{taskHandle:args.context.taskHandle}]), ...(authorization?.controls===undefined?[]:[{controls:authorization.controls}])])
    const key = JSON.stringify([caller.id, requestId]), prior = requests.get(key)
    const frozen = sessionEvents(caller.session).filter(event => caller.session.isOwnSeq?.(event.seq) !== false).map(pluginRecordOf).filter(record => record?.type === RECORD && (record.data as { requestId?: string }).requestId === requestId)
    if (frozen.some(record => { const data = record!.data as { owner?: string; fingerprint?: string }; return data.owner !== caller.id || data.fingerprint !== fingerprint })) throw new Error('REQUEST_CONFLICT: persisted request binds the original complete group')
    if (!prior && frozen.length) return {protocolVersion:2,requestId,historical:true,results:await Promise.all(targets.map(async(sessionId):Promise<Result>=>{
      const messageId='message-'+hash(targets.length===1?[caller.id,requestId]:[caller.id,requestId,sessionId])
      try{
        await reconcileDeliveryAdmission(env.ctx,caller.id,sessionId,messageId,exec.signal)
        return {sessionId,messageId,admission:'accepted'}
      }catch(error){
        throwIfCollaborationAborted(exec.signal)
        return {sessionId,messageId,admission:'unknown',error:{code:'DELIVERY_UNKNOWN',message:'original target durability evidence is unavailable or conflicting; do not replay'}}
      }
    }))}
    let preserved: Result[] = []
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('REQUEST_CONFLICT: requestId binds the original complete recipients, content, mode and authority')
      const previous = await prior.run
      if (previous.results.every(result => result.admission !== 'rejected' || result.skipped)) return previous
      if (requests.get(key) !== prior) return requests.get(key)!.run
      preserved = previous.results.filter(result => result.admission !== 'rejected' || result.skipped)
    }
    const run = async (): Promise<Receipt> => {
      const receipt: Receipt = { protocolVersion: 2, requestId, results: [] }
      let approval: Promise<void> | undefined
      const checkpoint = env.delivery!.authorizationCheckpoint(caller.id)
      const authorize = async () => {
        throwIfCollaborationAborted(exec.signal); checkpoint()
        approval ??= requestCoordinationApproval(env.ctx, exec, 'session_coordinator_send', JSON.stringify({ targets, content: args.content, delivery: args.delivery ?? 'message', authorizationRequest: authorization ?? { participants: [caller.id, ...targets], purpose: 'deliver this message', extent: 'message', reply: 'none' } }))
        await approval; throwIfCollaborationAborted(exec.signal); checkpoint()
      }
      const options = { protocolVersion: 2 as const, delivery: args.delivery, expectedExecution: args.expectedExecution, messageAuthorization: authorization?.extent === 'message', communicationHandle: args.context?.communicationHandle, ...(authorization?.extent === 'work' ? { workAuthorization: { participants: authorization.participants, purpose: authorization.purpose,controls:authorization.controls } } : {}), replyAllowed: authorization?.reply === 'once', signal: exec.signal, authorize }
      let scopeError: unknown
      try {
        throwIfCollaborationAborted(exec.signal)
        if (!frozen.length) appendPluginRecord(caller.session, RECORD, { version: 2, owner: caller.id, requestId, fingerprint })
        if (typeof env.ctx.sessions?.flush !== 'function' || !await env.ctx.sessions.flush(caller.session)) throw new Error('request requires a durability checkpoint')
        const handle = await env.delivery!.prepareWorkPermission(caller, targets, options, args.replyTo)
        if (handle) { receipt.communicationHandle = handle; const controlHandle=env.delivery!.controlPermissionHandle(handle,caller);if(controlHandle)receipt.controlHandle=controlHandle;options.communicationHandle = handle; delete options.workAuthorization }
        else if (targets.length > 1 && !authorization) env.delivery!.assertNewTask(caller)
      } catch (error) { scopeError = error }
      for (const sessionId of targets) {
        const old = preserved.find(result => result.sessionId === sessionId)
        if (old) { receipt.results.push(old); continue }
        const messageId = 'message-' + hash(targets.length === 1 ? [caller.id, requestId] : [caller.id, requestId, sessionId])
        try {
          if (scopeError) throw scopeError
          throwIfCollaborationAborted(exec.signal)
          const task = args.context?.taskHandle ? await (await env.collaboration!).sessionTaskBinding(args.context.taskHandle,args.context.communicationHandle,sessionId,exec) : undefined
          const sent = await env.delivery!.send({ sessionId, message: wireText, replyTo: args.replyTo, replyHandling: args.replyHandling, requireRunning: args.requireRunning }, caller, undefined, { ...options, messageId, content:args.content, task })
          if (sent.communicationHandle) receipt.communicationHandle = sent.communicationHandle
          const waitTarget = sessionWaitTarget(sessionId, sent.sinceSeq, messageId)
          receipt.results.push({ sessionId, messageId, afterCursor: waitTarget.afterCursor, waitTarget, admission: 'accepted', ...(sent.artifacts ? {artifacts:sent.artifacts} : {}) })
        } catch (error) {
          const unknown = error instanceof InformationDeliveryError && error.outcome === 'unknown', skipped = error instanceof InformationDeliveryError && error.outcome === 'skipped'
          receipt.results.push({ sessionId, messageId, admission: unknown ? 'unknown' : 'rejected', ...(skipped ? { skipped: true } : {}), error: { code: unknown ? 'DELIVERY_UNKNOWN' : skipped ? 'RECIPIENT_NOT_RUNNING' : exec.signal.aborted ? 'CANCELLED' : /^(EXECUTION_CONFLICT|CAPABILITY_UNAVAILABLE|AUTHORIZATION_AMBIGUOUS):/.exec(error instanceof Error ? error.message : '')?.[1] ?? 'DELIVERY_REJECTED', message: error instanceof Error ? error.message : String(error) } })
        }
      }
      return receipt
    }
    const pending = Promise.resolve().then(run); requests.set(key, { fingerprint, run: pending })
    const receipt = await pending
    if (!exec.signal.aborted && receipt.results.length === 1 && receipt.results[0]!.admission === 'accepted' && env.delivery!.canConclude(caller, receipt.results[0]!.messageId, exec)) exec.concludeTurn?.()
    return receipt
  }
}
