import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BridgeEnv } from './tools.ts'
import type { CollaborationStore } from './collaboration-store.ts'
import { CollaborationRuntime, type CollaborationControl, type CollaborationOperation, type CollaborationScope } from './collaboration.ts'

function modelReceipt(name: string, args: Partial<CollaborationControl>, value: unknown): unknown {
  if (name === 'send') {
    const { wire, ...operation } = value as CollaborationOperation
    return operation
  }
  if (name !== 'control') return value
  const scope = value as CollaborationScope
  const taskId = args.taskId ?? scope.operations[args.operationId ?? '']?.taskId ?? scope.questions[args.questionId ?? '']?.taskId
  const relevantTask = (id: string) => taskId === undefined || id === taskId
  const operations = Object.entries(scope.operations).filter(([id, operation]) => args.operationId ? id === args.operationId : relevantTask(operation.taskId))
  const operationIds = new Set(operations.map(([id]) => id))
  return {
    id: scope.id, owner: scope.owner, revision: scope.revision, state: scope.state, reason: scope.reason,
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
      startup.signal.throwIfAborted()
      const runtime = await CollaborationRuntime.open(env, store)
      initialized = true
      return runtime
    } catch (error) {
      if (!options.store) await store.close().catch(() => {})
      throw error
    }
  })()
  // Calls still receive the original failure; startup must not produce an unhandled rejection.
  void ready.catch(() => {})
  const common = { scopeId: { type: 'string' as const, required: true, description: 'Approved collaboration scope identity.' } }
  const task = { taskId: { type: 'string' as const, required: true, description: 'Exact collaboration task.' }, taskRevision: { type: 'number' as const, required: true, description: 'Current task revision; old results are retained without restarting an old plan.' } }
  const strings = { type: 'array' as const, items: { type: 'string' as const } }
  const register = (name: string, description: string, parameters: Record<string, unknown>, execute: (runtime: CollaborationRuntime, args: any, exec: any) => Promise<unknown>) => {
    env.ctx.tools.register(defineTool({ name: 'session_coordinator_collaboration_' + name, description, parameters: parameters as never,
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text' as const, text: JSON.stringify(modelReceipt(name, args, value)) }] },
      async execute(args: any, exec) {
        try { return await execute(await ready, structuredClone(args), exec) as Record<string, JsonValue> }
        catch (error) {
          if (error instanceof HarnessError || exec.signal.aborted) throw error
          throw new HarnessError(error instanceof Error ? error.message : String(error), 'COLLABORATION_REJECTED', { cause: error })
        }
      },
    }))
  }
  register('start', 'Create a persistent owner + N collaboration between real independent main chats. For user-requested new chats/sessions (新会话/独立会话) that jointly deliver work, review and revise, create them through newSessions; they have their own history, appear in the sidebar and can be reopened. They are not temporary team/subagents, even when the task involves parallel roles. Reuse existing chats through members. ONE native approval covers the explicit objective, members and budgets across multiple tasks and rounds; the legacy send third-hop rule does not apply. Approval does not extend old one-call permissions. Reopening requires explicit resume, never automatic resending.', {
    objective: { type: 'string', required: true }, members: strings, newSessions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { cwd: { type: 'string' }, workspaceId: { type: 'string' }, title: { type: 'string' }, agentPreset: { type: 'string' }, provider: { type: 'string', description: 'Omit to inherit the calling chat’s provider. Override only for an explicit need after verifying the target provider/model route is available.' }, model: { type: 'string', description: 'Omit to inherit the calling chat’s model. Override only for an explicit need after verifying the exact model is available on the selected provider.' }, reasoningEffort: { type: 'string', description: 'Omit to inherit the caller’s configured effort. Override only for an explicit need after verifying the selected provider/model supports the exact value. Effort levels are model-specific; do not assume a universal low/medium/high enum or silently substitute a fallback.' } } } }, budget: { type: 'object', additionalProperties: false, properties: { maxOperations: { type: 'number' }, maxNoProgress: { type: 'number' }, maxElapsedMs: { type: 'number' }, maxObservedTokens: { type: 'number', description: 'Optional cumulative observed token cap across scope members: each call adds inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens, including repeated/history prompts and cached input. This is not an output-token limit or a currency budget; shared work can contribute. Set only when the user or an established policy actually specifies a token cap. Otherwise omit this property and keep maxOperations/maxElapsedMs/maxNoProgress guards. Do not invent a cap from answer length or automatically remove, raise or replace an already approved cap.' } } },
  }, (r, a, e) => r.start(a, e))
  register('task', 'Owner creates one independently tracked task inside the approved collaboration. Reuse the scope for multiple tasks; members must be in the approved scope. Include both implementation and review chats in this task when they need to exchange work or review feedback; sharing a scope alone does not authorize cross-task communication.', { ...common, objective: { type: 'string', required: true }, members: { ...strings, required: true } }, (r, a, e) => r.addTask(a, e))
  register('send', 'Dispatch work or feedback inside this approved collaboration task, including remaining work after restart recovery. For intent=task an offline member is automatically loaded with its own saved model/preset; do not call standalone session_coordinator_resume first. A reopened scope or paused task must first pass collaboration_control(action=resume); inspect existing operations and effects before dispatching missing work. Also supports context without waking or precise active-execution correction. task queues authorized work; context never starts work; steer requires expectedExecution from status. Both sender and recipient must be authorized for this task. Approved task scopes permit continued rounds, including a third and later task/result message, without a new human message each round. Inspect unknown operations; never resend them under a new identity or fall back to legacy send to bypass a refusal.', { ...common, ...task,
    sessionId: { type: 'string', required: true }, message: { type: 'string', required: true }, intent: { type: 'string', enum: ['task', 'context', 'steer'], required: true }, notBefore: { type: 'number', description: 'Epoch milliseconds for application-live deferred work. Pause/cancel prevents firing; reopening requires explicit resume.' }, operationId: { type: 'string' }, expectedExecution: { type: 'string' }, materials: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['file', 'image'], required: true }, path: { type: 'string', required: true }, mediaType: { type: 'string' } } } },
  }, (r, a, e) => r.send(a, e))
  register('result', 'Reply with the result of this session’s exact collaboration task operation; use this for source.kind=session-collaboration instead of legacy send/replyTo. Saves evidence before notifying the owner, deduplicates notifications, preserves late/old results, and never resumes paused/completed/cancelled work. A result can lead to another approved work/review round; it is not a terminal legacy reply.', { ...common, ...task, operationId: { type: 'string', required: true }, text: { type: 'string', required: true }, evidence: strings, resultId: { type: 'string' } }, (r, a, e) => r.result(a, e))
  register('control', 'Owner-only: pause, resume or cancel a COLLABORATION TASK with scopeId + taskId; omit taskId only to control the whole scope. This is the task-control entry even when each task has its own independent chat. Task cancel interrupts an exclusively owned running turn, or stops only this task at the next safe boundary when other work shares that turn. For restart recovery, inspect the original operation and external effects, resume the scope and any paused/recovery-required task through this tool, then dispatch only missing work with collaboration_send; offline members are loaded by that send, so no standalone session_coordinator_resume or /coordinate grant is needed. pause/resume/revise/cancel require native user approval; finish is the owner Agent’s evidence-based business acceptance. First finish each accepted task with taskId, valid resultIds and reason; after every task is completed, omit taskId and retain accepted resultIds to finish the scope and confirm its state=completed before presenting final successful delivery. If any task is cancelled or failed, preserve that terminal state: close the remaining scope with action=cancel or action=fail without taskId. Never change a cancelled/failed task to completed or use legacy whole-session cancel to close a collaboration scope. Plan checklists and assistant final answers do not commit task/scope completion. Cancel withdraws only exact pending task inputs, never clears unrelated work. Finish requires current-revision results. Stops do not delete chats. Returns a compact receipt for the selected task/operation/question; use status for complete work bodies, history and result evidence.', { ...common,
    taskId: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'revise', 'finish', 'cancel', 'block', 'fail', 'revalidate', 'question', 'edit', 'withdraw'], required: true }, operationId: { type: 'string' }, message: { type: 'string' }, question: { type: 'string' }, questionId: { type: 'string' }, options: strings, reason: { type: 'string', required: true, description: 'Concrete control decision and evidence. For finish, explain why current-revision resultIds satisfy the objective.' }, objective: { type: 'string' }, resultIds: { ...strings, description: 'Required for finish/revalidate: exact persisted evidence result IDs for this task’s current revision.' }, waitReason: { type: 'string', enum: ['approval', 'user-input', 'collaborator', 'capacity', 'external-dependency'] },
  }, (r, a, e) => r.control(a, e))
  register('status', 'Read persistent collaboration scope/task state, exact operations, result evidence and budget reasons, including offline members and restart recovery, without loading or starting agents. Use this for task progress and recovery; standalone session_coordinator_status only describes a currently live chat execution. Finding an offline member does not require a standalone resume before continued collaboration_send.', { scopeId: { type: 'string' } }, async (r, a, e) => a.scopeId ? r.status(a, e) : { scopes: await r.status(a, e) })
  register('wait', 'Wait for any/all named tasks’ correlated results; stopping the wait never cancels work. done means this wait condition is ready, not that the tasks or scope are completed: results can arrive while a task is active, and terminal failed tasks can end an all-wait with partial results. Inspect tasks and result evidence, then explicitly control finish each accepted task and finally the scope before final successful delivery. afterResultIds excludes already consumed results. Native execution failures return needsAttention=true and attention facts immediately; done still follows any/all readiness. Inspect original operations before retrying.', { ...common, taskIds: strings, mode: { type: 'string', enum: ['any', 'all'] }, afterResultIds: strings, timeoutMs: { type: 'number' } }, (r, a, e) => r.wait(a, e))
  env.ctx.effect?.(() => () => { if (!initialized) startup.abort(new Error('Collaboration installation disposed')); void ready.then(runtime => runtime.close()).catch(() => {}) })
  return ready
}
