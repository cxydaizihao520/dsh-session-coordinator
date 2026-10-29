import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installCollaboration } from '../src/collaboration-tools.ts'
import { Context } from 'cordis'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'

function harness(seed = [], providedStore) {
  const records = new Map(seed.map(r => [r.id, structuredClone(r)])), tools = new Map(), agents = new Map(), listeners = new Map(), submissions = [], approvals = []
  const store = providedStore ?? { get: id => structuredClone(records.get(id)), list: owner => [...records.values()].filter(r => !owner || r.owner === owner).map(r => structuredClone(r)),
    async create(r) { if (records.has(r.id)) throw Error('exists'); records.set(r.id, structuredClone(r)); return structuredClone(r) },
    async update(id, revision, mutate) { const r = records.get(id); if (r.revision !== revision) throw Error('revision mismatch'); const next = mutate(structuredClone(r)); assert.equal(next.revision, revision + 1); records.set(id, structuredClone(next)); return structuredClone(next) }, async close() {} }
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  for (const id of ['A', 'B', 'C', 'D']) agents.set(id, { id, status: 'idle', session: { id, header: { id }, getDerivedMessages: () => [] }, inbox: { nextStep: [], nextTurn: [], replace(messageId, message) { for (const list of [this.nextStep, this.nextTurn]) { const i = list.findIndex(m => m.id === messageId); if (i >= 0) { list[i] = message; return true } } return false }, remove(messageId) { for (const list of [this.nextStep, this.nextTurn]) { const i = list.findIndex(m => m.id === messageId); if (i >= 0) { list.splice(i, 1); return true } } return false } }, cancel() {} })
  const clock = { callback: undefined, async tick() { await this.callback?.() }, async flush() { await new Promise(resolve => setImmediate(resolve)) } }
  const ctx = { setInterval(fn) { clock.callback = fn; return 1 }, clearInterval() { clock.callback = undefined }, agents: { get: id => agents.get(id), list: () => [...agents.values()] }, tools: { register: t => tools.set(t.name, t) },
    get: name => name === 'approval' ? { async request(value) { approvals.push(value); return 'allowed-once' } } : undefined,
    on(name, fn) { const l = listeners.get(name) ?? []; l.push(fn); listeners.set(name, l); return () => {} }, effect(fn) { return fn() } }
  const delivery = { async deliverScoped(targetId, message, caller, options) {
    options.validate(); const target = agents.get(targetId); options.validate(target); if (options.prepareMessage) message = await options.prepareMessage(target); options.validate(target); options.beforeSubmit?.(target)
    submissions.push({ targetId, message, mode: options.mode }); target.inbox[options.mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
    return { messageId: message.id, sinceSeq: 0 }
  } }
  ctx.workspaceRegistry = { list: () => [], resolveByPath: async () => undefined }
  const ready = installCollaboration({ ctx, delivery, registry: { record() {} } }, { store })
  let call = 0
  const run = async (name, args, caller = 'A', callId) => { await ready; return tools.get('session_coordinator_collaboration_' + name).execute(args, { agent: agents.get(caller), signal: new AbortController().signal, callId: callId ?? 'call-' + ++call }) }
  return { async stream(options) { let next = async function* () {}; for (const fn of [...(listeners.get('llm/stream') ?? [])].reverse()) { const inner = next; next = () => fn(options, inner) } for await (const _chunk of next()) {} }, async dispatch(name, ...args) { for (const fn of listeners.get(name) ?? []) await fn(...args) }, ctx, delivery, clock, store, ready, tools, agents, emit, submissions, approvals, run, records, async admit(operationId, turn = 1) {
    const submission = submissions.find(s => s.message.id === operationId), agent = agents.get(submission.targetId)
    const message = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find(item => item.id === operationId) ?? submission.message
    agent.status = 'running'; agent.inbox.remove(operationId)
    emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
    emit('agent/inbox/claimed', { agent, message, turn })
    emit('session/event', agent.session, { type: 'user/message', data: message })
    await run('status', { scopeId: submission.message.source.scopeId })
  } }
}

test('one scoped approval supports owner + N, two tasks and more than two rounds with correlated results', async () => {
  const h = harness()
  const scope = await h.run('start', { objective: 'Deliver two independently verified changes', members: ['B', 'C', 'D'] })
  const one = await h.run('task', { scopeId: scope.id, objective: 'First change', members: ['B', 'C'] })
  const two = await h.run('task', { scopeId: scope.id, objective: 'Second change', members: ['B', 'D'] })
  for (let round = 0; round < 4; round++) {
    const sent = await h.run('send', { scopeId: scope.id, taskId: one.id, taskRevision: 1, sessionId: 'B', message: 'Check round ' + round, intent: 'task' })
    await h.admit(sent.id, round + 1)
    const result = await h.run('result', { scopeId: scope.id, taskId: one.id, taskRevision: 1, operationId: sent.id, text: 'Evidence for round ' + round }, 'B')
    assert.equal(result.taskId, one.id)
  }
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(Object.keys(status.results).length, 4)
  assert.equal(status.tasks[two.id].state, 'active')
  assert.equal(h.approvals.length, 1)
  assert.match(h.approvals[0].reason, /Deliver two independently verified changes/)
  assert.match(h.approvals[0].reason, /B.*C.*D/)
  assert.equal(h.submissions[0].message.source.kind, 'session-collaboration')
})

test('result notifications use the next-step delivery seam for busy and idle owners while new tasks stay queued', async () => {
  for (const busy of [true, false]) {
    const h = harness(), scope = await h.run('start', { objective: 'Combine peer evidence with owner work', members: ['B'] })
    const task = await h.run('task', { scopeId: scope.id, objective: 'Compute peer amount', members: ['B'] })
    const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Compute amount', intent: 'task' })
    assert.equal(h.submissions.at(-1).mode, 'queue')
    await h.admit(op.id)
    const owner = h.agents.get('A')
    owner.cancel = () => assert.fail('a peer result must not cancel owner work')
    if (busy) {
      owner.status = 'running'
      h.emit('session/event', owner.session, { type: 'turn/start', data: { turn: 7 } })
    }
    const before = (await h.run('status', { scopeId: scope.id })).executions.A
    const result = await h.run('result', { scopeId: scope.id, taskId: task.id, taskRevision: 1, operationId: op.id, text: 'Amount = 71' }, 'B')
    const notice = h.submissions.at(-1)
    assert.equal(notice.targetId, 'A')
    assert.equal(notice.message.source.intent, 'result')
    assert.equal(notice.mode, 'steer', 'results must reach the current turn next step, or wake an idle owner through the same native seam')
    assert.ok(owner.inbox.nextStep.some(message => message.id === notice.message.id))
    assert.equal(owner.inbox.nextTurn.length, 0)
    assert.equal(h.approvals.length, 1)
    let state = await h.run('status', { scopeId: scope.id })
    assert.equal(state.operations[notice.message.id].resultId, result.id)
    assert.equal(state.operations[notice.message.id].status, 'submitted', 'queue insertion alone is not native admission')
    if (busy) {
      assert.equal(state.executions.A, before)
      owner.inbox.remove(notice.message.id)
      h.emit('agent/inbox/claimed', { agent: owner, message: notice.message, turn: 7 })
      h.emit('session/event', owner.session, { type: 'user/message', data: notice.message })
      state = await h.run('status', { scopeId: scope.id })
      assert.equal(state.operations[notice.message.id].status, 'admitted')
      assert.equal(state.operations[notice.message.id].turn, 7)
      assert.equal(state.operations[notice.message.id].execution, before)
    }
  }
})

test('pending next-step results remain withdrawable by pause, cancel or revision without touching unrelated owner input', async () => {
  for (const action of ['pause', 'cancel', 'revise']) {
    const h = harness(), scope = await h.run('start', { objective: 'Respect changed work', members: ['B'] })
    const task = await h.run('task', { scopeId: scope.id, objective: 'Compute', members: ['B'] })
    const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Compute', intent: 'task' })
    await h.admit(op.id)
    const result = await h.run('result', { scopeId: scope.id, taskId: task.id, taskRevision: 1, operationId: op.id, text: 'Evidence' }, 'B')
    const notice = h.submissions.at(-1), owner = h.agents.get('A')
    assert.equal(notice.mode, 'steer')
    owner.inbox.nextStep.push({ id: 'unrelated-owner-work' })
    await h.run('control', { scopeId: scope.id, taskId: task.id, action, ...(action === 'revise' ? { objective: 'Updated compute' } : {}), reason: 'User changed work' })
    const state = await h.run('status', { scopeId: scope.id })
    assert.equal(state.operations[notice.message.id].status, 'withdrawn')
    assert.deepEqual(owner.inbox.nextStep.map(message => message.id), ['unrelated-owner-work'])
    assert.equal(state.results[result.id].text, 'Evidence')
  }
})

test('an uncertain next-step result delivery is retained and never reissued by a duplicate result', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Single result notification', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Compute', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Compute', intent: 'task' })
  await h.admit(op.id)
  const deliver = h.delivery.deliverScoped
  h.delivery.deliverScoped = async (...args) => { await deliver(...args); throw Error('native durability outcome unknown') }
  const args = { scopeId: scope.id, taskId: task.id, taskRevision: 1, operationId: op.id, text: 'Evidence' }
  const result = await h.run('result', args, 'B'), notice = h.submissions.at(-1)
  assert.equal(notice.mode, 'steer')
  const count = h.submissions.length
  assert.deepEqual(await h.run('result', args, 'B'), result)
  assert.equal(h.submissions.length, count)
  const state = await h.run('status', { scopeId: scope.id })
  assert.equal(state.operations[notice.message.id].status, 'unknown')
  assert.match(state.operations[notice.message.id].error, /durability outcome unknown/)
})

