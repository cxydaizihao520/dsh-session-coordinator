/** Runtime evidence for native execution and message consumption; never an executor. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type UserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { getLiveAgent, sessionEvents, type LiveAgentLike } from './core.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
/** Shared native pre-step rule: filtering stale input must not start an empty
 * new turn, and must not discard an already-running turn's history. */
export function withFilteredStepInputs<T extends {kind:'enter';messages:UserMessage[]}>(agent:LiveAgentLike,turn:number,decision:T,messages:UserMessage[]):T|{kind:'reject'} {
  if(messages.length===decision.messages.length)return decision
  const hasPriorStep=sessionEvents(agent.session).some(event=>event.type==='step/start'&&event.data.turn===turn&&agent.session.isOwnSeq?.(event.seq)!==false)
  if(!hasPriorStep&&!messages.some(message=>(message.source as {kind?:string}|undefined)?.kind!=='runtime-context'))return {kind:'reject'}
  return {...decision,messages}
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-session-coordinator/consumption': JsonValue }
}

type Consumption = 'pending' | 'claimed' | 'included' | 'withdrawn' | 'unknown'
interface Execution { id: string; agent: LiveAgentLike; turn: number; signal: AbortSignal; strict: Set<string> }
interface Observation { agent: LiveAgentLike; message: UserMessage; consumption: Consumption; executionId?: string; revision?: number }

export class SessionDeliveryState {
  private readonly executions = new Map<string, Execution>()
  private readonly endedExecutions = new Map<string, LiveAgentLike>()
  private readonly observations = new Map<string, Observation>()
  private readonly expired = new Set<string>()
  private active = true
  private readonly ctx: Context
  private readonly onWithdrawn: (agent: LiveAgentLike, id: string) => void
  constructor(ctx: Context, onWithdrawn: (agent: LiveAgentLike, id: string) => void) {
    this.ctx = ctx; this.onWithdrawn = onWithdrawn
    ctx.effect?.(() => () => { for (const execution of this.executions.values()) this.expire(execution); this.active = false; this.executions.clear() })
    ctx.on?.('agent/pre-step', async ({ agent, turn, signal }, next) => {
      if (this.active && getLiveAgent(ctx, agent.id) === agent) {
        let execution = this.executions.get(agent.id)
        if (!execution || execution.agent !== agent || execution.turn !== turn || execution.signal !== signal) {
          if (execution) this.expire(execution)
          execution = { id: 'execution-' + randomUUID(), agent, turn, signal, strict: new Set() }
          this.executions.set(agent.id, execution)
          const bound = execution
          signal.addEventListener('abort', () => this.expire(bound), { once: true })
        }
      }
      const decision = await next()
      if (!this.active || decision.kind !== 'enter') return decision
      const executionId = this.executions.get(agent.id)?.id
      const allowed = decision.messages.filter(message => {
        const source = message.source as { protocolVersion?: number; expectedExecution?: string } | undefined
        const expired = this.expired.has(message.id) || source?.protocolVersion === 2 && source.expectedExecution !== undefined && source.expectedExecution !== executionId
        if (expired) this.onWithdrawn(agent, message.id)
        return !expired
      })
      return withFilteredStepInputs(agent,turn,decision,allowed)
    })
    ctx.on?.('session/event', (session, event) => {
      const execution = this.executions.get(String(session.id))
      if (execution?.agent.session === session && event.type === 'turn/end' && execution.turn === event.data.turn) {
        this.endedExecutions.set(execution.id, execution.agent)
        this.expire(execution, true); this.executions.delete(String(session.id))
      }
    })
    ctx.on?.('agent/inbox/claimed', ({ agent, message, turn }) => {
      const observed = this.observations.get(message.id)
      if (observed?.agent === agent && isDeepStrictEqual(observed.message, message)) {
        const execution = this.executions.get(agent.id)
        this.observe(message.id, 'claimed', execution?.turn === turn ? execution.id : undefined)
      }
    })
    const state = this
    ctx.on?.('llm/stream', async function* (request, next) {
      if (state.active && isAgentLoopRequest(request) && typeof request.sessionId === 'string') {
        const agent = getLiveAgent(ctx, request.sessionId)
        const execution = state.executions.get(request.sessionId)
        if (agent && execution?.agent === agent && !execution.signal.aborted) {
          for (const message of request.messages) {
            const observed = state.observations.get(message.id ?? '')
            if (observed?.agent === agent && isDeepStrictEqual(observed.message, message)) state.observe(observed.message.id, 'included', execution.id)
          }
        }
      }
      yield* next()
    })
  }

  executionId(agent: LiveAgentLike): string | undefined {
    const execution = this.executions.get(agent.id)
    return this.active && execution?.agent === agent && !execution.signal.aborted && agent.status === 'running' ? execution.id : undefined
  }

  executionStopped(agent: LiveAgentLike, id: string): boolean {
    return this.endedExecutions.get(id) === agent
  }

  replaceMessage(agent: LiveAgentLike, message: UserMessage, revision: number): void {
    const previous = this.observations.get(message.id)
    this.observations.set(message.id, { ...previous, agent, message, revision, consumption: previous?.consumption ?? 'pending' })
  }

  recordMutation(id: string, withdrawn = false): void {
    if (withdrawn) this.observe(id, 'withdrawn')
    else if (this.observations.get(id)?.consumption === 'pending') this.observe(id, 'pending')
  }

