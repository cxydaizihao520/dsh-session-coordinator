/** Persistent task authority; Agents choose business work and completion. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { MessageId, HarnessError, isAgentLoopRequest, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { BridgeEnv } from './tools.ts'
import { isUserFacingSource, resolveTargetCwd, type LiveAgentLike } from './core.ts'
import { createBridgeSession, validateBridgeSessionModel, type CreateBridgeSessionOptions } from './session-create.ts'
import { requestCoordinationApproval } from './delivery.ts'
import type { CollaborationMaterialInput } from './collaboration-materials.ts'
import type { CollaborationStore, StoredCollaborationRecord, JsonValue } from './collaboration-store.ts'

/** Scope membership is immutable; short references never replace canonical stored identities. */
export function collaborationMemberDirectory(scope: CollaborationScope) {
  return scope.members.map((sessionId, index) => ({ memberRef: scope.members.includes('member:' + (index + 1)) ? sessionId : 'member:' + (index + 1), sessionId,
    ...(scope.creations[sessionId]?.config.title ? { title: scope.creations[sessionId]!.config.title } : {}),
    role: sessionId === scope.owner ? 'owner' : 'member' }))
}

export function resolveCollaborationMember(scope: CollaborationScope, reference: string): string {
  return scope.members.includes(reference) ? reference : collaborationMemberDirectory(scope).find(member => member.memberRef === reference)?.sessionId ?? reference
}

export type CollaborationIntent = 'task' | 'context' | 'steer' | 'result'
export interface CollaborationSource {
  kind: 'session-collaboration'
  presentationVersion?: 2
  senderTitle?: string
  scopeId: string
  taskId: string
  taskRevision: number
  operationId: string
  senderSessionId: string
  ownerSessionId: string
  intent: CollaborationIntent
}
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap { 'session-collaboration': CollaborationSource }
}
export interface CollaborationExecution { agent?: unknown; signal: AbortSignal; callId?: string }
export interface CollaborationBudget { maxOperations?: number; maxNoProgress: number; maxElapsedMs: number; maxObservedTokens?: number }
export type CollaborationState = 'active' | 'paused' | 'blocked' | 'budget-exhausted' | 'usage-limited' | 'recovery-required' | 'completed' | 'cancelled' | 'failed'
export interface CollaborationTask {
  id: string; objective: string; revision: number; members: string[]; state: CollaborationState
  scheduling: 'ready' | 'waiting' | 'stopped'; waitReason?: string; reason?: string
  createdAt: number; updatedAt: number; noProgress: number; resultIds: string[]; acceptedResultIds: string[]
  humanInputs?: Array<{ messageId: string; sessionId: string; seq: number; text: string; time: number }>
  attention?: { id: string; taskRevision: number; sessionId: string; execution: string; turn: number; code: string; message: string; operationIds: string[] }
  contextIds?: string[]
  environments?: Record<string, JsonValue>
  materialOperations?: Record<string, JsonValue>
  history: Array<{ revision: number; objective: string; reason: string; time: number }>
}
export interface CollaborationOperation {
  id: string; taskId: string; taskRevision: number; sender: string; target: string; text: string
  intent: CollaborationIntent; status: 'scheduled' | 'prepared' | 'submitted' | 'claimed' | 'admitted' | 'withdrawn' | 'discarded' | 'unknown' | 'rejected'
  createdAt: number; notBefore?: number; execution?: string; turn?: number; error?: string; resultId?: string
  requestInclusion?: { evidence: 'native-llm-stream'; execution: string; step: number; time: number }
  control?: string
  wire?: UserMessage; materials?: CollaborationMaterialInput[]; artifacts?: JsonValue[]
}
export interface CollaborationResult {
  id: string; taskId: string; taskRevision: number; operationId: string; sender: string; text: string
  evidence: string[]; createdAt: number; stale: boolean
}
export interface CollaborationQueueMutation { id: string; operationId: string; kind: 'edit' | 'withdraw'; status: 'prepared' | 'applied' | 'not-pending' | 'unknown'; before: UserMessage; after?: UserMessage; error?: string }
export interface CollaborationQuestion { id: string; taskId: string; taskRevision: number; requestedBy: string; text: string; options: string[]; state: 'routed' | 'asking' | 'answered' | 'cancelled' | 'recovery-required'; nativeCallId?: string; nativeSessionId?: string; answer?: JsonValue; error?: string }
export interface CollaborationUsage { sessionId: string; seq: number; turn: number; taskIds: string[]; shared: boolean; tokens?: number; raw?: Record<string, number> }
export interface CollaborationScope {
  schemaVersion: 1
  mutations: Record<string, CollaborationQueueMutation>
  questions: Record<string, CollaborationQuestion>
  creations: Record<string, { config: CollaborationNewSession; status: 'prepared' | 'created' | 'unknown'; error?: string }>
  usage: Record<string, CollaborationUsage>
  id: string; owner: string; revision: number; objective: string; members: string[]; state: CollaborationState; reason?: string
  createdAt: number; updatedAt: number; authorization: { kind: 'native-scoped-approval'; callId: string; process: string; approvedAt: number; objective: string; members: string[] }
  budget: CollaborationBudget; observedTokens: number; usageIncomplete: boolean
  nativeWaits?: Record<string, { id: string; sessionId: string; execution: string; callId?: string; toolName: string; taskIds: string[]; taskRevisions: Record<string, number>; shared: boolean; state: 'waiting' | 'decided' | 'recovery-required'; outcome?: string }>
  executions?: Record<string, string>
  tasks: Record<string, CollaborationTask>; operations: Record<string, CollaborationOperation>; results: Record<string, CollaborationResult>
}
export type CollaborationNewSession = Pick<CreateBridgeSessionOptions, 'cwd' | 'workspaceId' | 'title' | 'agentPreset' | 'provider' | 'model' | 'reasoningEffort'>
export interface CollaborationStart { objective: string; members?: string[]; newSessions?: CollaborationNewSession[]; budget?: Partial<CollaborationBudget> }
export interface CollaborationSend { scopeId: string; taskId: string; taskRevision: number; sessionId: string; message: string; intent: 'task' | 'context' | 'steer'; operationId?: string; expectedExecution?: string; notBefore?: number; materials?: CollaborationMaterialInput[] }
export interface CollaborationResultInput { scopeId?: string; taskId?: string; taskRevision?: number; operationId?: string; text: string; evidence?: string[]; resultId?: string }
export interface CollaborationControl {
  scopeId: string; taskId?: string; action: 'pause' | 'resume' | 'revise' | 'finish' | 'cancel' | 'block' | 'fail' | 'revalidate' | 'question' | 'edit' | 'withdraw'
  reason?: string; objective?: string; resultIds?: string[]; waitReason?: string; question?: string; questionId?: string; options?: string[]; operationId?: string; message?: string
}
interface ScopedDelivery {
  deliverScoped(targetId: string, message: UserMessage, caller: LiveAgentLike, options: {
    mode: 'context' | 'steer' | 'queue'; signal?: AbortSignal
    prepareMessage?(target: LiveAgentLike): Promise<UserMessage>
    validate(target?: LiveAgentLike): void; beforeSubmit?(target: LiveAgentLike): void
  }): Promise<{ messageId: string; sinceSeq: number }>
}
const stopped = new Set<CollaborationState>(['completed', 'cancelled', 'failed'])
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' must be a non-empty string')
  return value.trim()
}
function bodyText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' must be a non-empty string')
  return value
}
function names(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(x => typeof x !== 'string' || !x.trim())) throw new Error(name + ' must be a non-empty session set')
  return [...new Set(value.map(x => x.trim()))].sort()
}
function identity(prefix: string, ...values: unknown[]): string { return prefix + createHash('sha256').update(JSON.stringify(values)).digest('hex') }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function json(scope: CollaborationScope): Record<string, JsonValue> { return scope as unknown as Record<string, JsonValue> }
const idSchema = z.string().min(1)
const integerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const stateSchema = z.enum(['active', 'paused', 'blocked', 'budget-exhausted', 'usage-limited', 'recovery-required', 'completed', 'cancelled', 'failed'])
const taskSchema = z.object({
  id: idSchema, objective: idSchema, revision: integerSchema.min(1), members: z.array(idSchema).min(1), state: stateSchema,
  attention: z.object({ id: idSchema, taskRevision: integerSchema.min(1), sessionId: idSchema, execution: idSchema, turn: integerSchema, code: idSchema, message: idSchema, operationIds: z.array(idSchema).min(1) }).optional(),
  scheduling: z.enum(['ready', 'waiting', 'stopped']), createdAt: integerSchema, updatedAt: integerSchema, noProgress: integerSchema,
  resultIds: z.array(idSchema), acceptedResultIds: z.array(idSchema), history: z.array(z.object({ revision: integerSchema.min(1), objective: idSchema, reason: idSchema, time: integerSchema })),
}).passthrough()
const operationSchema = z.object({
  id: idSchema, taskId: idSchema, taskRevision: integerSchema.min(1), sender: idSchema, target: idSchema, text: idSchema,
  intent: z.enum(['task', 'context', 'steer', 'result']), status: z.enum(['scheduled', 'prepared', 'submitted', 'claimed', 'admitted', 'withdrawn', 'discarded', 'unknown', 'rejected']), createdAt: integerSchema,
}).passthrough()
const scopeSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, owner: idSchema, revision: integerSchema.min(1), objective: idSchema, members: z.array(idSchema).min(2), state: stateSchema,
  createdAt: integerSchema, updatedAt: integerSchema,
  authorization: z.object({ kind: z.literal('native-scoped-approval'), callId: idSchema, process: idSchema, approvedAt: integerSchema, objective: idSchema, members: z.array(idSchema).min(2) }),
  budget: z.object({ maxOperations: integerSchema.min(1).optional(), maxNoProgress: integerSchema.min(1), maxElapsedMs: integerSchema.min(1), maxObservedTokens: integerSchema.min(1).optional() }),
  observedTokens: integerSchema, usageIncomplete: z.boolean(),
  tasks: z.record(idSchema, taskSchema), operations: z.record(idSchema, operationSchema),
  results: z.record(idSchema, z.object({ id: idSchema, taskId: idSchema, taskRevision: integerSchema.min(1), operationId: idSchema, sender: idSchema, text: idSchema, evidence: z.array(idSchema), createdAt: integerSchema, stale: z.boolean() })),
  // Early v1 records predate these optional capabilities; migration never restores their authority.
  usage: z.record(idSchema, z.unknown()).default({}), creations: z.record(idSchema, z.unknown()).default({}),
  questions: z.record(idSchema, z.unknown()).default({}), mutations: z.record(idSchema, z.unknown()).default({}),
  nativeWaits: z.record(idSchema, z.object({ id: idSchema, sessionId: idSchema, execution: idSchema, callId: idSchema.optional(), toolName: idSchema,
    taskIds: z.array(idSchema).min(1), taskRevisions: z.record(idSchema, integerSchema.min(1)), shared: z.boolean(), state: z.enum(['waiting', 'decided', 'recovery-required']), outcome: idSchema.optional() })).optional(),
}).passthrough()
function validScope(record: StoredCollaborationRecord): CollaborationScope {
  const parsed = scopeSchema.safeParse(record.data)
  const invalid = () => new Error('invalid persisted collaboration ' + record.id)
  if (!parsed.success) throw invalid()
  const scope = parsed.data as unknown as CollaborationScope
  if (scope.id !== record.id || scope.owner !== record.owner || scope.revision !== record.revision || !scope.members.includes(scope.owner) || new Set(scope.members).size !== scope.members.length ||
    scope.authorization.objective !== scope.objective || !isDeepStrictEqual([...scope.authorization.members].sort(), [...scope.members].sort())) throw invalid()
  for (const [id, task] of Object.entries(scope.tasks)) {
    if (task.id !== id || task.members.some(member => member === scope.owner || !scope.members.includes(member)) || new Set(task.members).size !== task.members.length ||
      [...task.resultIds, ...task.acceptedResultIds].some(resultId => scope.results[resultId]?.taskId !== id)) throw invalid()
    if (task.attention && (task.attention.taskRevision > task.revision || task.attention.operationIds.some(operationId => {
      const op = scope.operations[operationId]
      return !op || op.taskId !== id || op.target !== task.attention!.sessionId || op.execution !== task.attention!.execution || op.turn !== task.attention!.turn || op.taskRevision !== task.attention!.taskRevision
    }))) throw invalid()
  }
  for (const [id, op] of Object.entries(scope.operations)) {
    if (op.id !== id || !scope.tasks[op.taskId] || op.taskRevision > scope.tasks[op.taskId]!.revision || !scope.members.includes(op.sender) || !scope.members.includes(op.target)) throw invalid()
    if (op.wire) {
      const source = op.wire.source as CollaborationSource
      if (op.wire.id !== id || op.wire.role !== 'user' || !Array.isArray(op.wire.content) || !op.wire.content.length || !source || source.kind !== 'session-collaboration' || source.scopeId !== scope.id || source.taskId !== op.taskId || source.taskRevision !== op.taskRevision || source.operationId !== id || source.senderSessionId !== op.sender || source.ownerSessionId !== scope.owner || source.intent !== op.intent) throw invalid()
    }
  }
  for (const [id, result] of Object.entries(scope.results)) {
    const op = scope.operations[result.operationId]
    if (result.id !== id || !op || op.target !== result.sender || op.taskId !== result.taskId || op.taskRevision !== result.taskRevision || op.resultId !== id) throw invalid()
  }
  for (const creation of Object.values(scope.creations)) if (!creation || !['prepared', 'created', 'unknown'].includes(creation.status) || !creation.config || typeof creation.config !== 'object') throw invalid()
  for (const mutation of Object.values(scope.mutations)) if (!mutation || !['prepared', 'applied', 'not-pending', 'unknown'].includes(mutation.status) || !scope.operations[mutation.operationId]) throw invalid()
  for (const question of Object.values(scope.questions)) if (!question || !scope.tasks[question.taskId] || !scope.members.includes(question.requestedBy) || !['routed', 'asking', 'answered', 'cancelled', 'recovery-required'].includes(question.state)) throw invalid()
  return structuredClone(scope)
}