test('results require native admission and preserve exact task revision after correction', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Current objective', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Version one', members: ['B'] })
  const sent = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  const result = { scopeId: scope.id, taskId: task.id, taskRevision: 1, operationId: sent.id, text: 'Old evidence' }
  await assert.rejects(h.run('result', result, 'B'), /admitted/)
  await h.admit(sent.id)
  await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'revise', objective: 'Version two', reason: 'User changed target' })
  const before = h.submissions.length
  assert.equal((await h.run('result', result, 'B')).stale, true)
  assert.equal(h.submissions.length, before)
  await assert.rejects(h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Old plan', intent: 'task' }), /revision/)
})

test('pause, cancel and completion keep late results without restarting stopped work; cancellation preserves another task inbox', async () => {
  for (const action of ['pause', 'cancel']) {
    const h = harness(), scope = await h.run('start', { objective: 'Two tasks', members: ['B'] })
    const one = await h.run('task', { scopeId: scope.id, objective: 'One', members: ['B'] })
    const two = await h.run('task', { scopeId: scope.id, objective: 'Two', members: ['B'] })
    const first = await h.run('send', { scopeId: scope.id, taskId: one.id, taskRevision: 1, sessionId: 'B', message: 'One', intent: 'task' })
    await h.admit(first.id)
    const second = await h.run('send', { scopeId: scope.id, taskId: two.id, taskRevision: 1, sessionId: 'B', message: 'Two', intent: 'task' })
    await h.run('control', { scopeId: scope.id, taskId: one.id, action, reason: 'User requested stop' })
    const before = h.submissions.length
    const result = await h.run('result', { scopeId: scope.id, taskId: one.id, taskRevision: 1, operationId: first.id, text: 'Late accepted evidence' }, 'B')
    assert.equal(h.submissions.length, before)
    assert.equal((await h.run('status', { scopeId: scope.id })).results[result.id].text, 'Late accepted evidence')
    assert.ok(h.agents.get('B').inbox.nextTurn.some(m => m.id === second.id))
    await assert.rejects(h.run('send', { scopeId: scope.id, taskId: one.id, taskRevision: 1, sessionId: 'B', message: 'Continue old task', intent: 'task' }), /not active/)
  }
})

test('wait-any and wait-all observe independently correlated results; duplicates never notify twice', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Two deliveries', members: ['B', 'C'] })
  const tasks = await Promise.all(['B', 'C'].map(async member => {
    const t = await h.run('task', { scopeId: scope.id, objective: member + ' work', members: [member] })
    const op = await h.run('send', { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: member, message: 'Work', intent: 'task' })
    await h.admit(op.id); return { t, op, member }
  }))
  const item = tasks[0], resultArgs = { scopeId: scope.id, taskId: item.t.id, taskRevision: 1, operationId: item.op.id, text: 'Ready' }
  const result = await h.run('result', resultArgs, item.member)
  const before = h.submissions.length
  assert.deepEqual(await h.run('result', resultArgs, item.member), result)
  assert.equal(h.submissions.length, before)
  assert.equal((await h.run('wait', { scopeId: scope.id, mode: 'any', timeoutMs: 0 })).done, true)
  assert.equal((await h.run('wait', { scopeId: scope.id, mode: 'all', timeoutMs: 0 })).done, false)
  await h.run('control', { scopeId: scope.id, taskId: tasks[1].t.id, action: 'fail', reason: 'Unavailable evidence' })
  assert.equal((await h.run('wait', { scopeId: scope.id, mode: 'all', timeoutMs: 0 })).done, true)
  const empty = await h.run('wait', { scopeId: scope.id, taskIds: [item.t.id], afterResultIds: [result.id], timeoutMs: 0 })
  assert.equal(empty.done, false)
  assert.deepEqual(empty.results, [])
})