  assertSubmission(agent: LiveAgentLike, mode: string, expectedExecution?: string): void {
    const execution = this.executions.get(agent.id)
    if (mode === 'context') return
    if (agent.status === 'running' && execution?.agent !== agent) throw new Error('CAPABILITY_UNAVAILABLE: current running execution has not been observed')
    if (execution?.agent === agent && execution.signal.aborted) throw new Error('EXECUTION_CONFLICT: target execution is cancelling')
    if (mode !== 'steer') return
    if (!expectedExecution || !this.executionId(agent) || this.executionId(agent) !== expectedExecution) throw new Error('EXECUTION_CONFLICT: strict steer requires the observed current execution')
    if (!agent.send || !agent.inbox?.remove) throw new Error('CAPABILITY_UNAVAILABLE: strict steer needs native send and precise pending removal')
  }

  prepare(agent: LiveAgentLike, message: UserMessage, mode: string, expectedExecution?: string): void {
    this.assertSubmission(agent, mode, expectedExecution)
    this.observations.set(message.id, { agent, message, consumption: 'pending' })
    if (mode === 'steer') this.executions.get(agent.id)!.strict.add(message.id)
  }

  rejectExpiredStrict(agent: LiveAgentLike, message: UserMessage): boolean {
    const expected = (message.source as { expectedExecution?: string } | undefined)?.expectedExecution
    if (!expected || this.executionId(agent) === expected) return false
    this.expired.add(message.id)
    this.onWithdrawn(agent, message.id)
    if (!this.observations.has(message.id)) this.observations.set(message.id, { agent, message, consumption: 'pending' })
    queueMicrotask(() => {
      try { if (agent.inbox?.remove?.(message.id)) this.observe(message.id, 'withdrawn') } catch { /* The pre-step fence still excludes it. */ }
    })
    return true
  }

  afterSubmission(agent: LiveAgentLike, messageId: string, mode: string, expectedExecution?: string): void {
    if (mode === 'steer' && this.executionId(agent) !== expectedExecution && agent.inbox?.remove?.(messageId)) this.observe(messageId, 'withdrawn')
  }

  uncertain(messageId: string): void {
    const observed = this.observations.get(messageId)
    if (!observed || observed.consumption !== 'pending') return
    const pending = [...observed.agent.inbox?.nextStep ?? [], ...observed.agent.inbox?.nextTurn ?? []]
    if (!pending.some(message => (message as { id?: string }).id === messageId)) this.observe(messageId, 'unknown')
  }

  private expire(execution: Execution, publishing = false): void {
    if (!this.active) return
    const ids = [...execution.strict]
    execution.strict.clear()
    for (const id of ids) { this.expired.add(id); this.onWithdrawn(execution.agent, id) }
    const remove = (id: string, retry: boolean) => {
      try {
        const observed = this.observations.get(id)
        if (observed?.agent === execution.agent && observed.consumption === 'pending' && execution.agent.inbox?.remove?.(id)) this.observe(id, 'withdrawn', execution.id)
      } catch {
        // Native SessionStore forbids append during publication. The pre-step
        // fence above already excludes this exact input if claim wins the race.
        if (retry) queueMicrotask(() => remove(id, false))
      }
    }
    for (const id of ids) {
      if (publishing) queueMicrotask(() => remove(id, false))
      else remove(id, true)
    }
  }

  private observe(id: string, consumption: Consumption, executionId?: string): void {
    const observed = this.observations.get(id)
    if (!this.active || !observed || observed.consumption === 'withdrawn' || observed.consumption === 'included') return
    observed.consumption = consumption
    if (consumption === 'withdrawn') this.onWithdrawn(observed.agent, id)
    if (executionId) observed.executionId = executionId
    // Observation persistence must not abort the native request or an AbortSignal listener.
    try {
      appendPluginRecord(observed.agent.session, 'plugin:dsh-session-coordinator/consumption', { version: 2, messageId: id, consumption, revision: observed.revision ?? 1, ...(executionId ? { executionId } : {}) })
      void this.ctx.sessions?.flush?.(observed.agent.session).catch(() => {})
    } catch { /* Current runtime evidence remains available; reload cannot invent missing evidence. */ }
  }

  snapshot(agent: LiveAgentLike) {
    const rows = new Map<string, { messageId: string; consumption: Consumption; revision: number; executionId?: string }>()
    for (const event of sessionEvents(agent.session)) {
      if (agent.session.isOwnSeq?.(event.seq) === false) continue
      const record = pluginRecordOf(event)
      const value = record?.data as { version?: number; messageId?: string; consumption?: Consumption; executionId?: string; revision?: number } | undefined
      if (record?.type === 'plugin:dsh-session-coordinator/consumption' && value?.version === 2 && typeof value.messageId === 'string' && ['pending', 'claimed', 'included', 'withdrawn', 'unknown'].includes(value.consumption ?? '')) rows.set(value.messageId, { messageId: value.messageId, consumption: value.consumption!, revision: value.revision ?? 1, ...(value.executionId ? { executionId: value.executionId } : {}) })
    }
    for (const message of [...agent.inbox?.nextStep ?? [], ...agent.inbox?.nextTurn ?? []] as UserMessage[]) {
      if ((message.source as { protocolVersion?: number } | undefined)?.protocolVersion === 2 && !rows.has(message.id)) rows.set(message.id, { messageId: message.id, consumption: 'pending', revision: 1 })
    }
    for (const value of this.observations.values()) if (value.agent === agent) rows.set(value.message.id, { messageId: value.message.id, consumption: value.consumption, revision: value.revision ?? 1, ...(value.executionId ? { executionId: value.executionId } : {}) })
    return [...rows.values()]
  }
}