export class CollaborationRuntime {
  private readonly process = randomUUID()
  private readonly scopes = new Map<string, CollaborationScope>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly executions = new WeakMap<LiveAgentLike, { id: string; turn: number; step: number; inputs: Map<string, UserMessage>; claimed: Set<string>; requestOperations: Set<string> }>()
  private readonly instances = new WeakMap<LiveAgentLike, string>()
  private readonly taskOperations = new Set<{ scopeId: string; taskId: string; revision: number; controller: AbortController; done: Promise<void> }>()
  private closing = false
  private active = true
  private storageFailure?: string
  private timer?: unknown
  private dueRunning = false
  private readonly questionControllers = new Map<string, AbortController>()
  private readonly disposers: Array<() => unknown> = []
  private readonly env: BridgeEnv
  readonly store: CollaborationStore
  private constructor(env: BridgeEnv, store: CollaborationStore) { this.env = env; this.store = store }

  static async open(env: BridgeEnv, store: CollaborationStore): Promise<CollaborationRuntime> {
    const runtime = new CollaborationRuntime(env, store)
    for (const record of await store.list()) {
      if (!record.id.startsWith('collab-')) continue
      const scope = validScope(record)
      runtime.scopes.set(scope.id, scope)
      if (!stopped.has(scope.state)) await runtime.change(scope.id, next => {
        for (const task of Object.values(next.tasks)) for (const value of Object.values(task.materialOperations ?? {})) { const operation = value as { status?: string; error?: string } | null; if (operation?.status === 'prepared') { operation.status = 'unknown'; operation.error = 'Material/environment operation acceptance unknown after reopen; inspect original request identity' } }
        for (const mutation of Object.values(next.mutations)) if (mutation.status === 'prepared') { mutation.status = 'unknown'; mutation.error = 'Queue mutation acceptance unknown after reopen; inspect original operation' }
        for (const wait of Object.values(next.nativeWaits ?? {})) if (wait.state === 'waiting') wait.state = 'recovery-required'
        for (const question of Object.values(next.questions)) if (question.state === 'asking') {
          question.state = 'recovery-required'; question.error = 'Previous native question request is no longer a live answer channel'
          if (next.tasks[question.taskId]?.waitReason === 'user-input') next.tasks[question.taskId]!.waitReason = 'recovery-required'
        }
        for (const creation of Object.values(next.creations)) if (creation.status === 'prepared') { creation.status = 'unknown'; creation.error = 'Creation acceptance unknown after reopen; inspect the reserved session identity' }
        if (next.state !== 'paused') { next.state = 'recovery-required'; next.reason = 'Reopened: explicit resume and execution reconciliation required' }
        for (const operation of Object.values(next.operations)) if (['prepared', 'submitted', 'claimed'].includes(operation.status)) {
          operation.status = 'unknown'; operation.error = 'Previous process ended before a verified admission outcome; inspect, never resend'
        }
      })
    }
    runtime.observe()
    if ([...runtime.scopes.values()].some(scope => Object.values(scope.operations).some(op => op.status === 'scheduled'))) runtime.ensureTimer()
    return runtime
  }