test('bounded no-progress dispatch records a visible budget reason before allowing another send', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Bounded work', members: ['B'], budget: { maxNoProgress: 3 } })
  const t = await h.run('task', { scopeId: scope.id, objective: 'Investigate', members: ['B'] })
  for (let i = 0; i < 3; i++) await h.run('send', { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Attempt ' + i, intent: 'task' })
  await assert.rejects(h.run('send', { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Unbounded attempt', intent: 'task' }), /budget/)
  assert.equal(h.submissions.length, 3)
  const state = await h.run('status', { scopeId: scope.id })
  assert.equal(state.state, 'budget-exhausted')
  assert.match(state.reason, /no-progress/)
})

test('reopen gates durable authorization and never resends an operation of unknown acceptance', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Recover safely', members: ['B'] })
  const t = await h.run('task', { scopeId: scope.id, objective: 'External change', members: ['B'] })
  const args = { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Apply change once', intent: 'task', operationId: 'stable-operation' }
  await h.run('send', args)
  const reopened = harness([...h.records.values()])
  let status = await reopened.run('status', { scopeId: scope.id })
  assert.equal(status.state, 'recovery-required')
  assert.equal(status.operations['stable-operation'].status, 'unknown')
  await reopened.run('send', args)
  assert.equal(reopened.submissions.length, 0)
  await assert.rejects(reopened.run('send', { ...args, operationId: 'fresh-side-effect' }), /not active/)
  await reopened.run('control', { scopeId: scope.id, action: 'resume', reason: 'User reviewed recovery' })
  await reopened.run('send', args)
  assert.equal(reopened.submissions.length, 0)
  status = await reopened.run('status', { scopeId: scope.id })
  assert.equal(status.operations['stable-operation'].status, 'unknown')
})

test('steer requires the exact live turn and cannot silently start an idle or replacement execution', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Precise correction', members: ['B'] })
  const t = await h.run('task', { scopeId: scope.id, objective: 'Work', members: ['B'] })
  const first = await h.run('send', { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  await h.admit(first.id, 2)
  const current = (await h.run('status', { scopeId: scope.id })).executions.B
  const steer = { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Correction', intent: 'steer' }
  await assert.rejects(h.run('send', { ...steer, expectedExecution: 'old-turn' }), /execution changed/)
  await h.run('send', { ...steer, expectedExecution: current })
  h.emit('session/event', h.agents.get('B').session, { type: 'turn/end', data: { turn: 2 } })
  h.agents.get('B').status = 'idle'
  const before = h.submissions.length
  await assert.rejects(h.run('send', { ...steer, expectedExecution: current }), /execution changed/)
  assert.equal(h.submissions.length, before)
})

test('usage records shared and missing accounting without pretending task-exact token control', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Track actual costs', members: ['B'], budget: { maxObservedTokens: 15 } })
  const t = await h.run('task', { scopeId: scope.id, objective: 'Work', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  await h.admit(op.id)
  h.emit('session/event', h.agents.get('B').session, { seq: 10, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 1 } } })
  h.emit('session/event', h.agents.get('B').session, { seq: 11, type: 'assistant/attempt', data: { turn: 1, step: 2 } })
  const state = await h.run('status', { scopeId: scope.id })
  assert.equal(state.observedTokens, 9)
  assert.equal(state.usageIncomplete, true)
  assert.equal(Object.keys(state.usage).length, 2)
})

test('one scoped approval reserves new member identities before creating idle independent sessions', async () => {
  const h = harness()
  h.ctx.agents.create = async options => {
    assert.equal(h.records.size, 1, 'scope authority must be durable before creation')
    const agent = { ...h.agents.get('B'), id: options.sessionId, session: { id: options.sessionId, header: { id: options.sessionId, cwd: options.meta.cwd } } }
    h.agents.set(agent.id, agent); return { agent }
  }
  const scope = await h.run('start', { objective: 'Create specialist collaborators', members: [], newSessions: [{ cwd: '/tmp/work', title: 'Reviewer' }, { cwd: '/tmp/work', title: 'Builder' }] })
  assert.equal(scope.members.length, 3)
  assert.equal(Object.values(scope.creations).filter(c => c.status === 'created').length, 2)
  assert.equal(h.approvals.length, 1)
  assert.equal(h.submissions.length, 0)
  const member = Object.keys(scope.creations)[0]
  const task = await h.run('task', { scopeId: scope.id, objective: 'Review implementation', members: [member] })
  const sent = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: member, message: 'Review', intent: 'task' })
  assert.equal(sent.target, member)
})

test('participant questions route through the owner and native answers return to their exact task', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Resolve a decision', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Choose implementation', members: ['B'] })
  const nativeCalls = []
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const previous = h.ctx.get
  h.ctx.get = name => name === 'userQuestions' ? { async ask(request) { nativeCalls.push(request); entered(); await gate; return { answers: [{ id: request.questions[0].id, selected: ['Small'], custom: 'Keep scope small' }] } } } : previous(name)
  const pending = await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'question', reason: 'Need user decision', question: 'Which size?', options: ['Small', 'Large'] }, 'B')
  assert.equal(nativeCalls.length, 0)
  const asked = Object.values(pending.questions)[0]
  assert.equal(asked.state, 'routed')
  const answering = h.run('control', { scopeId: scope.id, taskId: task.id, action: 'question', reason: 'Resolve participant question', questionId: asked.id })
  await started
  const waiting = await h.run('status', { scopeId: scope.id })
  assert.equal(waiting.tasks[task.id].waitReason, 'user-input')
  assert.equal(waiting.questions[asked.id].state, 'asking')
  assert.equal(waiting.questions[asked.id].nativeSessionId, 'A')
  const recovered = await harness([...h.records.values()]).run('status', { scopeId: scope.id })
  assert.equal(recovered.questions[asked.id].state, 'recovery-required')
  assert.equal(recovered.tasks[task.id].waitReason, 'recovery-required')
  release()
  const answered = await answering
  assert.equal(nativeCalls[0].agent.id, 'A')
  assert.equal(answered.questions[asked.id].state, 'answered')
  assert.equal(h.submissions.at(-1).targetId, 'B')
  assert.match(h.submissions.at(-1).message.content[0].text, /Keep scope small/)
})

test('deferred work submits only when due and never wakes after user pauses the task', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Follow up later while app lives', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Delayed work', members: ['B'] })
  const sent = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Due work', intent: 'task', notBefore: Date.now() + 10 })
  assert.equal(sent.status, 'scheduled')
  assert.equal(h.submissions.length, 0)
  await new Promise(resolve => setTimeout(resolve, 15))
  await h.clock.tick()
  assert.equal(h.submissions.length, 1)
  const second = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Paused work', intent: 'task', notBefore: Date.now() + 10 })
  await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'pause', reason: 'Do not run later' })
  await new Promise(resolve => setTimeout(resolve, 15))
  await h.clock.tick()
  assert.equal(h.submissions.length, 1)
  assert.equal((await h.run('status', { scopeId: scope.id })).operations[second.id].status, 'withdrawn')
})

test('queue edit and withdrawal are exact operations and report already-admitted input honestly', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Queue controls', members: ['B'] })
  const t = await h.run('task', { scopeId: scope.id, objective: 'Queued task', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Original', intent: 'task' })
  let state = await h.run('control', { scopeId: scope.id, taskId: t.id, action: 'edit', operationId: op.id, message: 'Corrected', reason: 'User updated pending instruction' })
  assert.equal(state.operations[op.id].text, 'Corrected')
  assert.match(h.agents.get('B').inbox.nextTurn[0].content[0].text, /Corrected/)
  state = await h.run('control', { scopeId: scope.id, taskId: t.id, action: 'withdraw', operationId: op.id, reason: 'User withdrew queued input' })
  assert.equal(state.operations[op.id].status, 'withdrawn')
  assert.equal(h.agents.get('B').inbox.nextTurn.length, 0)
  const accepted = await h.run('send', { scopeId: scope.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Accepted work', intent: 'task' })
  await h.admit(accepted.id)
  state = await h.run('control', { scopeId: scope.id, taskId: t.id, action: 'withdraw', operationId: accepted.id, reason: 'Too late to retract' })
  assert.equal(state.operations[accepted.id].status, 'admitted')
  assert.equal(Object.values(state.mutations).at(-1).status, 'not-pending')
})

test('mixed active task cancellation sends a non-waking correction and keeps unrelated task inputs', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Mixed execution', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Stop only this task', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  await h.admit(op.id)
  h.emit('session/event', h.agents.get('B').session, { type: 'user/message', data: { id: 'other-active-input', source: { kind: 'session-message' }, content: [{ type: 'text', text: 'Unrelated current work' }] } })
  h.agents.get('B').inbox.nextTurn.push({ id: 'unrelated-human-task' })
  await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'cancel', reason: 'User cancels this task' })
  const notice = h.submissions.at(-1)
  assert.equal(notice.message.source.intent, 'context')
  assert.match(notice.message.content[0].text, /cancel/)
  assert.ok(h.agents.get('B').inbox.nextTurn.some(m => m.id === 'unrelated-human-task'))
})

