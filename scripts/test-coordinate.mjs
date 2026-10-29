#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionDelivery } from '../src/delivery.ts'
import { sessionEvents, sourceIdentityMessage } from '../src/core.ts'
import { createGrants, requireCoordination, runCoordinateCommand } from '../src/coordinate.ts'
import { registerBridgeTools } from '../src/tools.ts'

let passed = 0
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }

function harness() {
  const tools = new Map(), effects = [], agents = new Map(), listeners = new Map(), disposers = []
  const human = id => ({ seq: 1, time: 1, type: 'user/message', data: { id: 'human-' + id, source: { kind: 'user' }, content: [{ type: 'text', text: 'test' }] } })
  for (const id of ['A', 'B', 'C']) {
    const events = [human(id)], pending = [], nextTurn = []
    agents.set(id, { id, status: 'idle', session: { header: {}, events, append(type, data, intent) { const event = { seq: events.length + 1, time: Date.now(), type, data, ...intent }; events.push(event); for (const fn of listeners.get('session/event') ?? []) fn(this, event); return event } },
      inbox: { nextStep: pending, nextTurn, remove(messageId) { for (const list of [pending, nextTurn]) { const index = list.findIndex(message => message.id === messageId); if (index >= 0) { list.splice(index, 1); return true } } return false } },
      send(message, target, wakeup) { assert.equal(wakeup, false); const list = target === 'next-turn' ? nextTurn : pending; effects.push([target, id]); list.push(message); this.session.append('agent/inbox/spliced', { target, start: list.length - 1, inserted: [message] }) },
      inject(message) { effects.push(['inject', id]); pending.push(message); this.session.append('agent/inbox/spliced', { target: 'next-step', start: pending.length - 1, inserted: [message] }) },
      whenIdle() { return Promise.resolve() },
      runMaintenance(job) { if (this.status !== 'idle') throw new Error('active work'); return Promise.resolve(job(new AbortController().signal)) },
      steer(message) { effects.push(['steer', id]); events.push({ seq: events.length + 1, time: Date.now(), type: 'user/message', data: message }) },
      followup(message) { effects.push(['queue', id]); events.push({ seq: events.length + 1, time: Date.now(), type: 'user/message', data: message }) },
      cancel() { effects.push(['cancel', id]) },
    })
  }
  const ctx = { effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose }, on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); const dispose = () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1) }; disposers.push(dispose); return dispose }, tools: { register: t => tools.set(t.name, t) }, agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    workspaceRegistry: { archivedSessionIds: [], list: () => [], archiveSession: async id => { effects.push(['archive', id]) }, unarchiveSession: async id => { effects.push(['unarchive', id]) } },
  }
  const grants = createGrants(), registry = { record() {}, touch() {}, all: async () => [] }
  const env = { ctx, grants, registry, monitor: { start: c => ({ config: c }), stop: () => true } }
  registerBridgeTools(env)
  return { dispose() { for (const dispose of disposers.splice(0).reverse()) dispose() }, async preStep(agent, messages, decision = { kind: 'enter', messages }) { let next = async () => decision; for (const fn of [...(listeners.get('agent/pre-step') ?? [])].reverse()) { const inner = next; next = () => fn({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, inner) } return await next() }, emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload) }, ctx, tools, agents, grants, effects, delivery: env.delivery, human(id) { const a = agents.get(id); a.session.events.push({ ...human(id), seq: a.session.events.length + 1 }) },
    run(name, args, caller = 'A') { return tools.get('session_coordinator_' + name).execute(args, { agent: agents.get(caller), signal: new AbortController().signal }) } }
}