  private caller(exec: CollaborationExecution): LiveAgentLike {
    exec.signal.throwIfAborted()
    const caller = exec.agent as LiveAgentLike | undefined
    if (!this.active || !caller || this.env.ctx.agents.get(caller.id as never) !== caller) throw new Error('collaboration requires the actual live calling session')
    return caller
  }
  private scope(id: string, caller: LiveAgentLike, owner = false): CollaborationScope {
    const scope = this.scopes.get(text(id, 'scopeId'))
    if (!scope || (owner ? scope.owner !== caller.id : !scope.members.includes(caller.id))) throw new Error('collaboration scope is unknown or not authorized for this session')
    return scope
  }
  private running(scope: CollaborationScope, task?: CollaborationTask): void {
    if (this.storageFailure) throw new Error('Task storage needs recovery before scheduling: ' + this.storageFailure)
    if (!this.active || this.closing || scope.authorization.process !== this.process || scope.state !== 'active' || (task && task.state !== 'active')) throw new Error('collaboration is not active: ' + (task?.reason ?? scope.reason ?? task?.state ?? scope.state))
  }
  private task(scope: CollaborationScope, id: string, revision?: number): CollaborationTask {
    const task = scope.tasks[text(id, 'taskId')]
    if (!task || (revision !== undefined && task.revision !== revision)) throw new Error('task or task revision changed')
    return task
  }
  private member(scope: CollaborationScope, task: CollaborationTask, caller: LiveAgentLike, target?: string): void {
    if (caller.id !== scope.owner && !task.members.includes(caller.id)) throw new Error('session is not a member of this task')
    if (target !== undefined && target !== scope.owner && !task.members.includes(target)) throw new Error('target is outside this task authorization')
    if (target !== undefined && !scope.members.includes(target)) throw new Error('target is outside the approved collaboration scope')
    if (target !== undefined && scope.creations[target] && scope.creations[target]!.status !== 'created') throw new Error('new member creation is unconfirmed; inspect its reserved identity before dispatch')
  }
  private async approval(exec: CollaborationExecution, payload: unknown, toolName = 'session_coordinator_collaboration_start'): Promise<void> {
    this.caller(exec)
    await requestCoordinationApproval(this.env.ctx, exec, toolName,
      'Approve this explicit persistent collaboration scope/control; approval covers the objective, named members and budgets shown, including multiple tasks and rounds, until paused/cancelled/revoked: ' + JSON.stringify(payload))
    this.caller(exec)
  }
  private change<T>(id: string, mutate: (scope: CollaborationScope) => T): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      if (!this.active) throw new Error('collaboration runtime closed')
      if (this.storageFailure) throw new Error('Task storage needs recovery: ' + this.storageFailure)
      const current = this.scopes.get(id)
      if (!current) throw new Error('unknown collaboration scope')
      const changed = structuredClone(current)
      const result = mutate(changed)
      changed.revision++; changed.updatedAt = Date.now()
      validScope({ id, owner: current.owner, revision: changed.revision, data: json(changed) })
      const record = await this.store.update(id, current.revision, () => ({ id, owner: current.owner, revision: changed.revision, data: json(changed) }))
      this.scopes.set(id, validScope(record))
      for (const operation of this.taskOperations) if (operation.scopeId === id) {
        const scope = this.scopes.get(id)!, task = scope.tasks[operation.taskId]
        if (scope.state !== 'active' || task?.state !== 'active' || task.revision !== operation.revision) operation.controller.abort(new Error('Task material operation revoked by state or objective revision'))
      }
      return structuredClone(result)
    })
    this.chains.set(id, next.catch(error => {
      if ((error as { code?: string })?.code === 'durability-unknown') {
        this.storageFailure = errorText(error)
        for (const operation of this.taskOperations) operation.controller.abort(new Error('Task storage needs recovery; material operation revoked'))
      }
    }))
    return next
  }
  private async settled(id: string): Promise<void> { await this.chains.get(id) }
  private instance(agent: LiveAgentLike): string {
    let id = this.instances.get(agent)
    if (!id) { id = randomUUID(); this.instances.set(agent, id) }
    return id
  }
  private checkBudget(scope: CollaborationScope, task: CollaborationTask): string | undefined {
    if (scope.budget.maxOperations !== undefined && Object.values(scope.operations).filter(op => op.status !== 'rejected').length >= scope.budget.maxOperations) return 'operation budget exhausted'
    if (task.noProgress >= scope.budget.maxNoProgress) return 'no-progress dispatch budget exhausted; review results or revise the approach'
    if (Date.now() - scope.createdAt >= scope.budget.maxElapsedMs) return 'elapsed time budget exhausted'
    if (scope.budget.maxObservedTokens !== undefined && scope.observedTokens >= scope.budget.maxObservedTokens) return 'observed token budget exhausted (missing usage is not estimated)'
    return undefined
  }

  /** Trusted plugin integrations use this transaction, never model-supplied storage records. */
  async withTask<T>(scopeId: string, taskId: string, exec: CollaborationExecution, operation: (task: CollaborationTask, scope: CollaborationScope) => T, options: { ownerOnly?: boolean } = {}): Promise<T> {
    const caller = this.caller(exec), scope = this.scope(scopeId, caller, options.ownerOnly ?? true)
    return this.change(scope.id, next => {
      this.caller(exec)
      const task = this.task(next, taskId)
      this.member(next, task, caller)
      return operation(task, next)
    })
  }

  /** Keep asynchronous material side effects bound to their exact live task revision. */
  taskOperation(scopeId: string, taskId: string, revision: number, exec: CollaborationExecution): { signal: AbortSignal; release(): void } {
    const caller = this.caller(exec), scope = this.scope(scopeId, caller, true), task = this.task(scope, taskId, revision)
    this.running(scope, task)
    if (this.closing) throw new Error('collaboration runtime closing')
    const controller = new AbortController()
    let finish!: () => void
    const operation = { scopeId, taskId, revision, controller, done: new Promise<void>(resolve => { finish = resolve }) }
    this.taskOperations.add(operation)
    return { signal: AbortSignal.any([exec.signal, controller.signal]), release: () => { this.taskOperations.delete(operation); finish() } }
  }

  async start(input: CollaborationStart, exec: CollaborationExecution): Promise<CollaborationScope> {
    const caller = this.caller(exec), objective = text(input.objective, 'objective')
    const existingMembers = input.members?.length ? names(input.members, 'members') : []
    if (input.members !== undefined && !Array.isArray(input.members)) throw new Error('invalid members')
    const requests = input.newSessions ?? []
    if (!Array.isArray(requests) || requests.length > 32 || !existingMembers.length && !requests.length) throw new Error('start requires existing members or explicit newSessions (at most 32)')
    const id = identity('collab-', caller.id, text(exec.callId, 'callId'))
    const configs: CollaborationNewSession[] = []
    const route = caller.session.requestHeader?.()?.config
    for (const request of requests) {
      if (!request || typeof request !== 'object' || Object.entries(request).some(([key, value]) => !['cwd', 'workspaceId', 'title', 'agentPreset', 'provider', 'model', 'reasoningEffort'].includes(key) || typeof value !== 'string')) throw new Error('invalid new session configuration')
      const cwd = await resolveTargetCwd(this.env.ctx, caller.session.header.cwd, request)
      this.caller(exec)
      const config: CollaborationNewSession = { ...request, cwd }
      for (const key of ['provider', 'model', 'reasoningEffort'] as const) if (!config[key] && route?.[key]) config[key] = route[key]
      await validateBridgeSessionModel(this.env.ctx, config, exec.signal)
      this.caller(exec)
      configs.push(config)
    }
    const creations: CollaborationScope['creations'] = {}
    configs.forEach((config, i) => { creations[identity('cs-', id, i)] = { config, status: 'prepared' } })
    const members = [...existingMembers, ...Object.keys(creations)].sort()
    if (members.includes(caller.id)) throw new Error('members must name collaborators; owner is included automatically')
    const budget: CollaborationBudget = { maxNoProgress: 8, maxElapsedMs: 86_400_000, ...input.budget }
    for (const [key, value] of Object.entries(budget)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid positive budget ' + key)
    const prior = this.scopes.get(id)
    if (prior) {
      if (prior.objective !== objective || JSON.stringify(prior.members) !== JSON.stringify([caller.id, ...members].sort()) || !isDeepStrictEqual(prior.budget, budget) || !isDeepStrictEqual(Object.values(prior.creations).map(c => c.config), configs)) throw new Error('callId already belongs to another collaboration')
      return structuredClone(prior)
    }
    await this.approval(exec, { objective, members: [caller.id, ...members], newSessions: creations, budget })
    const now = Date.now()
    const scope: CollaborationScope = { schemaVersion: 1, mutations: {}, questions: {}, creations, usage: {}, id, owner: caller.id, revision: 1, objective, members: [caller.id, ...members].sort(), state: 'active', createdAt: now, updatedAt: now,
      authorization: { kind: 'native-scoped-approval', callId: exec.callId!, process: this.process, approvedAt: now, objective, members: [caller.id, ...members].sort() }, budget,
      observedTokens: 0, usageIncomplete: false, tasks: {}, operations: {}, results: {} }
    this.caller(exec)
    const record = await this.store.create({ id, owner: caller.id, revision: 1, data: json(scope) })
    this.scopes.set(id, validScope(record))
    for (const [sessionId, creation] of Object.entries(creations)) {
      let attempted = false
      try {
        this.caller(exec); this.running(this.scopes.get(id)!)
        attempted = true
        await createBridgeSession(this.env.ctx, this.env.registry, { ...creation.config, sessionId, signal: exec.signal, caller: { ctx: caller.ctx, session: caller.session } })
        this.caller(exec)
        await this.change(id, next => { next.creations[sessionId]!.status = 'created' })
      } catch (error) {
        await this.change(id, next => { next.creations[sessionId]!.status = 'unknown'; next.creations[sessionId]!.error = (attempted ? 'Creation may have been accepted; do not recreate. ' : 'Creation not attempted. ') + errorText(error) })
        if (exec.signal.aborted) break
      }
    }
    return structuredClone(this.scopes.get(id)!)
  }

  async addTask(input: { scopeId: string; objective: string; members: string[] }, exec: CollaborationExecution): Promise<CollaborationTask> {
    const caller = this.caller(exec), scope = this.scope(input.scopeId, caller, true), objective = text(input.objective, 'objective')
    const resolved = names(names(input.members, 'members').map(id => resolveCollaborationMember(scope, id)), 'members')
    if (resolved.some(id => !scope.members.includes(id))) throw new Error('task members must belong to the approved scope')
    // The owner already participates; naming it explicitly does not add authority.
    const members = resolved.filter(id => id !== scope.owner)
    if (!members.length) throw new Error('task requires at least one approved collaborator besides the owner')
    const id = identity('task-', scope.id, text(exec.callId, 'callId'))
    return this.change(scope.id, next => {
      this.caller(exec); this.running(next)
      const prior = next.tasks[id]
      if (prior) { if (prior.objective !== objective || JSON.stringify(prior.members) !== JSON.stringify(members)) throw new Error('callId already belongs to another task'); return prior }
      const now = Date.now()
      const task: CollaborationTask = { id, objective, revision: 1, members, state: 'active', scheduling: 'ready', createdAt: now, updatedAt: now, noProgress: 0, resultIds: [], acceptedResultIds: [], history: [] }
      next.tasks[id] = task
      return task
    })
  }

  async send(input: CollaborationSend, exec: CollaborationExecution): Promise<CollaborationOperation> {
    const caller = this.caller(exec), scope = this.scope(input.scopeId, caller), task = this.task(scope, input.taskId, input.taskRevision)
    input = { ...input, sessionId: resolveCollaborationMember(scope, input.sessionId) }
    this.member(scope, task, caller, input.sessionId)
    if (input.sessionId === caller.id) throw new Error('cannot send collaboration work to yourself')
    if (!['task', 'context', 'steer'].includes(input.intent)) throw new Error('invalid collaboration intent')
    const operationId = input.operationId ?? identity('op-', scope.id, caller.id, text(exec.callId, 'callId'))
    text(operationId, 'operationId')
    if (input.notBefore !== undefined && (!Number.isSafeInteger(input.notBefore) || input.notBefore < 0 || input.intent === 'steer')) throw new Error('invalid deferred schedule: steer cannot be deferred')
    if (input.notBefore !== undefined && input.notBefore > Date.now() && typeof (this.env.ctx as unknown as { setInterval?: unknown }).setInterval !== 'function') throw new Error('deferred work requires the native application timer service')
    const operation: CollaborationOperation = { id: operationId, taskId: task.id, taskRevision: task.revision, sender: caller.id, target: text(input.sessionId, 'sessionId'), text: bodyText(input.message, 'message'), intent: input.intent, status: input.notBefore !== undefined && input.notBefore > Date.now() ? 'scheduled' : 'prepared', createdAt: Date.now(), ...(input.notBefore === undefined ? {} : { notBefore: input.notBefore }), ...(input.materials === undefined ? {} : { materials: structuredClone(input.materials) }) }
    const existing = scope.operations[operationId]
    if (existing) {
      if (!isDeepStrictEqual(existing.materials, operation.materials) || existing.notBefore !== operation.notBefore || ['taskId', 'taskRevision', 'sender', 'target', 'text', 'intent'].some(key => existing[key as keyof CollaborationOperation] !== operation[key as keyof CollaborationOperation])) throw new Error('operationId already belongs to another operation')
      return structuredClone(existing)
    }
    let blocked: string | undefined
    await this.change(scope.id, next => {
      this.caller(exec); this.running(next, this.task(next, task.id, task.revision))
      if (next.operations[operationId]) throw new Error('operation is already being submitted; inspect status')
      blocked = this.checkBudget(next, next.tasks[task.id]!)
      if (blocked) { next.state = 'budget-exhausted'; next.reason = blocked; return }
      operation.wire = this.message(next, operation)
      next.operations[operationId] = operation
      if (input.intent !== 'context') { next.tasks[task.id]!.noProgress++; next.tasks[task.id]!.scheduling = 'waiting'; next.tasks[task.id]!.waitReason = 'collaborator' }
    })
    if (blocked) throw new Error(blocked)
    if (operation.status === 'scheduled') { this.ensureTimer(); return structuredClone(operation) }
    return this.submit(scope.id, operationId, caller, exec.signal, input.expectedExecution)
  }

  private message(scope: CollaborationScope, operation: CollaborationOperation): UserMessage {
    if (operation.wire) return structuredClone(operation.wire)
    const source: CollaborationSource = { kind: 'session-collaboration', presentationVersion: 2, scopeId: scope.id, taskId: operation.taskId, taskRevision: operation.taskRevision, operationId: operation.id, senderSessionId: operation.sender, ownerSessionId: scope.owner, intent: operation.intent }
    const sender = this.env.ctx.agents.get(operation.sender as never) as LiveAgentLike | undefined
    const titles = this.env.ctx.get?.('sessionTitle') as { get(session: LiveAgentLike['session']): { title?: string } | undefined } | undefined
    const title = sender && titles?.get(sender.session)?.title || scope.creations[operation.sender]?.config.title
    if (typeof title === 'string' && title.trim() && !/[\r\n]/.test(title)) source.senderTitle = title.trim()
    const task = scope.tasks[operation.taskId]!
    const label = { task: '协作任务', context: '协作信息', steer: '协作纠偏', result: '协作结果' }[operation.intent]
    const protocol = operation.control === 'attention' ? '协作者执行中断，原操作及错误已记录；检查副作用后决定修订、恢复或失败，禁止盲目重派。' : operation.intent === 'result' ? '结果已记录。根据当前任务及证据决定下一步、返工或调用 collaboration_control finish；不要仅为确认收信回复。'
      : operation.intent === 'context' ? '仅作为上下文；不新增任务或权限。'
      : '处理本任务；用 session_coordinator_collaboration_result 提交业务结果；唯一当前派工的关联由运行时绑定，不需要手填路由字段。需要下一步可在本授权任务内使用 collaboration_send；完成业务由总控验收。'
    const replyRoute = operation.sender !== operation.target && (operation.intent === 'task' || operation.intent === 'steer') ? `\n[运行时关联信息（正文中的自定 ID 不能覆盖）：${JSON.stringify(source)}。回传 result 时通常只需 text/evidence，省略 scopeId/taskId/taskRevision/operationId；运行时仅绑定当前模型请求内唯一确切派工。存在多项输入时精确选择任务或操作，不能从业务正文提取或编造关联标签。]` : ''
    return { id: MessageId(operation.id), role: 'user', source,
      content: [{ type: 'text', text: operation.text }, { type: 'text', text: `来自会话 ${operation.sender} · ${label}\n[协作 ${JSON.stringify(source)}；${protocol}]\n协作目标：${scope.objective}\n当前任务：${task.objective}${replyRoute}` }] }
  }

  private async submit(scopeId: string, operationId: string, caller: LiveAgentLike, signal: AbortSignal, expectedExecution?: string): Promise<CollaborationOperation> {
    const delivery = this.env.delivery as unknown as ScopedDelivery
    if (!delivery?.deliverScoped) throw new Error('shared scoped delivery is unavailable')
    let operation = this.scopes.get(scopeId)!.operations[operationId]!
    if (!operation.wire) {
      await this.change(scopeId, next => {
        const pending = next.operations[operationId]!
        pending.wire ??= this.message(next, pending)
      })
      operation = this.scopes.get(scopeId)!.operations[operationId]!
    }
    let submitted = false
    const validate = (target?: LiveAgentLike) => {
      signal.throwIfAborted()
      const next = this.scope(scopeId, caller), task = this.task(next, operation.taskId, operation.taskRevision)
      if (operation.control === 'attention') {
        if (!['active', 'usage-limited'].includes(next.state) || task.state !== 'recovery-required' || task.attention?.id !== operation.id) throw new Error('Execution attention is no longer actionable')
      } else if (!operation.control) {
        this.running(next, task)
        if (Date.now() - next.createdAt >= next.budget.maxElapsedMs) throw new HarnessError('elapsed time budget exhausted before submission', 'COLLABORATION_BUDGET')
      }
      this.member(next, task, caller, operation.target)
      if (this.env.ctx.agents.get(caller.id as never) !== caller) throw new Error('calling execution changed')
      if ((operation.intent === 'steer' || operation.control && operation.control !== 'attention') && target) {
        const current = this.executions.get(target)
        if (target.status !== 'running' || !expectedExecution || current?.id !== expectedExecution) throw new Error('execution changed: no matching active turn to steer')
      }
    }
    try {
      await delivery.deliverScoped(operation.target, this.message(this.scopes.get(scopeId)!, operation), caller, {
        // Results join the owner's next step (or wake it when idle), without cancelling its current turn.
        mode: operation.intent === 'context' ? 'context' : operation.intent === 'task' ? 'queue' : 'steer', signal, validate,
        ...(operation.materials?.length ? { prepareMessage: async (target: LiveAgentLike) => {
          validate(target)
          const { prepareCollaborationMaterials } = await import('./collaboration-materials.ts')
          const prepared = await prepareCollaborationMaterials(caller.ctx, target.ctx, operation.materials!, signal)
          validate(target)
          const base = this.message(this.scopes.get(scopeId)!, operation)
          const wire = { ...base, content: [...base.content, ...prepared.content] }
          await this.change(scopeId, next => { validate(target); next.operations[operationId]!.wire = wire; next.operations[operationId]!.artifacts = prepared.artifacts as unknown as JsonValue[] })
          validate(target)
          return wire
        } } : {}),
        beforeSubmit: target => { validate(target); submitted = true },
      })
      await this.change(scopeId, next => { const op = next.operations[operationId]!; if (op.status === 'prepared') op.status = 'submitted' })
    } catch (error) {
      await this.change(scopeId, next => { const op = next.operations[operationId]!; if (['prepared', 'submitted'].includes(op.status)) { op.status = submitted ? 'unknown' : 'rejected'; op.error = errorText(error) }
        if ((error as { code?: string })?.code === 'COLLABORATION_BUDGET') { next.state = 'budget-exhausted'; next.reason = errorText(error) }
      })
      if (!submitted) throw error
    }
    return structuredClone(this.scopes.get(scopeId)!.operations[operationId]!)
  }

  private async resultBinding(input: CollaborationResultInput, caller: LiveAgentLike): Promise<CollaborationResultInput & { scopeId: string; taskId: string; taskRevision: number; operationId: string }> {
    if (input.scopeId !== undefined && input.taskId !== undefined && input.taskRevision !== undefined && input.operationId !== undefined) {
      return { ...input, scopeId: input.scopeId, taskId: input.taskId, taskRevision: input.taskRevision, operationId: input.operationId }
    }
    await Promise.all([...this.chains.values()])
    const execution = this.executions.get(caller)
    const candidates = [...this.scopes.values()].filter(scope => scope.members.includes(caller.id) && (input.scopeId === undefined || scope.id === input.scopeId)).flatMap(scope =>
      Object.values(scope.operations).filter(op => execution && execution.claimed.has(op.id) && execution.requestOperations.has(op.id) && op.target === caller.id && op.sender !== caller.id && !op.control &&
        (input.taskId === undefined || op.taskId === input.taskId) && (input.taskRevision === undefined || op.taskRevision === input.taskRevision) &&
        (input.operationId === undefined || op.id === input.operationId) && op.execution === execution.id && op.requestInclusion?.execution === execution.id &&
        op.status === 'admitted' && (op.intent === 'task' || op.intent === 'steer')).map(op => ({ scope, op })))
    if (candidates.length !== 1) throw new Error('result requires one unambiguous task operation in the current native model request; select the exact native task/operation when multiple inputs are present: ' +
      JSON.stringify(candidates.map(({ scope, op }) => ({ scopeId: scope.id, taskId: op.taskId, taskRevision: op.taskRevision, operationId: op.id, objective: scope.tasks[op.taskId]?.objective }))))
    const { scope, op } = candidates[0]!
    return { ...input, scopeId: scope.id, taskId: op.taskId, taskRevision: op.taskRevision, operationId: op.id }
  }

  async result(raw: CollaborationResultInput, exec: CollaborationExecution): Promise<CollaborationResult> {
    const caller = this.caller(exec), input = await this.resultBinding(raw, caller)
    await this.settled(input.scopeId)
    const scope = this.scope(input.scopeId, caller), task = this.task(scope, input.taskId)
    this.member(scope, task, caller)
    const operationId = input.operationId
    const operation = scope.operations[text(operationId, 'operationId')]
    if (!operation || operation.target !== caller.id || operation.taskId !== task.id || operation.taskRevision !== input.taskRevision || operation.intent === 'result' || operation.intent === 'context') throw new Error('result must answer this session’s exact task operation and revision')
    const resultId = input.resultId ?? identity('result-', operation.id)
    const value = bodyText(input.text, 'text'), evidence = input.evidence ?? []
    if (!Array.isArray(evidence) || evidence.some(item => typeof item !== 'string' || !item.trim())) throw new Error('invalid evidence references')
    if (scope.results[resultId]) {
      const prior = scope.results[resultId]!
      if (prior.text !== value || prior.operationId !== operation.id || JSON.stringify(prior.evidence) !== JSON.stringify(evidence)) throw new Error('resultId already belongs to another result')
      return structuredClone(prior)
    }
    const result = await this.change(scope.id, next => {
      this.caller(exec)
      const op = next.operations[operation.id]!, current = next.tasks[task.id]!
      if (op.resultId) throw new Error('operation already has a result')
      if (op.status !== 'admitted') throw new Error('result requires an operation admitted into this session’s model history')
      const stale = current.revision !== input.taskRevision
      // Exact repeated evidence is observable duplication; wording changes still rely on total/time budgets.
      const repeated = current.resultIds.some(id => {
        const prior = next.results[id]!
        return prior.taskRevision === input.taskRevision && prior.sender === caller.id && prior.text === value && isDeepStrictEqual(prior.evidence, evidence)
      })
      const result: CollaborationResult = { id: resultId, taskId: task.id, taskRevision: input.taskRevision, operationId: op.id, sender: caller.id, text: value, evidence: [...evidence], createdAt: Date.now(), stale }
      next.results[resultId] = result; op.resultId = resultId; current.resultIds.push(resultId)
      if (!stale && current.state === 'active' && next.state === 'active') { if (!repeated) current.noProgress = 0; current.scheduling = 'ready'; delete current.waitReason }
      return result
    })
    // Persisted result identity arbitrates all notification/wait consumers.
    const latest = this.scopes.get(scope.id)!, current = latest.tasks[task.id]!
    if (!result.stale && current.state === 'active' && latest.state === 'active' && latest.authorization.process === this.process && caller.id !== latest.owner) {
      const notificationId = identity('notify-', result.id)
      let notify = false
      await this.change(scope.id, next => {
        if (next.operations[notificationId] || next.state !== 'active' || next.tasks[task.id]!.state !== 'active' || next.tasks[task.id]!.revision !== result.taskRevision) return
        const reason = this.checkBudget(next, next.tasks[task.id]!)
        if (reason) { next.state = 'budget-exhausted'; next.reason = reason; return }
        next.operations[notificationId] = { id: notificationId, taskId: task.id, taskRevision: result.taskRevision, sender: caller.id, target: next.owner, text: value, intent: 'result', status: 'prepared', createdAt: Date.now(), resultId }
        notify = true
      })
      if (notify) await this.submit(scope.id, notificationId, caller, exec.signal)
    }
    return result
  }

  async status(input: { scopeId?: string }, exec: CollaborationExecution): Promise<CollaborationScope | CollaborationScope[]> {
    const caller = this.caller(exec)
    if (!input.scopeId) {
      await Promise.all([...this.chains.values()])
      return [...this.scopes.values()].filter(scope => scope.members.includes(caller.id)).map(scope => this.snapshot(scope))
    }
    await this.settled(input.scopeId)
    return this.snapshot(this.scope(input.scopeId, caller))
  }

  private snapshot(current: CollaborationScope): CollaborationScope {
    const scope = structuredClone(current)
    if (this.storageFailure) { scope.state = 'recovery-required'; scope.reason = 'Last known snapshot; task storage needs recovery: ' + this.storageFailure }
    scope.executions = {}
    for (const member of scope.members) {
      const target = this.env.ctx.agents.get(member as never) as unknown as LiveAgentLike | undefined
      if (target && this.executions.get(target)) scope.executions[member] = this.executions.get(target)!.id
    }
    for (const wait of Object.values(scope.nativeWaits ?? {})) if (wait.state === 'waiting') {
      if (scope.executions[wait.sessionId] !== wait.execution) { wait.state = 'recovery-required'; continue }
      for (const taskId of wait.taskIds) if (scope.state === 'active' && scope.tasks[taskId]?.state === 'active' && wait.taskRevisions?.[taskId] === scope.tasks[taskId]!.revision) {
        scope.tasks[taskId]!.scheduling = 'waiting'; scope.tasks[taskId]!.waitReason = 'approval'
      }
    }
    return scope
  }

  async control(input: CollaborationControl, exec: CollaborationExecution): Promise<CollaborationScope> {
    if (input.action === 'question') return this.question(input, exec)
    if (input.action === 'edit' || input.action === 'withdraw') return this.queueControl(input, exec)
    const caller = this.caller(exec), original = this.scope(input.scopeId, caller, true)
    if (!['pause', 'resume', 'revise', 'finish', 'cancel', 'block', 'fail', 'revalidate'].includes(input.action)) throw new Error('invalid control action')
    if (input.action === 'finish') await this.verifyCompletionMaterials(original, input, exec)
    if (['pause', 'resume', 'revise', 'cancel'].includes(input.action)) await this.approval(exec, { ...input, objective: input.objective ?? original.objective, members: original.members, budget: original.budget }, 'session_coordinator_collaboration_control')
    await this.change(original.id, next => {
      this.caller(exec)
      const task = input.taskId ? this.task(next, input.taskId, original.tasks[input.taskId]?.revision) : undefined
      const target = task ?? next
      if (stopped.has(target.state)) {
        if (!task) throw new Error('terminal collaboration cannot be resumed or changed')
        if (task.state === 'completed') throw new Error('terminal task is completed; preserve its accepted results and continue other active tasks. When every task is completed, finish the scope without taskId and include accepted resultIds')
        throw new Error('terminal task is ' + task.state + '; preserve its terminal state. To close the remaining scope, use collaboration_control action=cancel or action=fail without taskId; do not use legacy whole-session cancel')
      }
      if (input.action === 'finish' || input.action === 'revalidate') {
        const resultIds = names(input.resultIds, 'resultIds')
        if (resultIds.some(id => !next.results[id] || (task && (next.results[id]!.taskId !== task.id || (input.action !== 'revalidate' && next.results[id]!.taskRevision !== task.revision && !task.acceptedResultIds.includes(id)))))) throw new Error('completion requires evidence for the current task revision')
        if (input.action === 'revalidate') {
          if (!task) throw new Error('revalidate requires taskId')
          // Explicit business review associates preserved old evidence with the current objective.
          for (const id of resultIds) if (!task.acceptedResultIds.includes(id)) task.acceptedResultIds.push(id)
          return
        }
        if (task) task.acceptedResultIds = resultIds
        else if (Object.values(next.tasks).length === 0 || Object.values(next.tasks).some(t => t.state !== 'completed')) throw new Error('finish each task before finishing the collaboration. If any task is cancelled or failed, preserve its terminal state and close the remaining scope with collaboration_control action=cancel or action=fail without taskId; do not finish cancelled tasks or use legacy whole-session cancel')
        target.state = 'completed'; target.reason = text(input.reason, 'completion reason')
      } else if (input.action === 'revise') {
        if (!task) throw new Error('revise requires taskId; scope expansion requires a new approved collaboration')
        const objective = text(input.objective, 'objective'), reason = text(input.reason, 'revision reason')
        task.history.push({ revision: task.revision, objective: task.objective, reason, time: Date.now() })
        task.objective = objective; task.revision++; task.noProgress = 0; task.acceptedResultIds = []; task.scheduling = 'ready'
        target.reason = reason
      } else if (input.action === 'resume') {
        if (next.state === 'budget-exhausted') throw new Error('budget exhausted; start a newly approved scope with an explicit budget')
        target.state = 'active'; delete target.reason
        next.authorization = { ...next.authorization, callId: exec.callId!, process: this.process, approvedAt: Date.now() }
        if (task) { task.scheduling = 'ready'; delete task.waitReason }
      } else {
        const state = ({ pause: 'paused', cancel: 'cancelled', block: 'blocked', fail: 'failed' } as Record<string, CollaborationState>)[input.action]
        if (!state) throw new Error('invalid state control')
        target.state = state
        target.reason = text(input.reason, 'reason')
        if (task) { task.scheduling = target.state === 'blocked' ? 'waiting' : 'stopped'; task.waitReason = input.waitReason ?? input.reason }
      }
      if (task) task.updatedAt = Date.now()
    })
    if (['pause', 'cancel', 'revise', 'finish', 'fail'].includes(input.action)) {
      for (const question of Object.values(this.scopes.get(original.id)!.questions)) if ((!input.taskId || question.taskId === input.taskId) && ['asking', 'routed'].includes(question.state)) this.questionControllers.get(question.id)?.abort(new Error('Task ' + input.action))
      await this.withdraw(original.id, input.taskId)
      await this.correctActive(original.id, input.taskId, input.action, caller, exec.signal)
    }
    return structuredClone(this.scopes.get(original.id)!)
  }

  private async verifyCompletionMaterials(scope: CollaborationScope, input: CollaborationControl, exec: CollaborationExecution): Promise<void> {
    const resultIds = names(input.resultIds, 'resultIds')
    for (const id of resultIds) {
      const result = scope.results[id], operation = result && scope.operations[result.operationId]
      if (!operation?.artifacts?.length) continue
      this.caller(exec)
      const source = this.env.ctx.agents.get(operation.sender as never) as unknown as LiveAgentLike | undefined
      const recipient = this.env.ctx.agents.get(operation.target as never) as unknown as LiveAgentLike | undefined
      if (!source || !recipient) throw new Error('artifact acceptance requires both source and recipient live for actual verification; restore them before finish')
      const { verifyCollaborationArtifacts } = await import('./collaboration-materials.ts')
      const verified = await verifyCollaborationArtifacts(source.ctx, recipient.ctx, operation.artifacts as unknown as import('./collaboration-materials.ts').CollaborationArtifact[], exec.signal)
      this.caller(exec)
      const invalid = verified.filter(item => item.status !== 'verified')
      if (invalid.length) throw new Error('artifact version changed or is unavailable for resultId=' + id + ', operationId=' + operation.id + ': ' + JSON.stringify(invalid.map(item => ({ path: item.artifact.sourcePath, status: item.status }))) + '. Inspect the changed or unavailable sources first. revalidate only associates business evidence with a task revision; it does not refresh immutable attachments. If current-version review is still required within the approved task, use collaboration_send with the current materials for a new read-only review operation, then finish with its fresh resultId. Preserve the old evidence and do not repeat already completed business side effects.')
      const current = this.scopes.get(scope.id)!
      if (current.tasks[result!.taskId]!.revision !== scope.tasks[result!.taskId]!.revision || !isDeepStrictEqual(current.operations[operation.id]!.artifacts, operation.artifacts)) throw new Error('task or artifact version changed during completion verification')
    }
  }

  private async correctActive(scopeId: string, taskId: string | undefined, action: string, caller: LiveAgentLike, signal: AbortSignal): Promise<void> {
    const scope = this.scopes.get(scopeId)!
    for (const task of Object.values(scope.tasks)) {
      if (taskId && task.id !== taskId) continue
      for (const member of task.members) {
        const target = this.env.ctx.agents.get(member as never) as unknown as LiveAgentLike | undefined
        const execution = target && this.executions.get(target)
        if (!target || !execution || target.status !== 'running' || !Object.values(scope.operations).some(op => op.taskId === task.id && op.target === member && op.status === 'admitted' && op.execution === execution.id)) continue
        const exclusive = action === 'cancel' && execution.inputs.size > 0 && [...execution.inputs].every(([id, message]) => {
          const input = scope.operations[id]
          return input?.taskId === task.id && input.target === member && input.status === 'admitted' && input.execution === execution.id && isDeepStrictEqual(message, this.message(scope, input))
        })
        if (exclusive) {
          // Revocation is already durable; exact instance/turn check immediately precedes native interruption.
          if (this.env.ctx.agents.get(member as never) === target && this.executions.get(target) === execution && target.status === 'running') target.cancel({ kind: 'hook', reason: 'Collaboration task ' + task.id + ' cancelled by approved user control' }, { keepInbox: true })
          continue
        }
        const id = identity('control-', scopeId, task.id, task.revision, action, execution.id)
        let submit = false
        await this.change(scopeId, next => {
          if (next.operations[id]) return
          const op: CollaborationOperation = { id, taskId: task.id, taskRevision: task.revision, sender: caller.id, target: member, text: '任务控制已生效：' + action + '。只停止或修正此任务的后续动作；保留同轮其他任务。当前目标：' + task.objective + '；原因：' + (task.reason ?? next.reason ?? action), intent: 'context', control: action, status: 'prepared', createdAt: Date.now() }
          op.wire = this.message(next, op); next.operations[id] = op; submit = true
        })
        if (submit) {
          try { await this.submit(scopeId, id, caller, signal, execution.id) }
          catch { /* Execution changed: durable task revocation remains effective; never steer a new turn. */ }
        }
      }
    }
  }

  private async queueControl(input: CollaborationControl, exec: CollaborationExecution): Promise<CollaborationScope> {
    const caller = this.caller(exec)
    await this.settled(input.scopeId)
    const scope = this.scope(input.scopeId, caller, true), operation = scope.operations[text(input.operationId, 'operationId')]
    if (!operation || input.taskId && input.taskId !== operation.taskId) throw new Error('queue operation does not belong to this task')
    const task = this.task(scope, operation.taskId, operation.taskRevision)
    this.running(scope, task)
    const id = identity('mutation-', scope.id, text(exec.callId, 'callId'))
    if (scope.mutations[id]) return structuredClone(scope)
    const kind = input.action as 'edit' | 'withdraw'
    const editedBody = kind === 'edit' ? bodyText(input.message, 'message') : undefined
    const edited = kind === 'edit' ? this.message(scope, { ...operation, wire: undefined, text: editedBody! }) : undefined
    const materialOffset = operation.wire?.source.kind === 'session-collaboration' && operation.wire.source.presentationVersion === 2 ? 2 : 1
    const after = edited && operation.wire ? { ...edited, content: [...edited.content, ...structuredClone(operation.wire.content.slice(materialOffset))] } : edited
    const mutation: CollaborationQueueMutation = { id, operationId: operation.id, kind, status: 'prepared', before: this.message(scope, operation), ...(after ? { after } : {}) }
    await this.approval(exec, { ...input, objective: scope.objective, members: scope.members, operation: operation.id }, 'session_coordinator_collaboration_control')
    await this.change(scope.id, next => { this.running(next, this.task(next, task.id, task.revision)); next.mutations[id] = mutation })
    let applied = false
    try {
      this.caller(exec)
      const current = this.scopes.get(scope.id)!, op = current.operations[operation.id]!
      this.running(current, this.task(current, task.id, task.revision))
      if (op.status === 'scheduled') applied = true
      else if (['prepared', 'submitted', 'claimed'].includes(op.status)) {
        const target = this.env.ctx.agents.get(op.target as never) as unknown as LiveAgentLike | undefined
        if (target) {
          const inbox = target.inbox as { replace?(id: string, message: UserMessage): boolean; remove?(id: string): boolean } | undefined
          if (kind === 'edit' && !inbox?.replace) throw new Error('native inbox.replace is unavailable')
          // Exact target identity and task revision checked immediately before the synchronous mutation.
          if (this.env.ctx.agents.get(op.target as never) !== target) throw new Error('target execution changed')
          applied = kind === 'edit' ? inbox!.replace!(op.id, after!) : inbox?.remove?.(op.id) === true
        }
      }
      await this.change(scope.id, next => {
        next.mutations[id]!.status = applied ? 'applied' : 'not-pending'
        if (applied) {
          const op = next.operations[operation.id]!
          if (kind === 'withdraw') op.status = 'withdrawn'
          else { op.text = editedBody!; op.wire = after! }
        }
      })
    } catch (error) {
      await this.change(scope.id, next => { next.mutations[id]!.status = 'unknown'; next.mutations[id]!.error = errorText(error) })
      throw error
    }
    return structuredClone(this.scopes.get(scope.id)!)
  }

  private async relay(scopeId: string, taskId: string, caller: LiveAgentLike, target: string, id: string, body: string, signal: AbortSignal): Promise<void> {
    let submit = false
    await this.change(scopeId, next => {
      const task = this.task(next, taskId)
      this.running(next, task); this.member(next, task, caller, target)
      if (next.operations[id]) return
      const reason = this.checkBudget(next, task)
      if (reason) { next.state = 'budget-exhausted'; next.reason = reason; return }
      const op: CollaborationOperation = { id, taskId, taskRevision: task.revision, sender: caller.id, target, text: body, intent: 'result', status: 'prepared', createdAt: Date.now() }
      op.wire = this.message(next, op); next.operations[id] = op; submit = true
    })
    if (submit) await this.submit(scopeId, id, caller, signal)
  }

  private async question(input: CollaborationControl, exec: CollaborationExecution): Promise<CollaborationScope> {
    const caller = this.caller(exec), scope = this.scope(input.scopeId, caller), task = this.task(scope, text(input.taskId, 'taskId'))
    this.running(scope, task); this.member(scope, task, caller)
    const id = input.questionId ?? identity('question-', scope.id, caller.id, text(exec.callId, 'callId'))
    let question = scope.questions[id]
    if (!question) {
      const body = text(input.question, 'question'), options = input.options ?? []
      if (!Array.isArray(options) || options.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid question options')
      question = { id, taskId: task.id, taskRevision: task.revision, requestedBy: caller.id, text: body, options: [...options], state: 'routed' }
      await this.change(scope.id, next => { this.running(next, this.task(next, task.id, task.revision)); next.questions[id] = question!; next.tasks[task.id]!.scheduling = 'waiting'; next.tasks[task.id]!.waitReason = 'user-input' })
    } else if (question.taskId !== task.id || question.taskRevision !== task.revision || caller.id !== scope.owner && question.requestedBy !== caller.id) throw new Error('question belongs to another task/revision or requester')
    if (['answered', 'cancelled', 'asking'].includes(question.state)) return structuredClone(this.scopes.get(scope.id)!)
    if (caller.id !== scope.owner) {
      await this.relay(scope.id, task.id, caller, scope.owner, identity('question-notify-', id), '协作者需要用户决定。请用 collaboration_control action=question questionId=' + id + ' 向用户提问并将回答带回此任务。问题：' + question.text, exec.signal)
      return structuredClone(this.scopes.get(scope.id)!)
    }
    const service = this.env.ctx.get?.('userQuestions') as { ask(request: unknown): Promise<JsonValue> } | undefined
    if (!service?.ask || !exec.callId) throw new Error('native userQuestions service is unavailable')
    const controller = new AbortController()
    this.questionControllers.set(id, controller)
    const signal = AbortSignal.any([exec.signal, controller.signal])
    await this.change(scope.id, next => { const q = next.questions[id]!; q.state = 'asking'; q.nativeCallId = exec.callId!; q.nativeSessionId = caller.id })
    try {
      const answer = await service.ask({ agent: caller, signal, wait: { callId: exec.callId }, questions: [{ id, header: task.objective.slice(0, 12), question: question.text, detail: '协作 ' + scope.objective + '\n任务 ' + task.id + ' 修订 ' + task.revision + '\n请求会话 ' + question.requestedBy, ...(question.options.length ? { options: question.options.map(label => ({ label })) } : {}) }] })
      await this.change(scope.id, next => {
        const q = next.questions[id]!, current = next.tasks[task.id]!
        q.answer = answer; q.state = 'answered'
        if (next.state === 'active' && current.state === 'active' && current.revision === q.taskRevision) { current.scheduling = 'ready'; delete current.waitReason }
      })
      const latest = this.scopes.get(scope.id)!
      if (question.requestedBy !== caller.id && !signal.aborted && latest.state === 'active' && latest.tasks[task.id]!.state === 'active' && latest.tasks[task.id]!.revision === question.taskRevision) {
        await this.relay(scope.id, task.id, caller, question.requestedBy, identity('question-answer-', id), '总控转交的用户回答（绑定问题 ' + id + '；仅用于此任务修订）：' + JSON.stringify(answer), signal)
      }
    } catch (error) {
      await this.change(scope.id, next => { const q = next.questions[id]!; q.state = signal.aborted ? 'cancelled' : 'recovery-required'; q.error = errorText(error) })
      if (!signal.aborted) throw error
    } finally { this.questionControllers.delete(id) }
    return structuredClone(this.scopes.get(scope.id)!)
  }

  private async withdraw(scopeId: string, taskId?: string): Promise<void> {
    const scope = this.scopes.get(scopeId)!
    for (const op of Object.values(scope.operations)) {
      if (taskId && op.taskId !== taskId) continue
      if (!['scheduled', 'prepared', 'submitted', 'claimed'].includes(op.status)) continue
      const agent = this.env.ctx.agents.get(op.target as never) as unknown as LiveAgentLike | undefined
      // Never cancel a whole Agent: mixed turns and unrelated inbox work remain intact.
      const removed = op.status === 'scheduled' || agent?.inbox?.remove?.(op.id) === true
      await this.change(scopeId, next => {
        const current = next.operations[op.id]!
        if (removed) current.status = 'withdrawn'
        else if (current.status !== 'admitted') { current.status = 'unknown'; current.error = 'Input already claimed or execution unavailable; future task actions revoked; inspect acceptance' }
      })
    }
  }

  async wait(input: { scopeId: string; taskIds?: string[]; mode?: 'any' | 'all'; afterResultIds?: string[]; timeoutMs?: number }, exec: CollaborationExecution) {
    const caller = this.caller(exec), initial = this.scope(input.scopeId, caller)
    const taskIds = input.taskIds ?? Object.keys(initial.tasks), after = new Set(input.afterResultIds ?? [])
    if (!taskIds.length || taskIds.some(id => !initial.tasks[id])) throw new Error('wait requires known tasks')
    if (input.mode !== undefined && !['any', 'all'].includes(input.mode)) throw new Error('invalid wait mode')
    const timeoutMs = input.timeoutMs ?? 180_000
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) throw new Error('invalid timeoutMs')
    const started = Date.now()
    for (;;) {
      await this.settled(initial.id)
      const scope = this.scope(initial.id, caller)
      const results = Object.values(scope.results).filter(r => taskIds.includes(r.taskId) && !after.has(r.id) && (r.taskRevision === scope.tasks[r.taskId]!.revision || scope.tasks[r.taskId]!.acceptedResultIds.includes(r.id)))
      const attention = taskIds.filter(id => scope.tasks[id]!.state === 'recovery-required' && scope.tasks[id]!.attention?.taskRevision === scope.tasks[id]!.revision).map(taskId => ({ taskId, ...scope.tasks[taskId]!.attention! }))
      const ready = taskIds.filter(id => results.some(r => r.taskId === id) || stopped.has(scope.tasks[id]!.state) || attention.some(item => item.taskId === id))
      const done = input.mode === 'all' ? ready.length === taskIds.length : ready.length > 0
      // Release the tool so native next-step admission can consume the user's steering input.
      const pendingUserInput = caller.inbox?.nextStep?.some(message => { const input = message as Partial<UserMessage> | null; return input?.role === 'user' && input.source?.kind === 'user' }) === true
      const interrupted = pendingUserInput || scope.state !== 'active' || taskIds.some(id => scope.tasks[id]!.state !== 'active' && !stopped.has(scope.tasks[id]!.state))
      if (done || attention.length || interrupted || exec.signal.aborted || !this.active || Date.now() - started >= timeoutMs) return { needsAttention: attention.length > 0, attention, results: structuredClone(results), tasks: taskIds.map(id => structuredClone(scope.tasks[id]!)), done, scopeState: scope.state, ...(scope.reason ? { reason: scope.reason } : {}), ...(pendingUserInput ? { pendingUserInput: true } : {}), interrupted, timedOut: !done && !attention.length && !interrupted && !exec.signal.aborted && this.active, aborted: exec.signal.aborted || !this.active }
      await new Promise<void>(resolve => { const timer = setTimeout(finish, Math.min(50, timeoutMs - (Date.now() - started))); function finish() { clearTimeout(timer); exec.signal.removeEventListener('abort', finish); resolve() } exec.signal.addEventListener('abort', finish, { once: true }) })
    }
  }

  private async continueActionable(agent: LiveAgentLike, turn: number, signal: AbortSignal): Promise<void> {
    if (!this.active || signal.aborted || this.env.ctx.agents.get(agent.id as never) !== agent) return
    const execution = this.executions.get(agent)
    if (!execution || execution.turn !== turn || agent.status !== 'running') return
    await Promise.all([...this.chains.values()])
    for (const scope of this.scopes.values()) {
      if (scope.owner !== agent.id || scope.state !== 'active' || scope.authorization.process !== this.process) continue
      const task = Object.values(scope.tasks).find(t => t.state === 'active' && t.scheduling === 'ready')
      if (!task) continue
      const id = identity('continue-', scope.id, task.id, task.revision, execution.id, execution.step)
      let submit = false
      await this.change(scope.id, next => {
        const current = this.task(next, task.id, task.revision)
        this.running(next, current)
        if (next.operations[id] || current.scheduling !== 'ready') return
        const reason = this.checkBudget(next, current)
        if (reason) { next.state = 'budget-exhausted'; next.reason = reason; return }
        const op: CollaborationOperation = { id, taskId: task.id, taskRevision: task.revision, sender: agent.id, target: agent.id, text: '当前任务仍活跃且有可执行工作。请根据已有结果决定下一步、分派、修订、验收 finish，或明确 block 等待原因；不要仅因一次模型答复结束而停止。运行时不会替你判断业务成功。', intent: 'steer', status: 'prepared', createdAt: Date.now() }
        op.wire = this.message(next, op); next.operations[id] = op; current.noProgress++; submit = true
      })
      if (submit) await this.submit(scope.id, id, agent, signal, execution.id)
      return // One native stop boundary admits at most one continuation.
    }
  }

  private async recordHumanInput(agent: LiveAgentLike, message: UserMessage, seq: number): Promise<void> {
    const body = message.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || '(用户补充了非文本材料，请按需读取原会话)'
    for (const scope of this.scopes.values()) {
      if (scope.owner === agent.id || !scope.members.includes(agent.id) || stopped.has(scope.state)) continue
      for (const task of Object.values(scope.tasks)) {
        if (!task.members.includes(agent.id) || stopped.has(task.state) || !Object.values(scope.operations).some(op => op.taskId === task.id && op.target === agent.id && op.status === 'admitted')) continue
        let recorded = false
        await this.change(scope.id, next => {
          const current = next.tasks[task.id]!
          current.humanInputs ??= []
          if (current.humanInputs.some(input => input.messageId === message.id && input.sessionId === agent.id)) return
          current.humanInputs.push({ messageId: message.id, sessionId: agent.id, seq, text: body, time: Date.now() }); recorded = true
        })
        const latest = this.scopes.get(scope.id)!
        if (recorded && latest.state === 'active' && latest.tasks[task.id]!.state === 'active' && latest.authorization.process === this.process) {
          await this.relay(scope.id, task.id, agent, scope.owner, identity('human-sync-', scope.id, task.id, agent.id, message.id), '用户在参与会话 ' + agent.id + ' 补充了信息（原消息 ' + message.id + '）。请核对当前目标；若这是纠偏，按新目标修订任务，不恢复旧计划。原文：\n' + body, new AbortController().signal)
        }
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return
    const timer = this.env.ctx as unknown as { setInterval(fn: () => Promise<void>, ms: number): unknown }
    this.timer = timer.setInterval(() => this.runDue().catch(error => console.warn('[session-coordinator] deferred work needs inspection:', errorText(error))), 1000)
  }
  private async runDue(): Promise<void> {
    if (!this.active || this.dueRunning) return
    this.dueRunning = true
    try {
      for (const scope of this.scopes.values()) for (const op of Object.values(scope.operations)) {
        if (op.status !== 'scheduled' || (op.notBefore ?? 0) > Date.now() || scope.state !== 'active' || scope.authorization.process !== this.process) continue
        const task = scope.tasks[op.taskId]
        if (!task || task.state !== 'active' || task.revision !== op.taskRevision) continue
        const caller = this.env.ctx.agents.get(op.sender as never) as unknown as LiveAgentLike | undefined
        if (!caller) continue // Deferred work requires the application and an authorized live sender.
        let claimed = false
        await this.change(scope.id, next => {
          this.running(next, this.task(next, op.taskId, op.taskRevision))
          if (next.operations[op.id]!.status !== 'scheduled') return
          next.operations[op.id]!.status = 'prepared'; claimed = true
        })
        if (claimed) await this.submit(scope.id, op.id, caller, new AbortController().signal)
      }
    } finally { this.dueRunning = false }
  }

  private async executionFailed(agent: LiveAgentLike, turn: number, error: { code?: string; message?: string }, disposed = false, execution: { id: string; turn: number } | undefined = this.executions.get(agent)): Promise<void> {
    const live = this.env.ctx.agents.get(agent.id as never)
    if (!execution || execution.turn !== turn || (disposed ? live && live !== agent : live !== agent)) return
    const code = error.code || 'UNKNOWN', message = error.message || 'Native execution stopped without a result'
    await Promise.all([...this.scopes.values()].filter(scope => scope.members.includes(agent.id)).map(async scope => {
      const notifications: string[] = []
      await this.change(scope.id, next => {
        const current = this.env.ctx.agents.get(agent.id as never), running = this.executions.get(agent)
        if (current && current !== agent) return
        const affected = Object.values(next.operations).filter(op => op.target === agent.id && op.execution === execution.id && op.turn === turn && ['claimed', 'admitted'].includes(op.status) && !op.resultId && !op.control && ['task', 'steer'].includes(op.intent))
        for (const op of affected) op.error ??= code + ': ' + message
        for (const taskId of new Set(affected.map(op => op.taskId))) {
          const task = next.tasks[taskId]!, operations = affected.filter(op => op.taskId === taskId && op.taskRevision === task.revision)
          if (!operations.length || task.attention?.taskRevision === task.revision && (task.state === 'recovery-required' || task.attention.execution === execution.id)) continue
          const sameTask = (op: CollaborationOperation) => op.taskId === taskId && op.taskRevision === task.revision && op.target === agent.id && !op.control && ['task', 'steer'].includes(op.intent)
          // A later turn for another task must not hide this task's observed failure.
          const newerClaimed = running && running.turn > turn && [...running.claimed].some(id => next.operations[id] && sameTask(next.operations[id]!))
          const newerRecorded = Object.values(next.operations).some(op => sameTask(op) && ['claimed', 'admitted'].includes(op.status) && (op.turn ?? -1) > turn && op.execution?.startsWith(this.instance(agent) + ':'))
          if (newerClaimed || newerRecorded) continue
          const id = identity('attention-', next.id, taskId, task.revision, execution.id)
          task.attention = { id, taskRevision: task.revision, sessionId: agent.id, execution: execution.id, turn, code, message, operationIds: operations.map(op => op.id) }
          if (task.state !== 'active') continue
          task.state = 'recovery-required'; task.scheduling = 'waiting'; task.waitReason = ['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT'].includes(code) ? 'account-limit' : 'execution-error'; task.reason = code + ': ' + message
          if (!['active', 'usage-limited'].includes(next.state) || agent.id === next.owner || next.operations[id]) continue
          const notification: CollaborationOperation = { id, taskId, taskRevision: task.revision, sender: next.owner, target: next.owner, intent: 'result', control: 'attention', status: 'prepared', createdAt: Date.now(),
            text: '协作者 ' + agent.id + ' 执行中断：' + code + ': ' + message + '。需检查原操作 ' + operations.map(op => op.id).join(', ') + ' 的副作用，再决定修订、恢复或 fail；不得自动重派。' }
          notification.wire = this.message(next, notification); next.operations[id] = notification; notifications.push(id)
        }
      })
      const owner = this.env.ctx.agents.get(scope.owner as never) as unknown as LiveAgentLike | undefined
      if (owner) for (const id of notifications) await this.submit(scope.id, id, owner, new AbortController().signal)
    }))
  }

  private observe(): void {
    const on = this.env.ctx.on.bind(this.env.ctx) as unknown as (name: string, fn: (...args: any[]) => any) => () => unknown
    const executionError = (agent: LiveAgentLike, turn: number, error: { code?: string; message?: string }) => {
      const code = error?.code, execution = this.executions.get(agent)
      if (this.env.ctx.agents.get(agent.id as never) !== agent || !execution || execution.turn !== turn) return
      if (['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT'].includes(code ?? '')) {
        for (const scope of this.scopes.values()) if (scope.state === 'active' && scope.members.includes(agent.id) && (scope.owner === agent.id || Object.values(scope.operations).some(op => op.target === agent.id && op.turn === turn && op.execution === execution.id))) {
          void this.change(scope.id, next => { if (next.state !== 'active') return; next.state = 'usage-limited'; next.reason = code + ': ' + String(error.message ?? 'Native model usage limit'); for (const task of Object.values(next.tasks)) if (task.state === 'active') { task.scheduling = 'waiting'; task.waitReason = 'account-limit' } }).catch(failure => console.warn('[session-coordinator] usage limit could not persist:', errorText(failure)))
        }
      }
      void this.executionFailed(agent, turn, error ?? {}, false, execution).catch(failure => console.warn('[session-coordinator] execution failure could not persist:', errorText(failure)))
    }
    const updateMessage = (agent: LiveAgentLike, message: { id?: string }, status: CollaborationOperation['status'], turn?: number) => {
      const observed = this.executions.get(agent)
      const execution = turn === undefined ? undefined : observed?.turn === turn ? observed.id : `${this.instance(agent)}:${turn}`
      for (const scope of this.scopes.values()) {
        const op = scope.operations[message.id ?? '']
        if (!op || op.target !== agent.id || !isDeepStrictEqual(message, this.message(scope, op))) continue
        if (observed && observed.turn === turn && ['claimed', 'admitted'].includes(status)) observed.claimed.add(op.id)
        if (status === 'discarded') observed?.claimed.delete(op.id)
        void this.change(scope.id, next => {
          const current = next.operations[op.id]!
          if (['withdrawn', 'rejected'].includes(current.status)) return
          current.status = status
          if (turn !== undefined) { current.turn = turn; current.execution = execution }
        }).catch(error => console.warn('[session-coordinator] task observation could not persist:', errorText(error)))
      }
    }
    const runtime = this
    this.disposers.push(on('llm/stream', async function* (request, next) {
      if (runtime.active && isAgentLoopRequest(request) && typeof request.sessionId === 'string') {
        const agent = runtime.env.ctx.agents.get(request.sessionId as never) as unknown as LiveAgentLike | undefined
        const execution = agent && runtime.executions.get(agent)
        await Promise.all([...runtime.chains.values()])
        if (agent && execution && runtime.env.ctx.agents.get(agent.id as never) === agent && runtime.executions.get(agent) === execution) {
          execution.requestOperations = new Set()
          for (const scope of runtime.scopes.values()) {
            const included = Object.values(scope.operations).filter(op => op.target === agent.id && op.status === 'admitted' && request.messages.some((message: UserMessage) => message.id === op.id && isDeepStrictEqual(message, runtime.message(scope, op))))
            for (const op of included) execution.requestOperations.add(op.id)
            const unobserved = included.filter(op => op.requestInclusion?.execution !== execution.id)
            if (unobserved.length) await runtime.change(scope.id, current => {
              for (const op of unobserved) current.operations[op.id]!.requestInclusion = { evidence: 'native-llm-stream', execution: execution.id, step: execution.step, time: Date.now() }
            })
          }
        }
      }
      yield* next()
    }))
    this.disposers.push(on('agent/error', ({ agent, turn, error }) => executionError(agent, turn, error ?? {})))
    this.disposers.push(on('agent/turn-stopping', ({ agent, turn, signal }) => this.continueActionable(agent, turn, signal)))
    this.disposers.push(on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const execution = this.executions.get(agent)
      if (execution && execution.turn === turn && this.env.ctx.agents.get(agent.id as never) === agent) execution.inputs.set(message.id, message)
      updateMessage(agent, message, 'claimed', turn)
    }))
    this.disposers.push(on('agent/inbox/discarded', ({ agent, message }) => updateMessage(agent, message, 'discarded')))
    this.disposers.push(on('session/event', (session, event) => {
      const agent = this.env.ctx.agents.get(session.id as never) as unknown as LiveAgentLike | undefined
      if (!agent || agent.session !== session) return
      if (event.type === 'approval/asked' || event.type === 'approval/decided') {
        const execution = this.executions.get(agent)
        if (execution && typeof event.data.id === 'string') for (const scope of this.scopes.values()) {
          if (!scope.members.includes(agent.id)) continue
          void this.change(scope.id, next => {
            const key = agent.id + ':' + event.data.id
            if (event.type === 'approval/decided') {
              const wait = next.nativeWaits?.[key]
              if (wait?.state === 'waiting' && wait.execution === execution.id) { wait.state = 'decided'; wait.outcome = event.data.outcome }
              return
            }
            const related = Object.values(next.operations).filter(op => op.target === agent.id && op.status === 'admitted' && op.execution === execution.id && next.tasks[op.taskId]?.revision === op.taskRevision)
            const taskIds = [...new Set(related.map(op => op.taskId))]
            if (!taskIds.length) return
            next.nativeWaits ??= {}
            next.nativeWaits[key] ??= { id: event.data.id, sessionId: agent.id, execution: execution.id,
              ...(event.data.callId ? { callId: event.data.callId } : {}), toolName: event.data.toolName, taskIds, taskRevisions: Object.fromEntries(taskIds.map(id => [id, next.tasks[id]!.revision])),
              shared: taskIds.length > 1 || [...execution.inputs.keys()].some(id => !related.some(op => op.id === id)), state: 'waiting' }
          }).catch(error => console.warn('[session-coordinator] approval observation could not persist:', errorText(error)))
        }
      }
      if (event.type === 'turn/start') this.executions.set(agent, { id: `${this.instance(agent)}:${event.data.turn}`, turn: event.data.turn, step: 0, inputs: new Map(), claimed: new Set(), requestOperations: new Set() })
      if (event.type === 'step/start' || event.type === 'step/end') { const execution = this.executions.get(agent); if (execution) execution.step = event.data.step }
      if (event.type === 'turn/end' && this.executions.get(agent)?.turn === event.data.turn) {
        if (event.data.reason?.kind === 'error') executionError(agent, event.data.turn, event.data.reason.error)
        this.executions.delete(agent)
      }
      if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && session.isOwnSeq?.(event.seq) !== false) {
        for (const scope of this.scopes.values()) {
          const related = Object.values(scope.operations).filter(op => op.target === agent.id && op.turn === event.data.turn && op.status === 'admitted' && op.execution === this.executions.get(agent)?.id)
          if (!related.length) continue
          void this.change(scope.id, next => {
            const key = agent.id + ':' + event.seq
            if (next.usage[key]) return
            const raw = event.data.usage
            const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
            const valid = raw && typeof raw === 'object' && ['inputTokens', 'outputTokens'].every(field => Number.isSafeInteger(raw[field]) && raw[field] >= 0) && fields.every(field => raw[field] === undefined || Number.isSafeInteger(raw[field]) && raw[field] >= 0)
            const tokens = valid ? fields.reduce((sum, field) => sum + (raw[field] ?? 0), 0) : undefined
            const taskIds = [...new Set(related.map(op => op.taskId))]
            const inputs = this.executions.get(agent)?.inputs
            const shared = taskIds.length !== 1 || !inputs || [...inputs.keys()].some(id => !related.some(op => op.id === id))
            next.usage[key] = { sessionId: agent.id, seq: event.seq, turn: event.data.turn, taskIds, shared, ...(tokens === undefined ? {} : { tokens, raw: structuredClone(raw) }) }
            if (tokens === undefined) next.usageIncomplete = true
            else next.observedTokens += tokens
            if (next.state === 'active' && next.budget.maxObservedTokens !== undefined && next.observedTokens >= next.budget.maxObservedTokens) { next.state = 'budget-exhausted'; next.reason = 'observed token budget exhausted (missing usage is not estimated)' }
          }).catch(error => console.warn('[session-coordinator] usage could not persist:', errorText(error)))
        }
      }
      if (event.type === 'user/message') {
        if (event.data.source?.kind === 'user' && session.isOwnSeq?.(event.seq) !== false) void this.recordHumanInput(agent, event.data, event.seq).catch(error => console.warn('[session-coordinator] participant correction pending:', errorText(error)))
        // Claims identify native incoming work; generated prompt context is also logged as user/message.
        if (isUserFacingSource(event.data.source?.kind)) this.executions.get(agent)?.inputs.set(event.data.id, event.data)
        updateMessage(agent, event.data, 'admitted', this.executions.get(agent)?.turn)
      }
    }))
    this.disposers.push(on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (!this.active || signal.aborted || decision.kind !== 'enter') return decision
      await Promise.all([...this.chains.values()])
      const messages = decision.messages.filter((message: UserMessage) => {
        if (message.source?.kind !== 'session-collaboration') return true
        const scope = this.scopes.get(message.source.scopeId), op = scope?.operations[message.id]
        if (!scope || !op || op.target !== agent.id || !isDeepStrictEqual(message, this.message(scope, op)) || !['submitted', 'claimed', 'prepared', 'admitted'].includes(op.status)) return false
        const task = scope.tasks[op.taskId]
        return task && task.revision === op.taskRevision && scope.authorization.process === this.process && (op.control || scope.state === 'active' && task.state === 'active')
      })
      return messages.length === decision.messages.length ? decision : { ...decision, messages }
    }))
    this.disposers.push(on('agent/disposed', ({ agent }) => {
      const live = this.env.ctx.agents.get(agent.id as never), execution = this.executions.get(agent)
      if (live && live !== agent) return
      const instance = this.instances.get(agent)
      const unresolved = new Map<string, number>()
      for (const scope of this.scopes.values()) for (const op of Object.values(scope.operations)) if (instance && op.target === agent.id && op.status === 'admitted' && !op.resultId && op.execution?.startsWith(instance + ':') && op.turn !== undefined) unresolved.set(op.execution, op.turn)
      if (execution) unresolved.set(execution.id, execution.turn)
      for (const [id, turn] of [...unresolved].sort((a, b) => b[1] - a[1])) void this.executionFailed(agent, turn, { code: 'TARGET_DISPOSED', message: 'Target instance disposed before returning its admitted task result' }, true, { id, turn }).catch(error => console.warn('[session-coordinator] disposed task failure could not persist:', errorText(error)))
      this.executions.delete(agent)
      for (const scope of this.scopes.values()) if (Object.values(scope.operations).some(op => op.target === agent.id && ['submitted', 'claimed'].includes(op.status))) {
        void this.change(scope.id, next => { for (const op of Object.values(next.operations)) if (op.target === agent.id && ['submitted', 'claimed'].includes(op.status)) { op.status = 'unknown'; op.error = 'Target instance disposed; inspect before continuing' } }).catch(error => console.warn('[session-coordinator] disposal observation failed:', errorText(error)))
      }
    }))
  }

  async close(): Promise<void> {
    this.closing = true
    for (const operation of this.taskOperations) operation.controller.abort(new Error('Runtime closed; material operation revoked'))
    await Promise.all([...this.taskOperations].map(operation => operation.done))
    if (this.timer !== undefined) (this.env.ctx as unknown as { clearInterval(handle: unknown): void }).clearInterval(this.timer)
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    await Promise.allSettled([...this.chains.values()])
    this.active = false
    for (const controller of this.questionControllers.values()) controller.abort(new Error('Runtime closed'))
    await this.store.close()
  }
}
