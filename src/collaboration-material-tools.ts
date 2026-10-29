import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { BridgeEnv } from './tools.ts'
import type { CollaborationRuntime, CollaborationExecution, CollaborationScope, CollaborationTask } from './collaboration.ts'
import type { JsonValue } from './collaboration-store.ts'
import { getLiveAgent, inspectPersistedSession, sessionEvents, type LiveAgentLike } from './core.ts'
import { resumeBridgeSession } from './session-create.ts'
import { requestCoordinationApproval } from './delivery.ts'
import { forkCollaborationSession, readCollaborationContext, readNativeSessionReferences, renderCollaborationContext, saveCollaborationContext, verifyCollaborationArtifacts, type CollaborationArtifact, type MaterialContext } from './collaboration-materials.ts'
import { createCollaborationWorktree, inspectCollaborationWorktree, integrateCollaborationWorktree, type CollaborationWorktree } from './collaboration-environment.ts'

interface MaterialArguments {
  scopeId: string; taskId: string
  action: 'checkpoint' | 'read-context' | 'resolve-references' | 'fork' | 'worktree' | 'inspect' | 'integrate' | 'verify'
  sourceSessionId?: string; sessionId?: string; contextId?: string; inputMessageId?: string; operationId?: string
  constraints?: string[]; decisions?: string[]; pending?: string[]
  atSeq?: number; from?: string; name?: string; path?: string; expectedSourceCommit?: string; expectedTargetCommit?: string
}
interface MaterialOperation { request: MaterialArguments; status: 'prepared' | 'completed' | 'unknown'; result?: JsonValue; error?: string }
function value<T>(item: T): JsonValue { return item as unknown as JsonValue }
function requireText(input: string | undefined, name: string): string { if (!input) throw new Error(`${name} is required`); return input }
function participant(task: CollaborationTask, scope: CollaborationScope, id: string): void {
  if (id !== scope.owner && !task.members.includes(id)) throw new Error('Material source or recipient is outside this task')
}
function active(task: CollaborationTask, scope: CollaborationScope): void {
  if (task.state !== 'active' || scope.state !== 'active') throw new Error('Material side effects require an active collaboration task')
}