test('trusted participant human input is synchronized to the owner without impersonating a human sender', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Keep objective aligned', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Original work', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  await h.admit(op.id)
  h.emit('session/event', h.agents.get('B').session, { seq: 20, type: 'user/message', data: { id: 'human-correction', source: { kind: 'user' }, content: [{ type: 'text', text: 'Use the smaller scope' }] } })
  await h.clock.flush()
  const state = await h.run('status', { scopeId: scope.id })
  assert.equal(state.tasks[task.id].humanInputs[0].messageId, 'human-correction')
  assert.equal(h.submissions.at(-1).targetId, 'A')
  assert.equal(h.submissions.at(-1).message.source.senderSessionId, 'B')
  assert.match(h.submissions.at(-1).message.content[0].text, /Use the smaller scope/)
})

test('native stop boundaries continue actionable owner work with bounded durable prompts, never spin while waiting', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Persist until delivered', members: ['B'], budget: { maxNoProgress: 2 } })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Needs dispatch', members: ['B'] })
  const owner = h.agents.get('A'); owner.status = 'running'
  h.emit('session/event', owner.session, { type: 'turn/start', data: { turn: 1 } })
  for (let step = 1; step <= 3; step++) {
    h.emit('session/event', owner.session, { type: 'step/end', seq: step + 1, data: { turn: 1, step } })
    await h.dispatch('agent/turn-stopping', { agent: owner, turn: 1, signal: new AbortController().signal })
  }
  assert.equal(h.submissions.filter(s => s.targetId === 'A').length, 2)
  assert.equal((await h.run('status', { scopeId: scope.id })).state, 'budget-exhausted')
  const waiting = harness(), s = await waiting.run('start', { objective: 'Wait for work', members: ['B'] })
  const t = await waiting.run('task', { scopeId: s.id, objective: 'Delegated', members: ['B'] })
  await waiting.run('send', { scopeId: s.id, taskId: t.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  await waiting.dispatch('agent/turn-stopping', { agent: waiting.agents.get('A'), turn: 1, signal: new AbortController().signal })
  assert.equal(waiting.submissions.filter(item => item.targetId === 'A').length, 0)
})

test('production native disk store preserves completed evidence and exact operations across reopen', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { Context } = await import('cordis'), { Storage } = await import('@deepseek-ai/dsh-storage')
  const { openCollaborationStore } = await import('../src/collaboration-store.ts')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-durable-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context(); new Storage(ctx)
  const h = harness([], await openCollaborationStore(ctx, { directory }))
  t.after(async () => (await h.ready).close())
  const scope = await h.run('start', { objective: 'Durable accepted delivery', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Produce evidence', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Do the work', intent: 'task' })
  await h.admit(op.id)
  const result = await h.run('result', { scopeId: scope.id, taskId: task.id, taskRevision: 1, operationId: op.id, text: 'Verified delivery', evidence: ['commit:abcd'] }, 'B')
  await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'finish', resultIds: [result.id], reason: 'Commit and checks satisfy this task' })
  await h.run('control', { scopeId: scope.id, action: 'finish', resultIds: [result.id], reason: 'All tasks accepted' })
  await (await h.ready).close()
  const nextContext = new Context(); new Storage(nextContext)
  const reopened = harness([], await openCollaborationStore(nextContext, { directory }))
  t.after(async () => (await reopened.ready).close())
  const status = await reopened.run('status', { scopeId: scope.id })
  assert.equal(status.state, 'completed')
  assert.equal(status.tasks[task.id].state, 'completed')
  assert.equal(status.results[result.id].text, 'Verified delivery')
  assert.equal(status.operations[op.id].status, 'admitted')
  assert.equal(reopened.submissions.length, 0)
})

test('native account quota stops scheduling with a usage-limit reason distinct from task budget', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Observe account limit', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Work', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  await h.admit(op.id)
  h.emit('agent/error', { agent: h.agents.get('B'), turn: 1, step: 2, error: { code: 'ACCOUNT_QUOTA', message: 'Account balance exhausted' } })
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.state, 'usage-limited')
  assert.match(status.reason, /ACCOUNT_QUOTA/)
  await assert.rejects(h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Do not retry quota', intent: 'task' }), /not active/)
})

test('failed or cancelled tasks cannot be hidden behind an unrelated successful result at scope finish', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'All required deliveries', members: ['B'] })
  const one = await h.run('task', { scopeId: scope.id, objective: 'One', members: ['B'] })
  const two = await h.run('task', { scopeId: scope.id, objective: 'Two', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: one.id, taskRevision: 1, sessionId: 'B', message: 'One', intent: 'task' })
  await h.admit(op.id)
  const result = await h.run('result', { scopeId: scope.id, taskId: one.id, taskRevision: 1, operationId: op.id, text: 'One delivered' }, 'B')
  await h.run('control', { scopeId: scope.id, taskId: one.id, action: 'finish', reason: 'One verified', resultIds: [result.id] })
  await h.run('control', { scopeId: scope.id, taskId: two.id, action: 'fail', reason: 'Missing second deliverable' })
  await assert.rejects(h.run('control', { scopeId: scope.id, action: 'finish', reason: 'Cannot claim full completion', resultIds: [result.id] }), /completed|finish each/)
})

test('only a proven exclusive task execution is interrupted; shared turn work remains running', async () => {
  for (const mixed of [false, true]) {
    const h = harness(), scope = await h.run('start', { objective: 'Safe precise stop', members: ['B'] })
    const task = await h.run('task', { scopeId: scope.id, objective: 'Stop me', members: ['B'] })
    const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
    await h.admit(op.id)
    let cancelled = false
    h.agents.get('B').cancel = (_cause, options) => { assert.equal(options.keepInbox, true); cancelled = true }
    if (mixed) h.emit('session/event', h.agents.get('B').session, { type: 'user/message', data: { id: 'other-human-work', source: { kind: 'user' }, content: [{ type: 'text', text: 'Unrelated work' }] } })
    await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'cancel', reason: 'User stopped this task' })
    assert.equal(cancelled, !mixed)
  }
})

test('exact native model request inclusion is reported separately from history admission', async () => {
  const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm')
  const h = harness(), scope = await h.run('start', { objective: 'Observe model request', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Read input', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Read this', intent: 'task' })
  await h.admit(op.id)
  assert.equal((await h.run('status', { scopeId: scope.id })).operations[op.id].requestInclusion, undefined)
  const message = h.submissions.find(s => s.message.id === op.id).message
  await h.stream(markAgentLoopRequest({ sessionId: 'B', provider: 'fixture', model: 'fixture', messages: [message], signal: new AbortController().signal }))
  assert.equal((await h.run('status', { scopeId: scope.id })).operations[op.id].requestInclusion.evidence, 'native-llm-stream')
})

