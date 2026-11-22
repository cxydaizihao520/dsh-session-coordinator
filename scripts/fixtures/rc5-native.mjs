import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['agents', 'jobs', 'llm', 'tools']

const provider = 'coordinator-test'
const input = label => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: label }] })

export function apply(ctx) {
  const exit = ctx.get('appExit')
  const checks = []
  const errors = []
  const trace = []
  const evidence = {}
  const opened = Promise.withResolvers()
  const release = Promise.withResolvers()
  const producing = Promise.withResolvers()
  let owner, worker, blankOwner, jobId
  let stage = 'mount'
  const timeout = setTimeout(() => save(1, new Error('Timed out at ' + stage)), 18000)
  let requestOwnerTool = true
  const workerRequests = []

  class TestAdapter extends LlmAdapter {
    async *stream(request) {
      const last = request.messages.findLast(message => message.role === 'user' && ['user', 'session-message'].includes(message.source?.kind))
      const text = last?.content.map(block => block.text ?? '').join('') ?? ''
      let tool
      if (request.sessionId === owner.id && requestOwnerTool) {
        requestOwnerTool = false
        tool = 'rc5_owner_work'
      }
      if (request.sessionId === worker.id) {
        workerRequests.push(request.messages.filter(message => message.source?.kind === 'session-message')
          .flatMap(message => message.content).map(block => block.text ?? '').join('\n'))
        if (text.includes('native busy work')) tool = 'rc5_hold_step'
        if (text.includes('native cancellable task')) tool = 'rc5_background_work'
      }
      trace.push({ session: request.sessionId, text, tool })
      const block = tool
        ? { type: 'tool-call', id: randomUUID(), name: tool, arguments: '{}' }
        : { type: 'text', text: 'local proof complete' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
    }
  }

  const register = (name, execute) => ctx.tools.register(defineTool({
    name, description: 'Deterministic local compatibility fixture',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute,
  }))

  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/result' && event.data.message?.isError) {
      trace.push({ session: session.id, error: event.data.message.content })
    }
  })
  ctx.on('agent/error', ({ agent, error }) => {
    errors.push({ id: agent.id, message: String(error) })
    save(1, error)
  })
  // Approve only the two named requests from the isolated fixture owners.
  ctx.on('approval/request', async (request, next) => {
    if (request.agent === owner && request.callId === 'rc5-baseline' && request.toolName === 'session_coordinator_send') return 'allowed-once'
    if (request.agent === blankOwner && request.callId === 'rc5-blank-create' && request.toolName === 'session_coordinator_create') return 'allowed-once'
    return next()
  })

  register('rc5_hold_step', async (_args, { agent }) => {
    assert.equal(agent, worker)
    opened.resolve()
    await release.promise
    return 'released'
  })
  register('rc5_background_work', async (_args, exec) => {
    assert.equal(exec.agent, worker)
    const producer = Promise.withResolvers()
    jobId = ctx.jobs.start({
      owner: worker.id, kind: 'compatibility-probe', label: 'local deterministic work',
      toolCall: { callId: exec.callId, rootCallId: exec.callId },
      run() { return { done: producer.promise, cancel() { producer.resolve({ status: 'killed' }) } } },
    })
    producing.resolve()
    if (!exec.signal.aborted) await once(exec.signal, 'abort')
    exec.signal.throwIfAborted()
    return 'stopped'
  })
  register('rc5_owner_work', async (_args, exec) => {
    const call = (tool, args, id = exec.callId) => ctx.tools.get('session_coordinator_' + tool, owner)
      .execute(args, { ...exec, agent: owner, callId: id })
    const send = options => call('send', { targets: [worker.id], ...options }, options.requestId)
    const baseline = await send({
      content: 'native busy work', requestId: 'rc5-baseline',
      authorizationRequest: {
        extent: 'work', participants: [owner.id, worker.id], purpose: 'local smoke workflow',
        controls: { actions: ['message.withdraw', 'task.cancel', 'job.stop'] },
      },
    })
    assert.equal(baseline.results[0].admission, 'accepted', JSON.stringify(baseline))
    const context = { communicationHandle: baseline.communicationHandle }
    stage = 'worker hold'
    await opened.promise
    assert.equal(worker.status, 'running')
    const status = await call('status', { sessionId: worker.id })
    assert.ok(status.executionId)
    const turn = worker.session.snapshotEvents().findLast(event => event.type === 'turn/start').data.turn
    const steer = await send({ content: 'native steer sentinel', delivery: 'steer', expectedExecution: status.executionId, context, requestId: 'rc5-steer' })
    const queue = await send({ content: 'withdraw this sentinel', delivery: 'queue', context, requestId: 'rc5-queue-withdraw' })
    assert.equal(steer.results[0].admission, 'accepted', JSON.stringify(steer))
    assert.equal(queue.results[0].admission, 'accepted', JSON.stringify(queue))
    const queued = queue.results[0].messageId
    const steered = steer.results[0].messageId
    assert.ok(worker.inbox.nextTurn.some(message => message.id === queued))
    const withdrawn = await call('control', { object: 'message', action: 'withdraw', messageId: queued, requestId: 'rc5-withdraw' })
    assert.equal(withdrawn.outcome, 'withdrawn', JSON.stringify(withdrawn))
    assert.ok(!worker.inbox.nextTurn.some(message => message.id === queued))
    assert.ok(worker.inbox.nextStep.some(message => message.id === steered))
    release.resolve()
    stage = 'worker idle'
    await worker.whenIdle()
    const events = () => worker.session.snapshotEvents()
    assert.ok(events().some(event => event.type === 'user/message' && event.data.id === steered))
    assert.ok(workerRequests[1]?.includes('native steer sentinel'))
    assert.equal(events().filter(event => event.type === 'turn/start').at(-1).data.turn, turn)
    evidence.steer = { turn, messageId: steered }
    checks.push('busy-steer-consumed-in-original-turn')
    assert.ok(!events().some(event => event.type === 'user/message' && event.data.id === queued))
    assert.ok(workerRequests.every(request => !request.includes('withdraw this sentinel')))
    evidence.withdraw = { messageId: queued, outcome: withdrawn.outcome }
    checks.push('withdrawn-pending-input-never-consumed')

    const task = await call('task', { ...context, objective: 'only the cancellable work', members: [worker.id], requestId: 'rc5-task-create' })
    const dispatched = await send({ content: 'native cancellable task', context: { ...context, taskHandle: task.taskHandle }, requestId: 'rc5-task-send' })
    assert.equal(dispatched.results[0].admission, 'accepted', JSON.stringify(dispatched))
    stage = 'worker producer'
    await producing.promise
    assert.equal(ctx.jobs.get(jobId, worker.id).status, 'running')
    const cancellableTurn = events().findLast(event => event.type === 'turn/start').data.turn
    const queuedOther = await send({ content: 'independent next work', delivery: 'queue', context, requestId: 'rc5-unrelated' })
    assert.equal(queuedOther.results[0].admission, 'accepted', JSON.stringify(queuedOther))
    const cancelled = await call('control', {
      object: 'task', action: 'cancel', taskHandle: task.taskHandle, expectedRevision: 1,
      reason: 'cancel only the attributed work', requestId: 'rc5-task-cancel',
    })
    assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled))
    stage = 'worker idle'
    await worker.whenIdle()
    assert.equal(ctx.jobs.get(jobId, worker.id).status, 'killed', JSON.stringify(cancelled))
    const terminal = events().find(event => event.type === 'turn/end' && event.data.turn === cancellableTurn)
    assert.equal(terminal?.data.reason.kind, 'aborted')
    assert.ok(events().some(event => event.type === 'job/settled' && event.data.jobId === jobId &&
      event.data.status === 'killed' && event.data.producerReported === true))
    const otherId = queuedOther.results[0].messageId
    // After a native cancel, the retained queue runs when the idle Agent next wakes.
    assert.ok(worker.inbox.nextTurn.some(message => message.id === otherId))
    worker.followup(input('wake preserved queue'))
    await worker.whenIdle()
    assert.ok(events().some(event => event.type === 'user/message' && event.data.id === otherId))
    assert.equal(events().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    evidence.cancel = { turn: cancellableTurn, taskState: cancelled.state, jobId, jobStatus: 'killed', preservedMessageId: otherId }
    checks.push('cancelled-task-stopped-native-turn-and-producer-preserved-other-input')
    return 'verified'
  })

  void (async () => {
    stage = 'loader'
    await ctx.get('loader').await()
    const route = { provider, model: 'fixture' }
    ctx.llm.registerAdapter([provider], new TestAdapter())
    const create = async id => (await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd() }, agentOptions: route })).agent
    owner = await create('compat-owner')
    worker = await create('compat-worker')
    const builtIn = ['send_message', 'list_agents', 'job_list', 'job_output', 'job_kill']
    for (const name of [...builtIn, 'session_coordinator_send', 'session_coordinator_control']) {
      assert.ok(ctx.tools.get(name, owner), 'missing tool ' + name)
    }
    evidence.coexistingBuiltInTools = builtIn
    stage = 'blank session default model'
    blankOwner = await create('compat-blank-owner')
    blankOwner.session.append('turn/start', { turn: 1 })
    const blank = await ctx.tools.get('session_coordinator_create', blankOwner).execute(
      { requestId: 'rc5-blank-create' },
      { agent: blankOwner, signal: new AbortController().signal, callId: 'rc5-blank-create' },
    )
    blankOwner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.equal(blank.creationState, 'created', JSON.stringify(blank))
    const created = ctx.agents.get(blank.sessionId)
    assert.deepEqual(created.model.current(), route)
    created.followup(input('first request after empty chat creation'))
    await created.whenIdle()
    const firstRequest = created.session.requestHeader()?.config
    assert.equal(firstRequest?.provider, provider)
    assert.equal(firstRequest?.model, route.model)
    evidence.defaultModel = route

    stage = 'owner model'
    owner.followup(input('run isolated compatibility proof'))
    await owner.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(checks.length, 3)
  })().then(() => save(0), error => save(1, error))

  function save(code, error) {
    clearTimeout(timeout)
    writeFileSync(process.env.DSH_HOME + '/rc5-native.json', JSON.stringify({ stage, checks, evidence, errors, ...(code ? { trace, error: error?.stack } : {}) }, null, 2))
    exit(code)
  }
}