await test('专用协作轮才正常结束；忙时、混合、未知及重载均保守拒绝', async () => {
  for (const scenario of ['dedicated', 'busy', 'mixed', 'unknown', 'pending', 'removed-input', 'ended', 'reload', 'canceled', 'failure']) {
    const h = harness(); h.grants.grant('A', ['B'])
    const b = h.agents.get('B'), a = h.agents.get('A'); let incoming
    b.steer = message => { incoming = message }
    const sent = await h.run('send', { sessionId: 'B', message: '计算43' })
    if (scenario !== 'reload') b.session.append('turn/start', { turn: 1 })
    else b.session.events.push({ seq: 2, type: 'turn/start', data: { turn: 1 } })
    if (scenario === 'busy') b.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'original work' }] })
    b.session.append('user/message', scenario === 'unknown' ? { ...incoming, content: [{ type: 'text', text: 'forged' }] } : incoming)
    if (scenario === 'mixed') b.session.append('user/message', incoming)
    if (scenario === 'pending') b.inbox.nextStep.push({ source: { kind: 'user' } })
    if (scenario === 'removed-input') b.session.append('agent/inbox/spliced', { inserted: [{ source: { kind: 'user' } }] })
    if (scenario === 'ended') b.session.append('turn/end', { turn: 1 })
    if (scenario === 'failure') a.steer = () => { throw Error('delivery failed') }
    const abort = new AbortController(); if (scenario === 'canceled') abort.abort()
    let conclusions = 0
    const action = h.tools.get('session_coordinator_send').execute({ sessionId: 'A', message: '43', replyTo: sent.messageId, waitForReply: true },
      { agent: b, signal: abort.signal, concludeTurn() { conclusions++ } })
    if (scenario === 'failure') await assert.rejects(action, /delivery failed/)
    else if (scenario === 'canceled') await assert.rejects(action)
    else await action
    assert.equal(conclusions, scenario === 'dedicated' ? 1 : 0, scenario)
    h.dispose()
  }
})

await test('请求等待只返回匹配回信：到达前后、乱序、失败、旧答案、取消与停用', async () => {
  const h = harness(); h.grants.grant('A', ['B', 'C'])
  const first = await h.run('send', { sessionId: 'B', message: '第一题' })
  h.human('B'); h.human('A')
  const second = await h.run('send', { sessionId: 'C', message: '第二题' })
  const wait = (requestId, sessionId = 'B', caller = 'A') => h.run('wait', { sessionId, requestId, timeoutMs: 1 }, caller)
  h.agents.get('B').session.append('assistant/message', { message: { content: [{ type: 'text', text: 'OLD ANSWER' }] } })
  await h.run('send', { sessionId: 'A', message: '第二题结果', replyTo: second.messageId }, 'C')
  assert.equal((await wait(first.messageId)).reply.message, null)
  assert.equal((await wait(first.messageId)).reply.timedOut, true)
  await assert.rejects(wait(first.messageId, 'C'), /owned/)
  await assert.rejects(wait(first.messageId, 'B', 'C'), /owned/)
  await assert.rejects(wait('unknown'), /owned/)
  await assert.rejects(h.run('wait', { sessionId: 'B', requestId: first.messageId, sinceSeq: 0 }), /combined/)
  const pending = h.delivery.waitForRequest('A', 'B', first.messageId, 1000, new AbortController().signal)
  const a = h.agents.get('A'), steer = a.steer
  a.steer = () => { throw Error('delivery rejected') }
  await assert.rejects(h.run('send', { sessionId: 'A', message: 'wrong', replyTo: first.messageId }, 'B'), /rejected/)
  assert.equal((await wait(first.messageId)).reply.received, false)
  a.steer = steer
  await h.run('send', { sessionId: 'A', message: '业务限制：缺数据', replyTo: first.messageId }, 'B')
  assert.equal((await pending).message.text, '业务限制：缺数据')
  h.agents.delete('B')
  const result = (await wait(first.messageId)).reply
  assert.equal(result.message.text, '业务限制：缺数据')
  assert.equal(result.kind, 'request-reply'); assert.equal(result.timedOut, false)
  assert.equal('turnEnded' in result, false); assert.equal('stale' in result, false)
  h.human('A')
  const third = await h.run('send', { sessionId: 'C', message: '第三题' })
  const abort = new AbortController()
  const canceled = h.delivery.waitForRequest('A', 'C', third.messageId, 1000, abort.signal)
  abort.abort(); assert.equal((await canceled).aborted, true)
  const disabled = h.delivery.waitForRequest('A', 'C', third.messageId, 1000, new AbortController().signal)
  h.dispose(); assert.equal((await disabled).aborted, true)
})

await test('send同步等待关联回信，不依赖A或B再生成助手文本', async () => {
  for (const replyHandling of ['continue', 'receive-only']) {
    const h = harness(); h.grants.grant('A', ['B']); const b = h.agents.get('B')
    let delivered
    b.steer = message => { delivered = message }
    const pending = h.run('send', { sessionId: 'B', message: '任务', replyHandling, waitForReply: true, timeoutMs: 1000 })
    await Promise.resolve()
    await h.run('send', { sessionId: 'A', message: '43', replyTo: delivered.id }, 'B')
    const result = await pending
    assert.equal(result.reply.message.text, '43'); assert.equal(result.reply.timedOut, false)
    h.dispose()
  }
})