/** One registered consumer, using the runtime's real authorization and durable task transactions. */
export function registerCollaborationMaterialTools(env: BridgeEnv, ready: Promise<CollaborationRuntime>): void {
  const strings = { type: 'array' as const, items: { type: 'string' as const } }
  env.ctx.tools.register(defineTool({
    name: 'session_coordinator_collaboration_material',
    description: 'Task context, native references, reviewed artifacts and isolated code work. checkpoint saves a recoverable summary with original evidence; read-context is read-only; resolve-references returns native @ identities without granting send rights. fork creates an idle independent conversation without copying running collaboration authority. worktree isolates the named participant; inspect pins its diff; integrate is limited to the recorded owner and exact reviewed commits and still requires validation. verify detects stale/missing immutable artifacts. Side-effect uncertainty is retained and never blindly retried.',
    parameters: {
      scopeId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['checkpoint', 'read-context', 'resolve-references', 'fork', 'worktree', 'inspect', 'integrate', 'verify'] },
      sourceSessionId: { type: 'string' }, sessionId: { type: 'string' }, contextId: { type: 'string' }, inputMessageId: { type: 'string' }, operationId: { type: 'string' },
      constraints: strings, decisions: strings, pending: strings, atSeq: { type: 'number' }, from: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, expectedSourceCommit: { type: 'string' }, expectedTargetCommit: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text' as const, text: JSON.stringify(result) }] },
    async execute(raw, execution) {
      try {
      const args = raw as MaterialArguments, exec = execution as CollaborationExecution, runtime = await ready
      const caller = exec.agent as LiveAgentLike
      const snapshot = await runtime.withTask(args.scopeId, args.taskId, exec, (task, scope) => ({ task, scope }), { ownerOnly: !['read-context', 'resolve-references', 'verify', 'inspect'].includes(args.action) })
      const { task, scope } = snapshot
      let signal = exec.signal
      const actor = async (id: string): Promise<LiveAgentLike> => {
        participant(task, scope, id)
        let agent = getLiveAgent(env.ctx, id)
        if (agent === undefined) { await resumeBridgeSession(env.ctx, env.registry, { sessionId: id }); agent = getLiveAgent(env.ctx, id) }
        if (agent === undefined) throw new Error('Material participant could not be restored')
        signal.throwIfAborted()
        return agent
      }
      if (args.action === 'read-context') {
        const id = requireText(args.contextId, 'contextId')
        if (!task.contextIds?.includes(id)) throw new Error('Context checkpoint does not belong to this task')
        const checkpoint = readCollaborationContext(runtime.store, id, scope.owner)
        return { checkpoint, summary: renderCollaborationContext(checkpoint) } as never
      }
      if (args.action === 'resolve-references') return { references: readNativeSessionReferences(caller.session, requireText(args.inputMessageId, 'inputMessageId')) } as never
      if (args.action === 'verify') {
        const operation = scope.operations[requireText(args.operationId, 'operationId')]
        if (operation?.taskId !== task.id || operation.artifacts === undefined) throw new Error('Operation has no task artifact evidence')
        const source = await actor(operation.sender), target = await actor(operation.target)
        return { artifacts: await verifyCollaborationArtifacts(source.ctx as MaterialContext, target.ctx as MaterialContext, operation.artifacts as unknown as CollaborationArtifact[], exec.signal) } as never
      }
      if (args.action === 'inspect') {
        const environment = task.environments?.[requireText(args.sessionId, 'sessionId')] as unknown as CollaborationWorktree | undefined
        if (environment === undefined) throw new Error('This participant has no recorded task checkout')
        return await inspectCollaborationWorktree(caller.ctx as MaterialContext, caller, environment, exec.signal) as never
      }
      active(task, scope)
      const callId = requireText(exec.callId, 'callId')
      const id = 'material:' + createHash('sha256').update(JSON.stringify([scope.id, task.id, callId])).digest('hex')
      const staged = await runtime.withTask(scope.id, task.id, exec, (current, latest) => {
        active(current, latest)
        if (current.revision !== task.revision) throw new Error('Task objective changed before the material operation; use its current revision')
        const previous = current.materialOperations?.[id] as unknown as MaterialOperation | undefined
        if (previous !== undefined) {
          if (!isDeepStrictEqual(previous.request, args)) throw new Error('This call identity already belongs to a different material operation')
          if (previous.status !== 'completed') throw new Error('Material acceptance is unknown; reconcile before retrying this operation')
          return { completed: true, result: previous.result }
        }
        if (args.action === 'worktree') {
          const target = requireText(args.sessionId, 'sessionId'); participant(current, latest, target)
          if (Object.values(latest.tasks).some(item => item.environments?.[target] !== undefined || Object.values(item.materialOperations ?? {}).some(entry => {
            const pending = entry as unknown as MaterialOperation
            return pending.request.action === 'worktree' && pending.request.sessionId === target && pending.status !== 'completed'
          }))) throw new Error('Participant already owns or is preparing a task checkout; use a separate participant for another isolation boundary')
        }
        current.materialOperations ??= {}
        current.materialOperations[id] = value({ request: args, status: 'prepared' })
        return { completed: false }
      })
      if (staged.completed) return staged.result as never
      const operation = runtime.taskOperation(scope.id, task.id, task.revision, exec)
      signal = operation.signal
      let result: JsonValue
      try {
      try {
        signal.throwIfAborted()
        if (args.action === 'checkpoint') {
          const sourceId = args.sourceSessionId ?? caller.id
          participant(task, scope, sourceId)
          const source = getLiveAgent(env.ctx, sourceId)
          const events = source === undefined ? (await inspectPersistedSession(env.ctx, sourceId)).events : sessionEvents(source.session)
          signal.throwIfAborted()
          const input = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
          const checkpoint = await saveCollaborationContext(runtime.store, { ownerSessionId: scope.owner, scopeId: scope.id, taskId: task.id, taskRevision: task.revision, objective: task.objective, constraints: args.constraints ?? [], decisions: args.decisions ?? [], pending: args.pending ?? [], sourceSessionId: sourceId, capturedThroughSeq: events.at(-1)?.seq ?? null,
            artifacts: Object.values(scope.operations).filter(op => op.taskId === task.id).flatMap(op => op.artifacts ?? []) as unknown as CollaborationArtifact[],
            references: input?.type === 'user/message' ? readNativeSessionReferences({ snapshotEvents: () => events }, input.data.id) : [],
          }, task.contextIds?.at(-1))
          result = value({ ...checkpoint, summary: renderCollaborationContext(checkpoint) })
        } else if (args.action === 'fork') {
          const sourceId = requireText(args.sourceSessionId, 'sourceSessionId'); participant(task, scope, sourceId)
          await requestCoordinationApproval(env.ctx, { agent: caller, callId, signal }, 'session_coordinator_collaboration_material', `Fork ${sourceId} at event ${String(args.atSeq ?? 'latest completed turn')} into a new idle conversation for task ${task.objective}. It receives no running collaboration authority.`)
          await runtime.withTask(scope.id, task.id, exec, (current, latest) => { active(current, latest); if (current.revision !== task.revision) throw new Error('Task objective changed during fork approval') })
          signal.throwIfAborted()
          result = value(await forkCollaborationSession(env.ctx as unknown as MaterialContext, sourceId, args.atSeq, signal))
        } else if (args.action === 'worktree') {
          const sessionId = requireText(args.sessionId, 'sessionId'); participant(task, scope, sessionId)
          if (task.environments?.[sessionId] !== undefined) throw new Error('This task participant already has a checkout; inspect it before creating another')
          const owner = await actor(sessionId)
          if (owner.status === 'running') throw new Error('Wait for the participant to become idle before changing its working directory')
          result = value(await createCollaborationWorktree(owner.ctx as MaterialContext, owner, { taskId: task.id, integrationOwnerSessionId: scope.owner, ...(args.from === undefined ? {} : { from: args.from }), ...(args.name === undefined ? {} : { name: args.name }), ...(args.path === undefined ? {} : { path: args.path }) }, signal))
        } else if (args.action === 'integrate') {
          const environment = task.environments?.[requireText(args.sessionId, 'sessionId')] as unknown as CollaborationWorktree | undefined
          if (environment === undefined) throw new Error('This participant has no recorded task checkout')
          result = value(await integrateCollaborationWorktree(caller.ctx as MaterialContext, caller, environment, { expectedSourceCommit: requireText(args.expectedSourceCommit, 'expectedSourceCommit'), expectedTargetCommit: requireText(args.expectedTargetCommit, 'expectedTargetCommit') }, signal))
        } else throw new Error('Unsupported material action')
      } catch (error) {
        await runtime.withTask(scope.id, task.id, { ...exec, signal: new AbortController().signal }, current => { current.materialOperations![id] = value({ request: args, status: 'unknown', error: error instanceof Error ? error.message : String(error) }) })
        throw error
      }
      await runtime.withTask(scope.id, task.id, { ...exec, signal: new AbortController().signal }, current => {
        current.materialOperations![id] = value({ request: args, status: 'completed', result })
        if (args.action === 'checkpoint') { current.contextIds ??= []; current.contextIds.push((result as unknown as { contextId: string }).contextId) }
        if (args.action === 'worktree') { current.environments ??= {}; current.environments[args.sessionId!] = result }
      })
      return result as never
      } finally { operation.release() }
      } catch (error) {
        if (error instanceof HarnessError || execution.signal.aborted) throw error
        throw new HarnessError(error instanceof Error ? error.message : String(error), 'COLLABORATION_MATERIAL_REJECTED', { cause: error })
      }
    },
  }))
}