test('invalid persisted business states and task identities fail closed without reopening authority', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Validated facts', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Work', members: ['B'] })
  const seed = [...h.records.values()]
  const badState = structuredClone(seed); badState[0].data.state = 'whatever'
  await assert.rejects(harness(badState).ready, /invalid persisted collaboration/)
  const badMember = structuredClone(seed); badMember[0].data.tasks[task.id].members = ['outside-scope']
  await assert.rejects(harness(badMember).ready, /invalid persisted collaboration/)
})

test('actual native write failure fences runtime scheduling while status labels its cached snapshot and reopen reconciles', async () => {
  const { mkdtemp, rm, rename, mkdir } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { Context } = await import('cordis'), { Storage } = await import('@deepseek-ai/dsh-storage'), { openCollaborationStore } = await import('../src/collaboration-store.ts')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-failure-'))
  const ctx = new Context(); new Storage(ctx)
  const h = harness([], await openCollaborationStore(ctx, { directory }))
  let reopened
  try {
    const scope = await h.run('start', { objective: 'Do not trust failed writes', members: ['B'] })
    const medium = join(directory, 'collaboration.json'), saved = join(directory, 'saved.json')
    await rename(medium, saved); await mkdir(medium)
    await assert.rejects(h.run('task', { scopeId: scope.id, objective: 'Uncertain write', members: ['B'] }), /unknown|durab|write/i)
    const status = await h.run('status', { scopeId: scope.id })
    assert.equal(status.state, 'recovery-required'); assert.match(status.reason, /Last known snapshot/)
    await assert.rejects(h.run('task', { scopeId: scope.id, objective: 'No retry into failed storage', members: ['B'] }), /recovery/)
    assert.equal(h.submissions.length, 0)
    await rm(medium, { recursive: true }); await rename(saved, medium)
    await (await h.ready).close()
    const next = new Context(); new Storage(next)
    reopened = harness([], await openCollaborationStore(next, { directory }))
    const recovered = await reopened.run('status', { scopeId: scope.id })
    assert.equal(recovered.state, 'recovery-required'); assert.deepEqual(recovered.tasks, {})
  } finally { await (await h.ready).close(); if (reopened) await (await reopened.ready).close(); await rm(directory, { recursive: true, force: true }) }
})

test('registered material send persists native blocks and completion rejects changed source evidence', async () => {
  const { mkdtemp, rm, writeFile, readFile, realpath } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path'), { createHash } = await import('node:crypto')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-material-'))
  try {
    const path = join(directory, 'requirements.txt'); await writeFile(path, 'approved version\n')
    const files = new Map()
    const attachments = { async saveFileStream({ data, name }) { const chunks = []; for await (const chunk of data) chunks.push(chunk); const bytes = Buffer.concat(chunks), digest = createHash('sha256').update(bytes).digest('hex'), stored = join(directory, digest); await writeFile(stored, bytes); files.set('sha256:' + digest, stored); return { attachmentId: 'sha256:' + digest, name, bytes: bytes.length } }, async *readFileStream(ref) { yield await readFile(files.get(ref.attachmentId)) }, fileHostPath(ref) { return files.get(ref.attachmentId) } }
    const { materialFilesystem: fs } = await import('./fixtures/material-filesystem.mjs')
    const h = harness(), scope = await h.run('start', { objective: 'Deliver actual materials', members: ['B'] })
    h.agents.get('A').ctx = { get: name => name === 'fs' ? fs : undefined }; h.agents.get('B').ctx = { get: name => ({ fs, attachments })[name] }
    const task = await h.run('task', { scopeId: scope.id, objective: 'Use approved file', members: ['B'] })
    const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Read the attached requirement', intent: 'task', materials: [{ kind: 'file', path }] })
    assert.equal(op.wire.content[1].type, 'file'); assert.equal(op.artifacts.length, 1)
    const edited = await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'edit', operationId: op.id, message: 'Read the same attachment with this correction', reason: 'Correct pending instruction' })
    const pending = h.agents.get('B').inbox.nextTurn.find(message => message.id === op.id)
    assert.deepEqual(pending.content.slice(1), op.wire.content.slice(1))
    assert.deepEqual(edited.operations[op.id].wire, pending)
    assert.deepEqual(edited.operations[op.id].artifacts, op.artifacts)
    assert.match(pending.content[0].text, /this correction/)
    const imagePath = join(directory, 'diagram.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAmcAAAAASUVORK5CYII=', 'base64'))
    attachments.imageLimits = { maxImageBytes: 1024, maxMessageImageBytes: 2048, maxImagesPerMessage: 2 }
    attachments.saveImages = async ([image]) => [{ attachmentId: 'sha256:' + createHash('sha256').update(image.data).digest('hex'), bytes: image.data.length, width: 1, height: 1, mediaType: 'image/png', name: image.name }]
    attachments.readImage = async ref => ({ ref, data: await readFile(imagePath) })
    const image = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Review image', intent: 'task', materials: [{ kind: 'image', path: imagePath, mediaType: 'image/png' }] })
    const imageEdit = await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'edit', operationId: image.id, message: 'Review the same image carefully', reason: 'Clarify image instruction' })
    assert.equal(imageEdit.operations[image.id].wire.content[1].type, 'image')
    assert.deepEqual(imageEdit.operations[image.id].wire.content.slice(1), image.wire.content.slice(1))
    await h.admit(op.id)
    const result = await h.run('result', { scopeId: scope.id, taskId: task.id, taskRevision: 1, operationId: op.id, text: 'Delivered based on approved file' }, 'B')
    await writeFile(path, 'changed after result\n')
    await assert.rejects(h.run('control', { scopeId: scope.id, taskId: task.id, action: 'finish', reason: 'Must verify actual current artifact', resultIds: [result.id] }), /artifact version changed/)
    assert.equal((await h.run('status', { scopeId: scope.id })).tasks[task.id].state, 'active')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('elapsed budget is rechecked after async preparation and before native submission', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Bound async work', members: ['B'], budget: { maxElapsedMs: 1000 } })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Work', members: ['B'] })
  const native = h.delivery.deliverScoped
  h.delivery.deliverScoped = async (...args) => { const now = Date.now; Date.now = () => scope.createdAt + 1001; try { return await native(...args) } finally { Date.now = now } }
  await assert.rejects(h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Expired during preparation', intent: 'task' }), /elapsed time budget/)
  assert.equal(h.submissions.length, 0)
  assert.equal((await h.run('status', { scopeId: scope.id })).state, 'budget-exhausted')
})