await test('仅收信保留上下文但不唤醒空闲来源；处理意图由原请求决定', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
  const reply = await h.run('send', { sessionId: 'A', message: '结果43', replyTo: sent.messageId }, 'B')
  assert.equal(reply.replyHandling, 'receive-only')
  assert.equal(h.effects.some(([kind, id]) => id === 'A' && ['steer', 'queue'].includes(kind)), false)
  const received = h.agents.get('A').session.events.filter(event => event.type === 'user/message' && event.data.source?.replyTo === sent.messageId)
  assert.equal(received.length, 1)
  assert.equal(received[0].data.content[0].text.endsWith('结果43'), true)
  assert.equal(h.agents.get('A').inbox.nextStep.length, 0)
  assert.equal(h.agents.get('A').status, 'idle')
})

await test('仅收信在忙时入箱；取消或拒步后闲态保留一次，已消费不重复', async () => {
  for (const ending of ['canceled', 'rejected', 'consumed', 'disposed']) {
    const h = harness(); h.grants.grant('A', ['B']); const a = h.agents.get('A'); a.status = 'running'
    const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
    const reply = await h.run('send', { sessionId: 'A', message: '结果43', replyTo: sent.messageId }, 'B')
    assert.equal(h.effects.some(([kind, id]) => id === 'A' && ['steer', 'queue'].includes(kind)), false)
    assert.equal(a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId).length, 0, '不能在运行中的工具结果之前写模型历史')
    const [message] = a.inbox.nextStep.splice(0)
    if (ending === 'consumed') a.session.append('user/message', message, { surfaceOp: 'append' })
    a.status = 'idle'; h.emit(ending === 'disposed' ? 'agent/disposed' : 'agent/status', { agent: a, status: 'idle' })
    await Promise.resolve()
    const received = a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId)
    assert.equal(received.length, 1, ending)
    assert.equal(received[0].data.content[0].text.endsWith('结果43'), true)
    assert.equal(a.inbox.nextStep.length, 0)
    h.emit('agent/status', { agent: a, status: 'idle' }); await Promise.resolve()
    assert.equal(a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId).length, 1)
  }
})

await test('回信处理意图校验、请求去重及接收方覆盖均受宿主约束', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  await assert.rejects(h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'surprise' }), /replyHandling/)
  assert.equal(h.effects.length, 0)
  const raw = { requestId: 'receive-only-request', sessionId: 'B', message: '任务', mode: 'steer', replyHandling: 'receive-only' }
  assert.equal((await h.delivery.fromCommand('A', JSON.stringify(raw))).kind, 'success')
  assert.equal((await h.delivery.fromCommand('A', JSON.stringify({ ...raw, replyHandling: 'continue' }))).kind, 'error')
  await assert.rejects(h.run('send', { sessionId: 'A', message: '完成', replyTo: raw.requestId, replyHandling: 'continue' }, 'B'), /original request/)
  assert.equal(h.effects.length, 1)
  const reply = await h.run('send', { sessionId: 'A', message: '完成', replyTo: raw.requestId }, 'B')
  assert.equal(reply.replyHandling, 'receive-only')
})

await test('仅收信闲态写入失败可重试，不消耗一次回信权', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
  const session = h.agents.get('A').session, append = session.append
  session.append = () => { throw new Error('write rejected') }
  await assert.rejects(h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B'), /write rejected/)
  session.append = append
  await h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B')
  assert.equal(session.events.filter(e => e.data.source?.replyTo === sent.messageId).length, 1)
})

await test('仅收信显式queue不变成next-step，恢复记录也不唤醒或恢复授权', async () => {
  const h = harness(); h.grants.grant('A', ['B']); const a = h.agents.get('A'); a.status = 'running'
  const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
  const reply = await h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId, mode: 'queue' }, 'B')
  assert.equal(a.inbox.nextStep.length, 0)
  assert.equal(a.inbox.nextTurn[0].id, reply.messageId)
  a.inbox.nextTurn.splice(0); a.status = 'idle'
  const freshGrants = createGrants()
  const restored = new SessionDelivery(h.ctx, { touch() {} }, freshGrants)
  await Promise.resolve()
  assert.equal(a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId).length, 1)
  assert.equal(a.inbox.nextTurn.length, 0)
  assert.equal(h.effects.some(([kind, id]) => id === 'A' && ['steer', 'queue'].includes(kind)), false)
  assert.equal(freshGrants.isGranted('A', 'B'), false)
  await assert.rejects(restored.send({ sessionId: 'A', message: '再回', replyTo: sent.messageId }, h.agents.get('B')), /active incoming/)
})

