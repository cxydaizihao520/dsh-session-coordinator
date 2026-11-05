import { SessionToolSurface } from './session-tool-surface.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { throwIfCollaborationAborted } from './core.ts'
import { diagnosticTool } from './diagnostics.ts'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BridgeEnv } from './tools.ts'
import type { CollaborationStore } from './collaboration-store.ts'
import { collaborationMemberDirectory, CollaborationRuntime, type CollaborationControl, type CollaborationOperation, type CollaborationScope } from './collaboration.ts'

function modelReceipt(name: string, args: Partial<CollaborationControl> & {taskHandle?:string}, value: unknown): unknown {
  if (name === 'send') {
    const { wire, ...operation } = value as CollaborationOperation
    return operation
  }
  if (name === 'start') {
    const scope = value as CollaborationScope
    return { memberDirectory: collaborationMemberDirectory(scope), ...scope }
  }
  if (name === 'status') {
    const withDirectory = (scope: CollaborationScope) => ({ memberDirectory: collaborationMemberDirectory(scope), ...scope })
    const status = value as CollaborationScope | { scopes: CollaborationScope[] }
    return 'scopes' in status ? { scopes: status.scopes.map(withDirectory) } : withDirectory(status)
  }
  if (name !== 'control' || args.taskHandle !== undefined) return value
  const scope = value as CollaborationScope
  const taskId = args.taskId ?? scope.operations[args.operationId ?? '']?.taskId ?? scope.questions[args.questionId ?? '']?.taskId
  const relevantTask = (id: string) => taskId === undefined || id === taskId
  const operations = Object.entries(scope.operations).filter(([id, operation]) => args.operationId ? id === args.operationId : relevantTask(operation.taskId))
  const operationIds = new Set(operations.map(([id]) => id))
  return {
    id: scope.id, owner: scope.owner, memberDirectory: collaborationMemberDirectory(scope), revision: scope.revision, state: scope.state, reason: scope.reason,
    ...(taskId === undefined ? {} : { taskId }),
    budget: scope.budget, observedTokens: scope.observedTokens, usageIncomplete: scope.usageIncomplete,
    tasks: Object.fromEntries(Object.entries(scope.tasks).filter(([id]) => relevantTask(id)).map(([id, { history, humanInputs, materialOperations, ...task }]) => [id, {
      ...task,
      ...(materialOperations === undefined ? {} : { materialOperations: Object.fromEntries(Object.entries(materialOperations).map(([operationId, entry]) => {
        const operation = entry as { status?: string; error?: string } | null
        return [operationId, { status: operation?.status, error: operation?.error }]
      })) }),
    }])),
    operations: Object.fromEntries(operations.map(([id, { wire, text, materials, artifacts, ...operation }]) => [id, operation])),
    mutations: Object.fromEntries(Object.entries(scope.mutations).filter(([, mutation]) => operationIds.has(mutation.operationId)).map(([id, { before, after, ...mutation }]) => [id, mutation])),
    questions: Object.fromEntries(Object.entries(scope.questions).filter(([id, question]) => args.questionId ? id === args.questionId : relevantTask(question.taskId))),
    creations: Object.fromEntries(Object.entries(scope.creations).map(([id, { config, ...creation }]) => [id, creation])),
    nativeWaits: Object.fromEntries(Object.entries(scope.nativeWaits ?? {}).filter(([, wait]) => taskId === undefined || wait.taskIds.includes(taskId))),
    details: { tool: 'session_coordinator_collaboration_status', scopeId: scope.id },
  }
}

