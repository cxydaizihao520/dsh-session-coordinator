import { sessionWaitTarget, type SessionWaitTarget } from './session-wait.ts'
import { sessionContentWireText, sessionContentParts, type SessionContent } from './session-content.ts'
import type { CollaborationArtifact } from './collaboration-materials.ts'
/** Create consumer: identity is durable before optional first-message delivery. */
import { createHash } from 'node:crypto'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BridgeEnv } from './tools.ts'
import { createBridgeSession, validateBridgeSessionModel, type BridgeSessionCaller } from './session-create.ts'
import { resolveTargetCwd, sessionEvents, throwIfCollaborationAborted, type LiveAgentLike } from './core.ts'
import { InformationDeliveryError, normalizeControlScope, requestCoordinationApproval, type ControlScopeRequest } from './delivery.ts'

export interface CreateRequestArgs {
  requestId?: string
  title?: string; cwd?: string; workspaceId?: string
  provider?: string; model?: string; reasoningEffort?: string; agentPreset?: string
  initialMessage?: { content: SessionContent; delivery?: 'message' | 'queue' | 'context' | 'steer'; expectedExecution?: string; context?: { communicationHandle: string }; replyHandling?: 'continue' | 'receive-only'; authorizationRequest?: { participants?: string[]; purpose: string; extent: 'message' | 'work'; reply?: 'none' | 'once'; controls?: ControlScopeRequest } }
  prompt?: string; waitForReply?: boolean; replyHandling?: string; timeoutMs?: number
}
type Exec = { agent?: unknown; callId?: string; signal: AbortSignal }
type Receipt = { protocolVersion: 2; historical?:true; requestId: string; sessionId: string; creationState: 'created' | 'not_created' | 'unknown'; initialMessage: { admission: 'not_requested' | 'accepted' | 'rejected' | 'unknown'; artifacts?: CollaborationArtifact[]; messageId?: string; afterCursor?: string; waitTarget?: SessionWaitTarget; replyPermission?: 'none' | 'once' | 'work'; communicationHandle?: string; controlHandle?: string; error?: string }; error?: string }
const RECORD = 'plugin:dsh-session-coordinator/creation' as const
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function createRequestConsumer(env: BridgeEnv) {
  const requests = new Map<string, { fingerprint: string; run: Promise<Receipt> }>()
  return async (input: CreateRequestArgs, exec: Exec): Promise<Receipt> => {
    const args = structuredClone(input), caller = exec.agent as LiveAgentLike | undefined
    if (!caller || !exec.callId) throw new Error('cannot determine creating session/call')
    const conflicts = (['prompt', 'waitForReply', 'replyHandling', 'timeoutMs'] as const).filter(key => args[key] !== undefined)
    if (conflicts.length) throw new Error('Remove legacy-only key(s): ' + conflicts.join(', ') + '. initialMessage/requestId returns immediately; use wait targets with initialMessage.afterCursor and replyTo=initialMessage.messageId.')
    const first = args.initialMessage
    if (Array.isArray(first?.content)) first.content = sessionContentParts(first.content)
    const wireText = first ? sessionContentWireText(first.content) : undefined
    if (first && (first.delivery !== undefined && !['message', 'queue', 'context', 'steer'].includes(first.delivery) || first.expectedExecution !== undefined && first.delivery !== 'steer' || first.context !== undefined && (!first.context.communicationHandle || first.authorizationRequest !== undefined) || first.authorizationRequest !== undefined && (!first.authorizationRequest.purpose?.trim() || !['message', 'work'].includes(first.authorizationRequest.extent) || first.authorizationRequest.extent === 'work' && first.authorizationRequest.reply !== undefined || first.authorizationRequest.reply !== undefined && !['none', 'once'].includes(first.authorizationRequest.reply)) || first.replyHandling !== undefined && !['continue', 'receive-only'].includes(first.replyHandling))) throw new Error('invalid initialMessage delivery, reply or authorization scope')
    const requestId = args.requestId ?? 'create-' + hash([caller.id, exec.callId])
    if (!/^[\w-]{8,120}$/.test(requestId)) throw new Error('invalid requestId')
    const sessionId = 'sb-' + hash([caller.id, requestId]), key = caller.id + ':' + requestId
    if(first?.authorizationRequest?.controls!==undefined){
      if(first.authorizationRequest.extent!=='work')throw new Error('control scope requires an explicit work approval')
      first.authorizationRequest.controls=normalizeControlScope(first.authorizationRequest.controls,[...new Set([caller.id,sessionId,...first.authorizationRequest.participants??[]])].sort(),caller.id)
    }
    if (first?.authorizationRequest?.extent === 'message' && first.authorizationRequest.participants?.some(id => id !== caller.id && id !== sessionId)) throw new Error('message extent binds only the caller and actual new chat; additional participants require work')
    const firstMessageId = 'message-' + hash([caller.id, 'create-first-message', requestId])
    const fingerprint = hash([args.title, args.cwd, args.workspaceId, args.provider, args.model, args.reasoningEffort, args.agentPreset, first ? [first.content, first.delivery ?? 'message', first.replyHandling ?? 'continue', first.authorizationRequest?.purpose, first.authorizationRequest?.extent, first.authorizationRequest?.reply ?? 'none', [...new Set(first.authorizationRequest?.participants ?? [])].sort(), first.context?.communicationHandle, first.expectedExecution,...(first.authorizationRequest?.controls===undefined?[]:[{controls:first.authorizationRequest.controls}])] : null])
    const prior = requests.get(key)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('REQUEST_CONFLICT: create payload changed')
      let receipt: Receipt | undefined
      try { receipt = await prior.run } catch {
        // Before native creation, failures remain retryable. The journal below
        // still blocks uncertain intent; approval rejection stays host-bound.
      }
      if (receipt && (receipt.creationState !== 'created' || receipt.initialMessage.admission !== 'rejected')) return receipt
      if (requests.get(key) !== prior) return requests.get(key)!.run
    }
    const run = async (): Promise<Receipt> => {
      let receipt: Receipt = { protocolVersion: 2, requestId, sessionId, creationState: 'not_created', initialMessage: { admission: first ? 'rejected' : 'not_requested', ...(first ? { messageId: firstMessageId } : {}) } }
      const records = sessionEvents(caller.session).filter(e => caller.session.isOwnSeq?.(e.seq) !== false).map(pluginRecordOf)
        .filter(r => r?.type === RECORD && (r.data as { requestId?: string }).requestId === requestId)
      if (records.length) {
        const entries = records.map(r => r!.data as unknown as { version: number; owner: string; target: string; fingerprint: string; receipt: Receipt })
        if (entries.some(r => r.version !== 2 || r.owner !== caller.id || r.target !== sessionId || r.fingerprint !== fingerprint)) throw new Error('REQUEST_CONFLICT: creation record differs')
        receipt = entries.at(-1)!.receipt
        if (receipt.creationState !== 'created' || receipt.initialMessage.admission !== 'rejected') {
          const {communicationHandle,controlHandle,...initialMessage}=receipt.initialMessage
          return {...receipt,historical:true,initialMessage}
        }
      }
      const persist = async () => {
        if (typeof env.ctx.sessions?.flush !== 'function') throw new Error('creation requires a durability checkpoint')
        appendPluginRecord(caller.session, RECORD, { version: 2, owner: caller.id, target: sessionId, requestId, fingerprint, receipt } as unknown as JsonValue)
        if (!await env.ctx.sessions.flush(caller.session)) throw new Error('creation has no durability listener')
      }
      env.delivery!.assertNewTask(caller, true)
      const check = env.delivery!.authorizationCheckpoint(caller.id)
      const cwd = await resolveTargetCwd(env.ctx, caller.session.header.cwd, args)
      const route = caller.session.requestHeader?.()?.config
      const options = { ...args, provider: args.provider || route?.provider, model: args.model || route?.model, reasoningEffort: args.reasoningEffort || route?.reasoningEffort }
      await validateBridgeSessionModel(env.ctx, options, exec.signal)
      await requestCoordinationApproval(env.ctx, exec, 'session_coordinator_create', JSON.stringify({ operation: receipt.creationState === 'created' ? 'retry first message to the existing created chat' : 'create independent main chat', ...options, sessionId, cwd, participants: [...new Set([caller.id, sessionId, ...first?.authorizationRequest?.participants ?? []])], extent: first?.authorizationRequest?.extent ?? 'message', reply: first?.authorizationRequest?.extent === 'work' ? undefined : first?.authorizationRequest?.reply ?? 'none' }))
      check(); throwIfCollaborationAborted(exec.signal)
      if (receipt.creationState !== 'created') {
        receipt = { ...receipt, creationState: 'unknown' }
        await persist()
        try {
          check(); throwIfCollaborationAborted(exec.signal)
          const created = await createBridgeSession(env.ctx, env.registry, { ...options, sessionId, cwd, signal: exec.signal, callerCwd: caller.session.header.cwd, caller: { ctx: caller.ctx, session: caller.session as unknown as BridgeSessionCaller['session'] } })
          if (created.agent.id !== sessionId) throw new Error('native creation returned a different identity; inspect before retrying')
          receipt = { ...receipt, creationState: 'created', initialMessage: { admission: first ? 'unknown' : 'not_requested', ...(first ? { messageId: firstMessageId } : {}) } }
          await persist()
        } catch (error) {
          return { ...receipt, error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (!first) return receipt
      try {
        check(); throwIfCollaborationAborted(exec.signal)
        const sent = await env.delivery!.send({ sessionId, message: wireText!, replyHandling: first.replyHandling }, caller, undefined, {
          content: first.content,
          protocolVersion: 2, delivery: first.delivery, expectedExecution: first.expectedExecution, communicationHandle: first.context?.communicationHandle, messageAuthorization: first.authorizationRequest?.extent !== 'work' && !first.context, ...(first.authorizationRequest?.extent === 'work' ? { workAuthorization: { participants: [...new Set([caller.id, sessionId, ...first.authorizationRequest.participants ?? []])].sort(), purpose: first.authorizationRequest.purpose,controls:first.authorizationRequest.controls } } : {}), replyAllowed: first.authorizationRequest?.reply === 'once', messageId: firstMessageId, signal: exec.signal,
          authorize: async () => { check(); throwIfCollaborationAborted(exec.signal) },
        })
        const waitTarget = sessionWaitTarget(sessionId, sent.sinceSeq, sent.messageId)
        const controlHandle=sent.communicationHandle?env.delivery!.controlPermissionHandle(sent.communicationHandle,caller):undefined
        receipt = { ...receipt, initialMessage: { admission: 'accepted', messageId: sent.messageId, afterCursor: waitTarget.afterCursor, waitTarget, replyPermission: sent.communicationHandle ? 'work' : first.authorizationRequest?.reply ?? 'none', ...(sent.communicationHandle ? { communicationHandle: sent.communicationHandle } : {}), ...(controlHandle?{controlHandle}:{}), ...(sent.artifacts ? {artifacts:sent.artifacts} : {}) } }
      } catch (error) {
        receipt = { ...receipt, initialMessage: { messageId: firstMessageId, admission: error instanceof InformationDeliveryError && error.outcome === 'unknown' ? 'unknown' : 'rejected', error: error instanceof Error ? error.message : String(error) } }
      }
      try { await persist() } catch (error) {
        const { waitTarget, ...initialMessage } = receipt.initialMessage
        receipt = { ...receipt, initialMessage: { ...initialMessage, admission: 'unknown' }, error: error instanceof Error ? error.message : String(error) }
      }
      return receipt
    }
    const pending = run(); requests.set(key, { fingerprint, run: pending }); return pending
  }
}