await test('真实Session写入、derive与重建保留仅收信内容，未生成模型轮次', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  const a = h.agents.get('A')
  a.session = Session.create('A', [], { version: 4, id: 'A', createdAt: 1, isSeeded: false }, 0)
  const sent = await h.run('send', { sessionId: 'B', message: '计算14+29', replyHandling: 'receive-only' })
  const reply = await h.run('send', { sessionId: 'A', message: '43', replyTo: sent.messageId }, 'B')
  const rows = sessionEvents(a.session)
  assert.equal(rows.some(e => e.type === 'turn/start' || e.type === 'request/header'), false)
  const restored = Session.create('A', structuredClone(rows), structuredClone(a.session.header), 0)
  const messages = restored.deriveMessages()
  assert.equal(messages.filter(message => message.id === reply.messageId).length, 1)
  assert.equal(messages.find(message => message.id === reply.messageId).content[0].text.endsWith('43'), true)
})

await test('maintenance中仅收信被取消，settlement不唤醒且下一请求可读', async () => {
  const h = harness(); h.grants.grant('A', ['B']); const a = h.agents.get('A')
  const maintenance = Promise.withResolvers(); let busy = true
  a.runMaintenance = job => { if (busy) throw new Error('active maintenance'); return Promise.resolve(job(new AbortController().signal)) }
  a.whenIdle = () => maintenance.promise
  const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
  const reply = await h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B')
  a.inbox.nextStep.splice(0) // Host cancel clears context; maintenance stays publicly idle.
  busy = false; maintenance.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId).length, 1)
  assert.equal(h.effects.some(([kind, id]) => id === 'A' && ['steer', 'queue'].includes(kind)), false)
})

await test('维护退出立即开始新人工任务时，在安全pre-step补回已取消上下文且不抢queue', async () => {
  const h = harness(); h.grants.grant('A', ['B']); const a = h.agents.get('A')
  const maintenance = Promise.withResolvers(); let busy = true
  a.runMaintenance = job => { if (busy) throw new Error('active maintenance'); return Promise.resolve(job(new AbortController().signal)) }
  a.whenIdle = () => maintenance.promise
  const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
  const reply = await h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B')
  const [received] = a.inbox.nextStep.splice(0)
  a.status = 'running' // A queued human prompt starts before whenIdle can observe idle.
  const human = { id: 'next-human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '结合收到的结果继续' }] }
  const decision = await h.preStep(a, [human])
  assert.deepEqual(decision.messages.map(message => message.id), [reply.messageId, human.id])
  assert.equal(a.session.events.some(e => e.type === 'user/message' && e.data.id === reply.messageId), false, '由宿主安全step写入，不直接写运行中的历史')
  for (const message of decision.messages) a.session.append('user/message', message, { surfaceOp: 'append' })
  assert.deepEqual((await h.preStep(a, [human])).messages.map(message => message.id), [human.id], '已有历史不重复补入')
  const rejected = { kind: 'reject' }
  assert.equal(await h.preStep(a, [received], rejected), rejected, '其它插件拒步不绕过')
  busy = false; a.status = 'idle'; maintenance.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId).length, 1)
  assert.equal(h.effects.some(([kind, id]) => id === 'A' && ['steer', 'queue'].includes(kind)), false)

  const queued = harness(); queued.grants.grant('A', ['B']); const qa = queued.agents.get('A'); qa.status = 'running'
  const task = await queued.run('send', { sessionId: 'B', message: '排队任务', replyHandling: 'receive-only' })
  await queued.run('send', { sessionId: 'A', message: '排队结果', replyTo: task.messageId, mode: 'queue' }, 'B')
  assert.deepEqual((await queued.preStep(qa, [human])).messages.map(message => message.id), [human.id], '仍在next-turn中不能提前带入当前step')
  assert.equal(qa.inbox.nextTurn.length, 1)
})