test('native approval waits identify their live request and shared task execution and clear only its matching decision', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Wait accurately', members: ['B'] })
  const one = await h.run('task', { scopeId: scope.id, objective: 'One', members: ['B'] })
  const two = await h.run('task', { scopeId: scope.id, objective: 'Two', members: ['B'] })
  const first = await h.run('send', { scopeId: scope.id, taskId: one.id, taskRevision: 1, sessionId: 'B', message: 'One', intent: 'task' })
  const second = await h.run('send', { scopeId: scope.id, taskId: two.id, taskRevision: 1, sessionId: 'B', message: 'Two', intent: 'task' })
  await h.admit(first.id)
  const agent = h.agents.get('B')
  h.emit('agent/inbox/claimed', { agent, message: second.wire, turn: 1 })
  h.emit('session/event', agent.session, { type: 'user/message', data: second.wire })
  h.emit('session/event', agent.session, { type: 'approval/asked', data: { id: 'native-request', toolName: 'write_file', callId: 'tool-call', reason: 'Write reviewed changes' } })
  let status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[one.id].waitReason, 'approval')
  assert.equal(status.tasks[two.id].waitReason, 'approval')
  const wait = Object.values(status.nativeWaits)[0]
  assert.equal(wait.id, 'native-request'); assert.equal(wait.sessionId, 'B'); assert.equal(wait.callId, 'tool-call')
  assert.equal(wait.execution, status.executions.B); assert.equal(wait.shared, true)
  assert.deepEqual(wait.taskIds.sort(), [one.id, two.id].sort())
  h.emit('session/event', agent.session, { type: 'approval/decided', data: { id: 'unrelated', outcome: 'allowed-once' } })
  assert.equal((await h.run('status', { scopeId: scope.id })).tasks[one.id].waitReason, 'approval')
  h.emit('session/event', agent.session, { type: 'approval/decided', data: { id: 'native-request', outcome: 'allowed-once' } })
  status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[one.id].waitReason, 'collaborator')
  assert.equal(Object.values(status.nativeWaits)[0].state, 'decided')
  h.emit('session/event', agent.session, { type: 'approval/asked', data: { id: 'pending-at-exit', toolName: 'write_file', callId: 'later-call' } })
  await h.run('status', { scopeId: scope.id })
  const reopened = harness([...h.records.values()])
  const recovered = await reopened.run('status', { scopeId: scope.id })
  assert.equal(Object.values(recovered.nativeWaits).find(item => item.id === 'pending-at-exit').state, 'recovery-required')
  assert.notEqual(recovered.tasks[one.id].waitReason, 'approval')
  await h.run('control', { scopeId: scope.id, taskId: one.id, action: 'revise', objective: 'Revised one', reason: 'Old request does not belong to new revision' })
  status = await h.run('status', { scopeId: scope.id })
  assert.notEqual(status.tasks[one.id].waitReason, 'approval')
  assert.equal(status.tasks[two.id].waitReason, 'approval')
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
  h.emit('session/event', agent.session, { type: 'approval/decided', data: { id: 'pending-at-exit', outcome: 'allowed-once' } })
  status = await h.run('status', { scopeId: scope.id })
  assert.equal(Object.values(status.nativeWaits).find(item => item.id === 'pending-at-exit').state, 'recovery-required')
  assert.notEqual(status.tasks[two.id].waitReason, 'approval')
})

test('native exact-model validation rejects unsupported new-session overrides before approval or creation', async () => {
  const h = harness(), llm = new LlmRuntime(new Context())
  class PlainAdapter extends LlmAdapter { async resolveModel(provider, model) { return { provider, id: model, name: model } } }
  llm.registerAdapter(['fixture'], new PlainAdapter())
  const get = h.ctx.get.bind(h.ctx); h.ctx.get = name => name === 'llm' ? llm : get(name)
  await assert.rejects(h.run('start', { objective: 'Validate before creating', newSessions: [{ cwd: '/tmp/work', provider: 'fixture', model: 'plain', reasoningEffort: 'medium' }] }), /does not support reasoning effort/)
  assert.equal(h.approvals.length, 0); assert.equal(h.records.size, 0)
})

for (const code of ['UNSUPPORTED_REASONING_EFFORT', 'NEW_NATIVE_TERMINAL_ERROR'])
test(`claimed task ${code} turn-end failure is visible without model admission or agent/error`, async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Do not wait forever', members: ['B', 'C'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'B work', members: ['B'] })
  const other = await h.run('task', { scopeId: scope.id, objective: 'Unrelated C work', members: ['C'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  const agent = h.agents.get('B'), message = h.submissions.find(item => item.message.id === op.id).message
  agent.status = 'running'; agent.inbox.remove(op.id)
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  h.emit('agent/inbox/claimed', { agent, message, turn: 1 })
  await h.run('status', { scopeId: scope.id })
  const before = h.submissions.length
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code, message: 'Native preparation failed before admission' } } } }); agent.status = 'idle'
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[task.id].state, 'recovery-required')
  assert.equal(status.tasks[task.id].attention.code, code)
  assert.equal(status.tasks[task.id].attention.execution, status.operations[op.id].execution)
  assert.equal(status.tasks[other.id].state, 'active')
  assert.equal(h.submissions.length, before + 1)
  const wait = await h.run('wait', { scopeId: scope.id, mode: 'all', timeoutMs: 0 })
  assert.equal(wait.needsAttention, true); assert.equal(wait.done, false)
})

test('recoverable tool results and stale turn-end errors do not fail or erase the current execution', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Current work', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Current task', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' })
  await h.admit(op.id, 2); const agent = h.agents.get('B')
  h.emit('session/event', agent.session, { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'recoverable-call', isError: true, content: [{ type: 'text', text: 'Correct the argument and continue' }] } } })
  h.emit('session/event', agent.session, { type: 'step/end', data: { turn: 2, step: 1 } })
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'OLD_ERROR', message: 'Older execution stopped' } } } })
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[task.id].state, 'active'); assert.equal(status.tasks[task.id].attention, undefined)
  assert.match(status.executions.B, /:2$/)
})

test('queued claim observation retains the execution observed before a later turn starts', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Keep exact input execution', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'One operation', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Only this input', intent: 'task' })
  const agent = h.agents.get('B'), message = h.submissions.find(item => item.message.id === op.id).message
  agent.inbox.remove(op.id)
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  h.emit('agent/inbox/claimed', { agent, message, turn: 1 })
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'Turn one failed' } } } })
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.operations[op.id].turn, 1)
  assert.match(status.operations[op.id].execution, /:1$/)
  assert.match(status.executions.B, /:2$/)
})

for (const sameTask of [false, true])
test(`queued native failure preserves its cause while turn two starts ${sameTask ? 'new work for the same task' : 'an unrelated task'}`, async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Independent failures remain visible', members: ['B'] })
  const first = await h.run('task', { scopeId: scope.id, objective: 'First task', members: ['B'] })
  const second = sameTask ? first : await h.run('task', { scopeId: scope.id, objective: 'Unrelated task', members: ['B'] })
  const send = task => h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work for ' + task.id, intent: 'task' })
  const one = await send(first), two = await send(second), agent = h.agents.get('B'), before = h.submissions.length
  const message = id => h.submissions.find(item => item.message.id === id).message
  agent.inbox.remove(one.id)
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  h.emit('agent/inbox/claimed', { agent, message: message(one.id), turn: 1 })
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'NETWORK', message: 'First execution failed' } } } })
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
  agent.inbox.remove(two.id)
  h.emit('agent/inbox/claimed', { agent, message: message(two.id), turn: 2 })
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.match(status.operations[one.id].error, /NETWORK/)
  assert.match(status.operations[one.id].execution, /:1$/); assert.match(status.operations[two.id].execution, /:2$/)
  assert.equal(status.tasks[first.id].state, sameTask ? 'active' : 'recovery-required')
  if (sameTask) assert.equal(status.tasks[first.id].attention, undefined)
  else assert.equal(status.tasks[first.id].attention.code, 'NETWORK')
  assert.equal(status.tasks[second.id].state, 'active'); assert.equal(status.tasks[second.id].attention, undefined)
  assert.equal(h.submissions.length, before + (sameTask ? 0 : 1))
  const wait = await h.run('wait', { scopeId: scope.id, taskIds: [first.id], timeoutMs: 0 })
  assert.equal(wait.needsAttention, !sameTask)
})