/** Registration is synchronous; unavailable durable storage fails calls explicitly. */
export function installCollaboration(env: BridgeEnv, options: { store?: CollaborationStore } = {}): Promise<CollaborationRuntime> {
  const startup = new AbortController()
  let initialized = false
  const ready = (async () => {
    const store = options.store ?? await (await import('./collaboration-store.ts')).openCollaborationStore(env.ctx, { signal: startup.signal })
    try {
      throwIfCollaborationAborted(startup.signal)
      const runtime = await CollaborationRuntime.open(env, store)
      initialized = true
      return runtime
    } catch (error) {
      if (!options.store) await store.close().catch(() => {})
      throw error
    }
  })()
  env.ctx.tools.register(diagnosticTool(env.ctx, defineTool({
    name:'session_coordinator_task',
    description:'Optional independent work lifecycle, separate from native Team tasks and Goals. First obtain a work communicationHandle with send, then declare before task-bound dispatch; control this lifecycle with session_coordinator_control object=task and the returned taskHandle. For a user/dependency wait, block records waiting until explicit resume through the existing control tool or native user command; it does not block a model turn or freeze a process. Ordinary messages and independent native job stopping do not require a task: the job owner uses job_list/job_output/job_kill. Declaration cannot assign previous jobs; the version-bound handle grants no communication or execution authority. Cancellation does not prove jobs stopped. An explicit positive-integer budget limits only this task, is frozen with requestId and requires its own initial native approval; defaults need none. Observed tokens exclude shared/unavailable usage, which stays unknown.',
    parameters:{communicationHandle:{type:'string',required:true},objective:{type:'string',required:true},members:{type:'array',items:{type:'string'},required:true},requestId:{type:'string',required:true},budget:{type:'object',additionalProperties:false,properties:{maxOperations:{type:'number'},maxNoProgress:{type:'number'},maxElapsedMs:{type:'number'},maxObservedTokens:{type:'number'}}}},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text' as const,text:JSON.stringify(value)}]},
    async execute(args:{communicationHandle:string;objective:string;members:string[];requestId:string;budget?:import('./collaboration.ts').CollaborationBudget},exec) {
      if(typeof args.requestId !== 'string' || !/^[\w-]{8,120}$/.test(args.requestId)) throw new Error('invalid task requestId')
      return (await ready).declareTask(args,exec) as unknown as Record<string, JsonValue>
    },
  })))
  // Calls still receive the original failure; startup must not produce an unhandled rejection.
  void ready.catch(() => {})
  const common = { scopeId: { type: 'string' as const, required: true, description: 'Approved collaboration scope identity.' } }
  const task = { taskId: { type: 'string' as const, required: true, description: 'Exact collaboration task.' }, taskRevision: { type: 'number' as const, required: true, description: 'Current task revision; old results are retained without restarting an old plan.' } }
  const strings = { type: 'array' as const, items: { type: 'string' as const } }
  const legacy = new Map<string,ToolDefinition>()
  const register = (name: string, description: string, parameters: Record<string, unknown>, execute: (runtime: CollaborationRuntime, args: any, exec: any) => Promise<unknown>) => {
    const make = (description:string,parameters:Record<string,unknown>,toolName='session_coordinator_collaboration_'+name) => diagnosticTool(env.ctx, defineTool({ name: toolName, description, parameters: parameters as never,
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text' as const, text: JSON.stringify(modelReceipt(name, args, value)) }] },
      async execute(args: any, exec) {
        try { const runtime=await ready;const input=await runtime.legacyToolArguments(name,structuredClone(args),exec);return await execute(runtime,input,exec) as Record<string, JsonValue> }
        catch (error) {
          if (error instanceof HarnessError || exec.signal.aborted) throw error
          throw new HarnessError(error instanceof Error ? error.message : String(error), 'COLLABORATION_REJECTED', { cause: error })
        }
      },
    }))
    legacy.set(name,make('Compatibility for an existing legacy session-collaboration scope only. '+description,parameters))
    if(name==='send'||name==='control'){
      const fields=name==='send'?['taskHandle','sessionId','message','intent','notBefore','operationId','materials']:['taskHandle','action','question','questionId','options','reason']
      const modern=Object.fromEntries(Object.entries(parameters).filter(([key])=>fields.includes(key)))
      modern.taskHandle={type:'string',required:true}
      if(name==='send'){modern.notBefore={type:'number',description:'Required for sending: absolute Unix milliseconds. Use core send for immediate work.'};modern.intent={type:'string',enum:['task','context']};modern.action={type:'string',enum:['edit','withdraw']};modern.reason={type:'string'};for(const key of ['sessionId','message'])modern[key]=Object.fromEntries(Object.entries(modern[key] as object).filter(([field])=>field!=='required'))}
      else modern.action={type:'string',required:true,enum:['question']}
      env.ctx.tools.register(make(name==='send'?'Optional absolute-time scheduling for a current task. Sending requires taskHandle, sessionId, message and notBefore. To edit or withdraw an exact not-yet-delivered schedule, use taskHandle, operationId, action=edit|withdraw and reason (message only for edit); no sessionId/notBefore. Once delivered use core message control. Ordinary immediate messages use session_coordinator_send. Preserve operationId for exact retries; pause/cancel/recovery constraints remain enforced.':'Optional business question for a current task. Requires taskHandle and action=question; questionId routes an existing question. An answer is not a permission approval. State changes use session_coordinator_control.',modern,'session_coordinator_'+(name==='send'?'schedule':'question')))
    }
  }
  register('task', 'Owner creates one independently tracked task inside the approved collaboration. Reuse the scope for multiple tasks; Select members using the short memberRef values in start/status.memberDirectory (for example member:2); copy those references, never invent or reconstruct session IDs. Exact canonical session IDs remain supported. References are local to the supplied scopeId. The owner is already included implicitly; listing its returned memberRef is harmless and is normalized away. Include the other implementation and review chats in this task when they need to exchange work or review feedback; sharing a scope alone does not authorize cross-task communication.', { ...common, objective: { type: 'string', required: true }, members: { ...strings, required: true } }, (r, a, e) => r.addTask(a, e))
  register('send', 'For optional tasks use taskHandle, sessionId, message and notBefore (epoch milliseconds) to defer work until that clock time; ordinary immediate messages use session_coordinator_send. taskHandle defaults to task intent (adaptive delivery after the deadline), context does not wake the target. Keep operationId for retries. Legacy: dispatch work or feedback inside this approved collaboration task, including remaining work after restart recovery. Put business instructions in message; routing is supplied by the runtime. Never invent an operationId in the message or tell the recipient to copy an unreturned result correlation ID. For intent=task an offline member is automatically loaded with its own saved model/preset; do not call standalone session_coordinator_resume first. A reopened scope or paused task must first pass collaboration_control(action=resume); inspect existing operations and effects before dispatching missing work. Also supports context without waking or precise active-execution correction. task queues authorized work; context never starts work; steer requires expectedExecution from status. Both sender and recipient must be authorized for this task. Approved task scopes permit continued rounds, including a third and later task/result message, without a new human message each round. Inspect unknown operations; never resend them under a new identity or fall back to legacy send to bypass a refusal.', { scopeId:{type:'string'},taskId:{type:'string'},taskRevision:{type:'number'},taskHandle:{type:'string'},
    sessionId: { type: 'string', required: true, description: 'Copy a short memberRef from this scope’s start/status.memberDirectory, or its exact sessionId. Never reconstruct an opaque ID. Task membership is still enforced.' }, message: { type: 'string', required: true }, intent: { type: 'string', enum: ['task', 'context', 'steer'] }, notBefore: { type: 'number', description: 'Epoch milliseconds for application-live deferred work. Pause/cancel prevents firing; reopening requires explicit resume.' }, operationId: { type: 'string' }, expectedExecution: { type: 'string' }, materials: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['file', 'image'], required: true }, path: { type: 'string', required: true }, mediaType: { type: 'string' } } } },
  }, (r, a, e) => a.taskHandle !== undefined ? a.action!==undefined?r.controlDeferredTask(a,e):r.sendDeferredTask(a,e) : r.send(a, e))
  register('result', 'Reply with business text/evidence only for the current native collaboration input: normally omit scopeId, taskId, taskRevision and operationId. The runtime binds the actual caller and exactly one claimed operation included in its current native model request. If multiple inputs are present, select their exact native task/operation; never reconstruct IDs from message prose. Explicit full identities still support exact late results. Reply with the result of this session’s exact collaboration task operation; use this for source.kind=session-collaboration instead of legacy send/replyTo. Saves evidence before notifying the owner, deduplicates notifications, preserves late/old results, and never resumes paused/completed/cancelled work. A result can lead to another approved work/review round; it is not a terminal legacy reply.', { scopeId: { type: 'string' }, taskId: { type: 'string' }, taskRevision: { type: 'number' }, operationId: { type: 'string', description: 'Prefer omitting: the runtime binds only when exactly one task operation for this scope/task/revision was included in the current native model request, including repeat result deduplication. If ambiguous, copy its exact ID from the native collaboration envelope/status. Business text labels never override that identity.' }, text: { type: 'string', required: true }, evidence: strings, resultId: { type: 'string' } }, (r, a, e) => r.result(a, e))
  register('control', 'For a current optional task, action=question accepts taskHandle plus question/options, or the exact questionId routed by a collaborator. A business answer is not permission approval. Use session_coordinator_control for task state changes. Legacy owner-only: pause, resume or cancel a COLLABORATION TASK with scopeId + taskId; omit taskId only to control the whole scope. This is the task-control entry even when each task has its own independent chat. Task cancel interrupts an exclusively owned running turn, or stops only this task at the next safe boundary when other work shares that turn. For restart recovery, inspect the original operation and external effects, resume the scope and any paused/recovery-required task through this tool, then dispatch only missing work with collaboration_send; offline members are loaded by that send, so no standalone session_coordinator_resume or /coordinate grant is needed. pause/resume/revise/cancel require native user approval; finish is the owner Agent’s evidence-based business acceptance. First finish each accepted task with taskId, valid resultIds and reason; after every task is completed, omit taskId and retain accepted resultIds to finish the scope and confirm its state=completed before presenting final successful delivery. If any task is cancelled or failed, preserve that terminal state: close the remaining scope with action=cancel or action=fail without taskId. Never change a cancelled/failed task to completed or use legacy whole-session cancel to close a collaboration scope. Plan checklists and assistant final answers do not commit task/scope completion. Cancel withdraws only exact pending task inputs, never clears unrelated work. Finish requires current-revision results and current material versions. revalidate associates preserved business evidence with a revised objective; it never refreshes attachment snapshots or bypasses material verification. After a reviewed source changes, inspect it and obtain a fresh read-only review operation with current materials, then finish with that fresh resultId; do not repeat completed business effects. Stops do not delete chats. Returns a compact receipt for the selected task/operation/question; use status for complete work bodies, history and result evidence.', { scopeId: {type:'string'}, taskHandle:{type:'string'},
    taskId: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'revise', 'finish', 'cancel', 'block', 'fail', 'revalidate', 'question', 'edit', 'withdraw'], required: true }, operationId: { type: 'string' }, message: { type: 'string' }, question: { type: 'string' }, questionId: { type: 'string' }, options: strings, reason: { type: 'string', required: true, description: 'Concrete control decision and evidence. For finish, explain why current-revision resultIds satisfy the objective.' }, objective: { type: 'string' }, resultIds: { ...strings, description: 'Required for finish/revalidate: exact persisted evidence result IDs for this task’s current revision.' }, waitReason: { type: 'string', enum: ['approval', 'user-input', 'collaborator', 'capacity', 'external-dependency'] },
  }, (r, a, e) => a.taskHandle !== undefined ? r.questionForTask(a,e) : r.control(a, e))
  register('status', 'Read persistent collaboration scope/task state, exact operations, result evidence and budget reasons, including offline members and restart recovery, without loading or starting agents. Use this for task progress and recovery; standalone session_coordinator_status only describes a currently live chat execution. Finding an offline member does not require a standalone resume before continued collaboration_send.', { scopeId: { type: 'string' } }, async (r, a, e) => a.scopeId ? r.status(a, e) : { scopes: await r.status(a, e) })
  register('wait', 'Wait for any/all named tasks’ correlated results; stopping the wait never cancels work. done means this wait condition is ready, not that the tasks or scope are completed: results can arrive while a task is active, and terminal failed tasks can end an all-wait with partial results. Inspect tasks and result evidence, then explicitly control finish each accepted task and finally the scope before final successful delivery. afterResultIds excludes already consumed results. Native execution failures return needsAttention=true and attention facts immediately; done still follows any/all readiness. Inspect original operations before retrying.', { ...common, taskIds: strings, mode: { type: 'string', enum: ['any', 'all'] }, afterResultIds: strings, timeoutMs: { type: 'number' } }, (r, a, e) => r.wait(a, e))
  env.toolSurface?.dispose()
  env.toolSurface=new SessionToolSurface(env,ready,legacy)
  env.ctx.effect?.(() => () => { if (!initialized) startup.abort(new Error('Collaboration installation disposed')); void ready.then(runtime => runtime.close()).catch(() => {}) })
  return ready
}