await test('恢复未知或残缺仅收信记录安全降级，不崩溃或误装上下文', async () => {
  const valid = sourceIdentityMessage('43', { senderSessionId: 'B', messageId: 'receipt-restore', replyTo: 'request-restore',
    rootMessageId: 'request-restore', hopCount: 2, replyHandling: 'receive-only' }, '计算14+29', 'human-command')
  for (const mutate of [
    message => { message.content[0].text = null },
    message => { delete message.content[0].text },
    message => { message.content = null },
    message => { message.content = [null] },
    message => { message.source = null },
    message => { message.source.senderSessionId = 'X' },
    message => { message.source.replyTo = 'other' },
    message => { message.content[0].text = message.content[0].text.replace('"version":5', '"version":999') },
    message => { message.content[0].text = message.content[0].text.replace('"replyTo":"request-restore"', '"replyTo":"other"') },
  ]) {
    const h = harness(), a = h.agents.get('A'), message = structuredClone(valid)
    mutate(message)
    a.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
    const before = JSON.stringify(a.session.events)
    assert.doesNotThrow(() => new SessionDelivery(h.ctx, { touch() {} }, createGrants()))
    await Promise.resolve()
    assert.equal(JSON.stringify(a.session.events), before, '未知/残缺输入只保留原始记录')
  }
})

await test('停用移除监听与settlement写入；重新启用恢复已接受结果但不恢复权限', async () => {
  const h = harness(); h.grants.grant('A', ['B']); const a = h.agents.get('A')
  const maintenance = Promise.withResolvers(); let busy = true
  a.runMaintenance = job => { if (busy) throw new Error('active maintenance'); return Promise.resolve(job(new AbortController().signal)) }
  a.whenIdle = () => maintenance.promise
  const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
  const reply = await h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B')
  h.dispose(); a.inbox.nextStep.splice(0); busy = false; maintenance.resolve()
  h.emit('agent/status', { agent: a, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.session.events.some(e => e.type === 'user/message' && e.data.id === reply.messageId), false, '停用后不能残留写入回调')
  assert.ok(a.session.events.some(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(message => message.id === reply.messageId)), '原始入箱日志保留')
  const grants = createGrants(); new SessionDelivery(h.ctx, { touch() {} }, grants)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId).length, 1)
  assert.equal(grants.isGranted('A', 'B'), false)
  assert.equal(h.effects.some(([kind, id]) => id === 'A' && ['steer', 'queue'].includes(kind)), false)
})

await test('安全落历史失败恢复原队列，下一安全边界重试不丢失或重复', async () => {
  const h = harness(); h.grants.grant('A', ['B']); const a = h.agents.get('A'); a.status = 'running'
  const settled = Promise.withResolvers(); a.whenIdle = () => settled.promise
  const sent = await h.run('send', { sessionId: 'B', message: '任务', replyHandling: 'receive-only' })
  const reply = await h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId, mode: 'queue' }, 'B')
  const append = a.session.append; let fail = true
  a.session.append = function(type, data, intent) { if (fail && type === 'user/message') throw new Error('isolated write failure'); return append.call(this, type, data, intent) }
  const warn = console.warn, warnings = []; console.warn = (...args) => warnings.push(args)
  try {
    a.status = 'idle'; h.emit('agent/status', { agent: a, status: 'idle' }); await new Promise(resolve => setImmediate(resolve))
    assert.equal(a.inbox.nextStep.length, 0)
    assert.equal(a.inbox.nextTurn[0].id, reply.messageId)
    assert.equal(a.session.events.some(e => e.type === 'user/message' && e.data.id === reply.messageId), false)
    assert.equal(warnings.length, 1)
    fail = false; h.emit('agent/status', { agent: a, status: 'idle' }); await new Promise(resolve => setImmediate(resolve))
    assert.equal(a.session.events.filter(e => e.type === 'user/message' && e.data.id === reply.messageId).length, 1)
    assert.equal(a.inbox.nextTurn.length, 0)
  } finally { console.warn = warn; settled.resolve() }
})