test('terminal errors for a claimed older task revision do not block its revised objective', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Revised work', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Old version', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Old work', intent: 'task' })
  const agent = h.agents.get('B'), message = h.submissions.find(item => item.message.id === op.id).message
  agent.inbox.remove(op.id); agent.status = 'running'
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  h.emit('agent/inbox/claimed', { agent, message, turn: 1 })
  await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'revise', objective: 'New version', reason: 'User changed this objective' })
  const before = h.submissions.length
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'Old configuration failed' } } } })
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[task.id].revision, 2); assert.equal(status.tasks[task.id].state, 'active'); assert.equal(status.tasks[task.id].attention, undefined)
  assert.equal(h.submissions.length, before)
})

for (const code of ['NETWORK', 'CONTEXT_WINDOW_EXCEEDED', 'ACCOUNT_QUOTA', 'QUOTA', 'RATE_LIMIT'])
test(`fatal native ${code} preserves exact failure, notifies the owner once and releases attention waits`, async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Complete independent tasks', members: ['B', 'C'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'B work', members: ['B'] })
  const other = await h.run('task', { scopeId: scope.id, objective: 'C work', members: ['C'] })
  const args = { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Apply once', intent: 'task' }
  const op = await h.run('send', args); await h.admit(op.id)
  const agent = h.agents.get('B'), before = h.submissions.length
  const failure = { agent, turn: 1, step: 1, error: { code, message: 'Native worker stopped' } }
  h.emit('agent/error', failure); h.emit('agent/error', failure)
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure.error } } }); agent.status = 'idle'
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.state, ['ACCOUNT_QUOTA', 'QUOTA', 'RATE_LIMIT'].includes(code) ? 'usage-limited' : 'active')
  assert.equal(status.tasks[task.id].state, 'recovery-required')
  assert.equal(status.tasks[task.id].waitReason, ['ACCOUNT_QUOTA', 'QUOTA', 'RATE_LIMIT'].includes(code) ? 'account-limit' : 'execution-error')
  assert.equal(status.tasks[task.id].attention.code, code)
  assert.equal(status.tasks[task.id].attention.execution, status.operations[op.id].execution)
  assert.match(status.operations[op.id].error, new RegExp(code))
  assert.equal(status.tasks[other.id].state, 'active'); assert.equal(status.tasks[other.id].attention, undefined)
  assert.equal(h.submissions.length, before + 1); assert.equal(h.submissions.at(-1).targetId, 'A')
  const any = await h.run('wait', { scopeId: scope.id, mode: 'any', timeoutMs: 1000 })
  assert.equal(any.done, true); assert.equal(any.needsAttention, true); assert.equal(any.timedOut, false)
  const all = await h.run('wait', { scopeId: scope.id, mode: 'all', timeoutMs: 1000 })
  assert.equal(all.done, false); assert.equal(all.needsAttention, true); assert.equal(all.timedOut, false)
  assert.deepEqual(all.attention.map(item => item.taskId), [task.id])
  assert.deepEqual((await h.run('send', { ...args, operationId: op.id })).id, op.id)
  assert.equal(h.submissions.length, before + 1, 'no worker side effect is replayed')
})

test('disposing the exact instance with an unresolved admitted task after turn end requires attention without replay', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Preserve unresolved work', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Side effect may have happened', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Apply once', intent: 'task' }); await h.admit(op.id)
  const agent = h.agents.get('B'), before = h.submissions.length
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } }); agent.status = 'idle'
  h.agents.delete('B'); h.emit('agent/disposed', { agent }); h.emit('agent/disposed', { agent })
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[task.id].attention.code, 'TARGET_DISPOSED')
  assert.equal(status.tasks[task.id].state, 'recovery-required')
  assert.match(status.operations[op.id].error, /disposed/i)
  assert.equal(h.submissions.length, before + 1)
  const wait = await h.run('wait', { scopeId: scope.id, mode: 'all', timeoutMs: 1000 })
  assert.equal(wait.done, true); assert.equal(wait.needsAttention, true)
})

for (const code of ['NETWORK', 'ACCOUNT_QUOTA'])
for (const boundary of ['task-pause', 'scope-pause', 'task-cancel'])
test(`fatal worker ${code} failure retains its cause without waking a ${boundary} collaboration`, async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Respect revoked scheduling', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Stopped work', members: ['B'] })
  const op = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' }); await h.admit(op.id)
  await h.run('control', { scopeId: scope.id, ...(boundary === 'scope-pause' ? {} : { taskId: task.id }), action: boundary.endsWith('cancel') ? 'cancel' : 'pause', reason: 'User revoked scheduling' })
  const before = h.submissions.length
  h.emit('agent/error', { agent: h.agents.get('B'), turn: 1, error: { code, message: 'Provider stopped' } })
  await h.clock.flush()
  const status = await h.run('status', { scopeId: scope.id })
  assert.match(status.operations[op.id].error, new RegExp(code))
  assert.equal(status.tasks[task.id].attention.code, code)
  assert.equal(h.submissions.length, before)
  if (boundary !== 'scope-pause') assert.equal(status.tasks[task.id].state, boundary.endsWith('cancel') ? 'cancelled' : 'paused')
})

test('old revision, old turn and replaced-instance failures never stop current task work', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Exact execution ownership', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Old objective', members: ['B'] })
  const args = { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' }
  const op = await h.run('send', args); await h.admit(op.id)
  const old = h.agents.get('B')
  await h.run('control', { scopeId: scope.id, taskId: task.id, action: 'revise', objective: 'Current objective', reason: 'Use new target' })
  const before = h.submissions.length
  h.emit('agent/error', { agent: old, turn: 1, error: { code: 'NETWORK', message: 'Old revision stopped' } })
  await h.clock.flush()
  let status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[task.id].state, 'active'); assert.equal(status.tasks[task.id].attention, undefined)
  const current = await h.run('send', { ...args, taskRevision: 2 }); await h.admit(current.id, 2)
  h.emit('agent/error', { agent: old, turn: 1, error: { code: 'NETWORK', message: 'Old turn stopped' } })
  const replacement = { ...old, session: { ...old.session } }; h.agents.set('B', replacement)
  h.emit('agent/error', { agent: old, turn: 2, error: { code: 'NETWORK', message: 'Old instance stopped' } }); h.emit('agent/disposed', { agent: old })
  await h.clock.flush()
  status = await h.run('status', { scopeId: scope.id })
  assert.equal(status.tasks[task.id].state, 'active'); assert.equal(status.tasks[task.id].attention, undefined)
  assert.equal(status.operations[current.id].error, undefined); assert.equal(h.submissions.length, before + 1)
})