await test('授权仅指向指定目标；裸 on、通配符、自身均拒绝', () => {
  const g = createGrants()
  assert.equal(runCoordinateCommand(g, 'A', 'on').kind, 'error')
  assert.equal(runCoordinateCommand(g, 'A', 'on *').kind, 'error')
  assert.equal(runCoordinateCommand(g, 'A', 'on A').kind, 'error')
  assert.equal(runCoordinateCommand(g, 'A', 'on B').kind, 'success')
  assert.equal(g.isGranted('A', 'B'), true)
  assert.equal(g.isGranted('A', 'C'), false)
  assert.equal(g.isGranted('B', 'A'), false)
  assert.deepEqual(g.list('A'), ['B'])
  assert.match(runCoordinateCommand(g, 'A', 'status').text, /B/)
  runCoordinateCommand(g, 'A', 'off')
  assert.throws(() => requireCoordination(g, 'A', 'send', 'B'), /not authorized/)
  assert.equal(runCoordinateCommand(g, '', 'on B').kind, 'error')
  assert.equal(runCoordinateCommand(g, 'A', 'on B C').kind, 'success')
  assert.deepEqual(g.list('A'), ['B', 'C'])
  runCoordinateCommand(g, 'A', 'on C')
  assert.deepEqual(g.list('A'), ['C'], '新的目标表替换旧表')
})

await test('冷目标复用宿主解析器恢复模型和预设；解析失败不投递且可重试', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  const target = h.agents.get('B'); h.agents.delete('B')
  h.ctx.sessionPersistence = { list: async () => [{ header: { id: 'B', createdAt: 1 } }] }
  h.ctx.agents.resume = async () => { throw new Error('不能绕过桌面解析器') }
  let fail = true, resolves = 0
  h.ctx.typert = { lookups: { get(key) {
    assert.equal(key, 'agent')
    return { async resolve(id) {
      resolves++; assert.equal(id, 'B')
      if (fail) throw new Error('模型装配失败')
      h.agents.set(id, target); return target
    } }
  } } }
  await assert.rejects(() => h.run('send', { sessionId: 'B', message: '任务' }), /模型装配失败/)
  assert.equal(h.effects.length, 0)
  fail = false
  await h.run('send', { sessionId: 'B', message: '任务' })
  assert.equal(resolves, 2)
  assert.deepEqual(h.effects, [['steer', 'B']])
})

for (const running of [false, true]) await test(`A→B→A：B ${running ? '忙' : '闲'}，仅 A 获准，B 一次回信后拒绝第三跳`, async () => {
  const h = harness(); h.grants.grant('A', ['B']); h.agents.get('B').status = running ? 'running' : 'idle'
  const first = await h.run('send', { sessionId: 'B', message: '任务' })
  assert.equal(first.hopCount, 1)
  assert.ok(h.agents.get('B').session.events.at(-1).data.content[0].text.includes('replyTo=' + first.messageId))
  const second = await h.run('send', { sessionId: 'A', message: '完成', replyTo: first.messageId }, 'B')
  assert.equal(second.hopCount, 2); assert.equal(second.terminal, true)
  assert.equal(h.grants.isGranted('B', 'A'), false)
  const count = h.effects.length
  await assert.rejects(() => h.run('send', { sessionId: 'B', message: '再回', replyTo: second.messageId }), /terminal/)
  await assert.rejects(() => h.run('send', { sessionId: 'B', message: '省略 replyTo 再回' }), /terminal/)
  await assert.rejects(() => h.run('send', { sessionId: 'A', message: '重复回信', replyTo: first.messageId }, 'B'), /already/)
  assert.equal(h.effects.length, count)
  h.human('A')
  const next = await h.run('send', { sessionId: 'B', message: '用户主动开始下一任务' })
  assert.equal(next.hopCount, 1)
})

await test('B 省略 replyTo 仍只能回原发送者；不能转发 C', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  await h.run('send', { sessionId: 'B', message: '任务' })
  await assert.rejects(() => h.run('send', { sessionId: 'C', message: '越权转发' }, 'B'), /incoming task/)
  const reply = await h.run('send', { sessionId: 'A', message: '完成' }, 'B')
  assert.equal(reply.hopCount, 2)
})

await test('授权前、目标不符、伪造 replyTo、未授权归档停止均无副作用', async () => {
  const h = harness()
  for (const name of ['send', 'resume', 'cancel', 'archive', 'unarchive', 'monitor_start', 'monitor_stop']) {
    await assert.rejects(() => h.run(name, { sessionId: 'C', message: 'x', stopActivity: true }), /not authorized/)
  }
  h.grants.grant('A', ['B'])
  await assert.rejects(() => h.run('send', { sessionId: 'C', message: 'x' }), /not authorized/)
  await assert.rejects(() => h.run('create', { cwd: '/tmp', prompt: 'task' }), /cannot determine creating session/)
  await assert.rejects(() => h.run('send', { sessionId: 'B', message: 'x', replyTo: 'forged' }), /incoming task/)
  assert.equal(h.effects.length, 0)
})