test('model receipts omit duplicate wire and control history while status retains full evidence', async (t) => {
  const h = harness(), scope = await h.run('start', { objective: 'Compact model receipts', members: ['B', 'C'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Verify large work', members: ['B'] })
  const unrelated = await h.run('task', { scopeId: scope.id, objective: 'Unrelated review', members: ['C'] })
  const message = 'actual work\n'.repeat(2000) + 'complete final line'
  const sent = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message, intent: 'task' })
  const beforeSend = structuredClone(sent)
  const sendText = h.tools.get('session_coordinator_collaboration_send').output.render({}, sent)[0].text
  const sendReceipt = JSON.parse(sendText)
  assert.equal(sendReceipt.id, sent.id)
  assert.equal(sendReceipt.text, message, 'do not truncate the one actual work body')
  assert.equal(sendReceipt.status, sent.status)
  assert.equal(sendReceipt.wire, undefined, 'the native wire repeats the same work and context')
  assert.deepEqual(sent, beforeSend, 'rendering must not alter the actual operation')
  await h.admit(sent.id)
  const result = await h.run('result', { scopeId: scope.id, taskId: task.id, taskRevision: 1, operationId: sent.id, text: 'Result body\n'.repeat(2000), evidence: ['full verification evidence'] }, 'B')
  const args = { scopeId: scope.id, taskId: task.id, action: 'finish', reason: 'Verified the result', resultIds: [result.id] }
  const controlled = await h.run('control', args), beforeControl = structuredClone(controlled)
  const controlText = h.tools.get('session_coordinator_collaboration_control').output.render(args, controlled)[0].text
  const receipt = JSON.parse(controlText)
  assert.equal(receipt.id, scope.id); assert.equal(receipt.state, 'active')
  assert.equal(receipt.tasks[task.id].state, 'completed')
  assert.deepEqual(receipt.tasks[task.id].acceptedResultIds, [result.id])
  assert.equal(receipt.tasks[unrelated.id], undefined, 'a task receipt identifies its selected scope')
  assert.equal(receipt.operations[sent.id].status, 'admitted')
  assert.equal(receipt.operations[sent.id].wire, undefined)
  assert.equal(receipt.operations[sent.id].text, undefined)
  assert.equal(receipt.results, undefined)
  assert.ok(controlText.length < JSON.stringify(controlled).length / 10, 'large work/evidence must not be replayed with every control')
  assert.deepEqual(controlled, beforeControl)
  const status = await h.run('status', { scopeId: scope.id })
  const full = JSON.parse(h.tools.get('session_coordinator_collaboration_status').output.render({}, status)[0].text)
  assert.equal(full.operations[sent.id].text, message)
  assert.deepEqual(full.operations[sent.id].wire, sent.wire)
  assert.equal(full.results[result.id].text, result.text)
  assert.deepEqual(full.results[result.id].evidence, result.evidence)
  t.diagnostic(JSON.stringify({ bytes: { send: { full: Buffer.byteLength(JSON.stringify(sent)), rendered: Buffer.byteLength(sendText) }, control: { full: Buffer.byteLength(JSON.stringify(controlled)), rendered: Buffer.byteLength(controlText) } }, fullEvidenceRetained: true }))
})

test('model control receipts retain native failure attention and question answers', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Keep actionable facts', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Fail visibly', members: ['B'] })
  await (await h.ready).withTask(scope.id, task.id, { agent: h.agents.get('A'), signal: new AbortController().signal }, current => {
    current.materialOperations = { 'material-unknown': { request: { action: 'snapshot', constraints: ['do not replay this long request body'.repeat(200)] }, status: 'unknown', error: 'Snapshot acceptance needs reconciliation' } }
  })
  const sent = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Work', intent: 'task' }); await h.admit(sent.id)
  h.emit('agent/error', { agent: h.agents.get('B'), turn: 1, error: { code: 'NETWORK', message: 'Transport stopped; repair connection' } }); await h.clock.flush()
  const args = { scopeId: scope.id, taskId: task.id, action: 'fail', reason: 'Native transport requires repair' }
  const failed = await h.run('control', args)
  const failure = JSON.parse(h.tools.get('session_coordinator_collaboration_control').output.render(args, failed)[0].text)
  assert.equal(failure.tasks[task.id].state, 'failed')
  assert.equal(failure.tasks[task.id].attention.code, 'NETWORK')
  assert.deepEqual(failure.tasks[task.id].materialOperations['material-unknown'], { status: 'unknown', error: 'Snapshot acceptance needs reconciliation' })
  assert.match(failure.operations[sent.id].error, /Transport stopped; repair connection/)
  const questionHarness = harness(), questionScope = await questionHarness.run('start', { objective: 'Resolve a choice', members: ['B'] })
  const questionTask = await questionHarness.run('task', { scopeId: questionScope.id, objective: 'Choose', members: ['B'] })
  const originalGet = questionHarness.ctx.get
  questionHarness.ctx.get = name => name === 'userQuestions' ? { async ask() { return { answers: [{ selected: ['Small'], custom: 'Keep the exact answer' }] } } } : originalGet(name)
  const askArgs = { scopeId: questionScope.id, taskId: questionTask.id, action: 'question', reason: 'Need a choice', question: 'Which size?', options: ['Small', 'Large'] }
  const pending = await questionHarness.run('control', askArgs, 'B'), question = Object.values(pending.questions)[0]
  const pendingReceipt = JSON.parse(questionHarness.tools.get('session_coordinator_collaboration_control').output.render(askArgs, pending)[0].text)
  assert.deepEqual(pendingReceipt.questions[question.id], question)
  const answerArgs = { scopeId: questionScope.id, taskId: questionTask.id, action: 'question', reason: 'Answer the routed choice', questionId: question.id }
  const answered = await questionHarness.run('control', answerArgs)
  const answerReceipt = JSON.parse(questionHarness.tools.get('session_coordinator_collaboration_control').output.render(answerArgs, answered)[0].text)
  assert.equal(answerReceipt.questions[question.id].state, 'answered')
  assert.deepEqual(answerReceipt.questions[question.id].answer, answered.questions[question.id].answer)
  assert.equal(answerReceipt.tasks[questionTask.id].state, 'active')
})

test('model control receipts keep queue mutation outcomes without replaying before and after messages', async () => {
  const h = harness(), scope = await h.run('start', { objective: 'Queue changes', members: ['B'] })
  const task = await h.run('task', { scopeId: scope.id, objective: 'Queued work', members: ['B'] })
  const sent = await h.run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: 'B', message: 'Original', intent: 'task' })
  const args = { scopeId: scope.id, taskId: task.id, action: 'edit', operationId: sent.id, message: 'Corrected', reason: 'Correct pending work' }
  const edited = await h.run('control', args), mutation = Object.values(edited.mutations)[0]
  const receipt = JSON.parse(h.tools.get('session_coordinator_collaboration_control').output.render(args, edited)[0].text)
  assert.equal(receipt.mutations[mutation.id].status, 'applied')
  assert.equal(receipt.mutations[mutation.id].operationId, sent.id)
  assert.equal(receipt.mutations[mutation.id].before, undefined)
  assert.equal(receipt.mutations[mutation.id].after, undefined)
  assert.ok(edited.mutations[mutation.id].before)
  assert.ok(edited.mutations[mutation.id].after)
  await h.admit(sent.id)
  const withdrawArgs = { scopeId: scope.id, taskId: task.id, action: 'withdraw', operationId: sent.id, reason: 'Already consumed input cannot be removed' }
  const withdrew = await h.run('control', withdrawArgs)
  const withdrawal = JSON.parse(h.tools.get('session_coordinator_collaboration_control').output.render(withdrawArgs, withdrew)[0].text)
  assert.equal(withdrawal.operations[sent.id].status, 'admitted')
  assert.equal(Object.values(withdrawal.mutations).find(item => item.kind === 'withdraw').status, 'not-pending')
})