await test('撤销或替换 A 的目标授权后，旧任务不再提供回信权', async () => {
  for (const replace of [false, true]) {
    const h = harness(); h.grants.grant('A', ['B'])
    const sent = await h.run('send', { sessionId: 'B', message: '任务' })
    if (replace) h.grants.grant('A', ['C']); else h.grants.revoke('A')
    await assert.rejects(() => h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B'), /incoming task/)
  }
})

await test('失败不消费回信权，成功后只能一次；并发回信只有一次投递', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  const sent = await h.run('send', { sessionId: 'B', message: '任务' })
  const original = h.agents.get('A').steer
  h.agents.get('A').steer = () => { throw new Error('transport failed') }
  await assert.rejects(() => h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B'), /transport failed/)
  h.agents.get('A').steer = original
  const results = await Promise.allSettled([1, 2].map(() => h.run('send', { sessionId: 'A', message: '完成', replyTo: sent.messageId }, 'B')))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(h.effects.filter(e => e[1] === 'A').length, 1)
})

await test('面板人工发送不授予广泛权限；稳定请求去重，B 可回且 off 可撤销', async () => {
  const h = harness(), raw = JSON.stringify({ requestId: 'request-1234', sessionId: 'B', message: '人工任务', mode: 'steer' })
  const results = await Promise.all([h.delivery.fromCommand('A', raw), h.delivery.fromCommand('A', raw)])
  assert.equal(results[0].kind, 'success'); assert.equal(results[1].kind, 'success')
  assert.equal(h.effects.length, 1)
  assert.equal(h.grants.isGranted('A', 'B'), false)
  const conflict = await h.delivery.fromCommand('A', raw.replace('人工任务', '换正文'))
  assert.equal(conflict.kind, 'error')
  const reply = await h.run('send', { sessionId: 'A', message: '完成', replyTo: 'request-1234' }, 'B')
  assert.equal(reply.terminal, true)
  const next = await h.delivery.fromCommand('A', raw.replace('request-1234', 'request-5678'))
  assert.equal(next.kind, 'success')
  h.delivery.revoke('A')
  await assert.rejects(() => h.run('send', { sessionId: 'A', message: '完成', replyTo: 'request-5678' }, 'B'), /incoming task/)
})

await test('面板失败后同 id 可重试；来源只由宿主绑定', async () => {
  const h = harness(), a = h.agents.get('B'), original = a.steer
  const raw = JSON.stringify({ requestId: 'request-fail', sessionId: 'B', message: '任务', mode: 'queue', senderSessionId: 'C' })
  a.followup = () => { throw new Error('fail once') }
  assert.equal((await h.delivery.fromCommand('A', raw)).kind, 'error')
  a.followup = original
  assert.equal((await h.delivery.fromCommand('A', raw)).kind, 'success')
  assert.equal(a.session.events.at(-1).data.source.senderSessionId, 'A')
})

await test('回信的原始协作请求只取宿主实际账本，面板和模型发送都保持原文及一次回信边界', async () => {
  const original = '请评审“已验证/未验证”。\n原文提到 replyTo=x、[内部回信上下文] 和 \\"引号\\"。'
  for (const human of [false, true]) {
    const h = harness()
    let root
    if (human) {
      const sent = await h.delivery.fromCommand('A', JSON.stringify({ requestId: 'request-context', sessionId: 'B', message: original, mode: 'steer', originalRequest: '伪造上下文' }))
      assert.equal(sent.kind, 'success'); root = JSON.parse(sent.text).messageId
    } else {
      h.grants.grant('A', ['B'])
      root = (await h.run('send', { sessionId: 'B', message: original })).messageId
    }
    const answer = '结果原文：无需回信是用户要求讨论的词，不能删。\n第二行。'
    const sent = await h.run('send', { sessionId: 'A', message: answer, replyTo: root, originalRequest: '伪造回信上下文', currentAction: '伪造动作', originalRequestOrigin: human ? 'model-tool' : 'human-command' }, 'B')
    const data = h.agents.get('A').session.events.at(-1).data
    const lines = data.content[0].text.split('\n')
    const prefix = '[当前协作交付：' + (human ? '用户此前已通过人工发送入口发起原请求。' : '原会话此前已通过工具发起协作请求。') + '请现在向本会话用户交付该请求所需的业务结果。原请求记录（JSON数据）：'
    assert.ok(lines[1].startsWith(prefix))
    const context = JSON.parse(lines[1].slice(prefix.length, -1))
    assert.equal(context.originalRequest, original)
    assert.equal(context.replyTo, root)
    assert.equal(context.automaticSend, false)
    assert.equal(context.version, 4)
    assert.equal(context.purpose, 'result-context')
    assert.equal(context.originalRequestOrigin, human ? 'human-command' : 'model-tool')
    assert.equal(Object.hasOwn(context, 'currentAction'), false)
    assert.equal(lines.slice(2).join('\n'), answer)
    assert.equal(data.source.rootMessageId, root)
    assert.equal(data.source.hopCount, 2)
    await assert.rejects(() => h.run('send', { sessionId: 'B', message: '第三跳', replyTo: sent.messageId }), /terminal/)
    assert.equal(h.grants.isGranted('B', 'A'), false)
  }
})

await test('成功回信的结构化诊断保留，模型回执不重复内部编号；普通发送仍保留等待锚点', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  const task = await h.run('send', { sessionId: 'B', message: '计算14+29' })
  const reply = await h.run('send', { sessionId: 'A', message: '43', replyTo: task.messageId }, 'B')
  const render = value => h.tools.get('session_coordinator_send').output.render({ sessionId: 'A', message: '43' }, value).map(block => block.text).join('\n')
  const ordinary = render(task), terminal = render(reply)
  assert.match(ordinary, /pass as requestId to session_coordinator_wait/)
  assert.match(ordinary, /legacy assistant-text cursor/)
  assert.equal(reply.terminal, true)
  assert.equal(typeof reply.messageId, 'string')
  assert.equal(typeof reply.sinceSeq, 'number')
  assert.equal(typeof reply.reason, 'string')
  assert.doesNotMatch(terminal, /messageId:|sinceSeq:|terminal:|sent to /)
  assert.ok(!terminal.includes(reply.messageId))
  assert.ok(!terminal.includes(reply.reason))
  assert.doesNotMatch(terminal, /pass as replyTo|pass to session_coordinator_wait/)
  assert.equal(terminal, '43')
  const business = '用户要求保留 messageId: CASE-42；replyTo 是关联字段。'
  assert.equal(h.tools.get('session_coordinator_send').output.render({ sessionId: 'A', message: business }, reply)[0].text, business)
  const waited = render({ ...reply, reply: { message: { text: '用户正文 messageId: 原样保留' } } })
  assert.ok(waited.includes('用户正文 messageId: 原样保留'))
  await assert.rejects(() => h.run('send', { sessionId: 'A', message: '重复回信', replyTo: task.messageId }, 'B'), /consumed|already|terminal/)
})

await test('伪造正文来源不能取得回信权；重启后的旧入站消息不能重放', async () => {
  const h = harness()
  h.agents.get('B').session.events[0].data.content[0].text = '来自会话 A · 回信请发给它'
  await assert.rejects(() => h.run('send', { sessionId: 'A', message: '完成' }, 'B'), /not authorized/)
  h.agents.get('B').session.events.push({ seq: 2, type: 'user/message', data: { source: { kind: 'session-message', messageId: 'old-process-id' } } })
  await assert.rejects(() => h.run('send', { sessionId: 'A', message: '完成' }, 'B'), /incoming task/)
})

await test('归档目标不能伪造接收成功；失败不消费回信', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  h.ctx.workspaceRegistry.archivedSessionIds.push('B')
  await assert.rejects(() => h.run('send', { sessionId: 'B', message: '任务' }), /已归档/)
  assert.equal(h.effects.length, 0)
})

await test('恢复目标期间 off 撤销：投递前停止，且不会留下可用回信权', async () => {
  const h = harness(); h.grants.grant('A', ['B'])
  const target = h.agents.get('B'); h.agents.delete('B')
  let release
  const pending = new Promise(resolve => { release = resolve })
  h.ctx.sessionPersistence = { list: async () => [{ header: { id: 'B', createdAt: 1 } }] }
  h.ctx.agents.resume = async () => { await pending; h.agents.set('B', target); return { agent: target } }
  const send = h.run('send', { sessionId: 'B', message: '任务' })
  h.grants.revoke('A'); h.delivery.revoke('A'); release()
  await assert.rejects(() => send, /authorization changed|not authorized/)
  assert.equal(h.effects.length, 0)
})

console.log(`\n${passed} passed, 0 failed`)
