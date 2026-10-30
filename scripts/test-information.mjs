import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { registerBridgeTools } from '../src/tools.ts'
import { createGrants } from '../src/coordinate.ts'

function fixture() {
  const agents = new Map(), tools = new Map(), listeners = new Map(), grants = createGrants(), approvals = []
  for (const id of ['A', 'B', 'C']) {
    const session = Session.create(id)
    const a = { id, session, status: 'idle', inbox: { nextStep: [], nextTurn: [], remove(messageId) { for (const list of [this.nextStep, this.nextTurn]) { const i = list.findIndex(m => m.id === messageId); if (i >= 0) { list.splice(i, 1); return true } } return false } },
      wakes: 0, steer() { this.wakes++ }, followup() { this.wakes++ },
      inject(m) { this.inbox.nextStep.push(m); session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [m] }) },
      send(m, target, wake) { assert.equal(wake, false); this.inject(m) }, whenIdle: () => new Promise(() => {}),
      runMaintenance(job) { if (this.status === 'running') throw Error('busy'); return job(new AbortController().signal) } }
    agents.set(id, a)
  }
  agents.get('A').session.append('user/message', { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'share result' }] }, { surfaceOp: 'append' })
  const ctx = { agents: { get: id => agents.get(id), list: () => [...agents.values()] }, tools: { register: t => tools.set(t.name, t) },
    workspaceRegistry: { archivedSessionIds: [], list: () => [] }, on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list) }, effect() {},
    sessions: { flush: async () => true },
    get: name => name === 'approval' ? { request: async req => { approvals.push(req); return 'allowed-once' } } : undefined }
  const env = { ctx, grants, registry: { touch() {}, get: async () => undefined, all: async () => [] } }
  registerBridgeTools(env)
  const run = args => tools.get('session_coordinator_send').execute(args, { agent: agents.get('A'), callId: 'call', signal: new AbortController().signal })
  return { agents, ctx, env, grants, tools, approvals, run }
}

test('information to an idle session is visible context without wake or reply permission', async () => {
  const h = fixture(); h.grants.grant('A', ['B'])
  const result = await h.run({ sessionId: 'B', message: '结论已更新', intent: 'information', requestId: 'stable-information' })
  assert.equal(result.intent, 'information'); assert.equal(h.agents.get('B').wakes, 0)
  const received = h.agents.get('B').session.snapshotEvents().find(e => e.type === 'user/message')
  assert.ok(received); assert.equal(received.data.source.purpose, 'information')
  assert.match(received.data.content[0].text, /结论已更新$/)
  await assert.rejects(h.tools.get('session_coordinator_send').execute({ sessionId: 'A', message: 'echo', replyTo: result.messageId }, { agent: h.agents.get('B'), signal: new AbortController().signal }), /information|terminal/)
})

test('concurrent information retries retain one copy and reject changed content', async () => {
  const h = fixture(); h.grants.grant('A', ['B'])
  const args = { sessionId: 'B', message: 'shared', intent: 'information', requestId: 'same-request' }
  await Promise.all([h.run(args), h.run(args)])
  assert.equal(h.agents.get('B').session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
  await assert.rejects(h.run({ ...args, message: 'changed' }), /another message/)
})

test('busy information is pending without wake and survives plugin reload as idle context', async () => {
  const h = fixture(); h.grants.grant('A', ['B']); h.agents.get('B').status = 'running'
  await h.run({ sessionId: 'B', message: 'shared', intent: 'information', requestId: 'busy-information' })
  const b = h.agents.get('B'); assert.equal(b.wakes, 0); assert.equal(b.inbox.nextStep.length, 1)
  b.status = 'idle'; b.inbox.nextStep.splice(0)
  registerBridgeTools({ ...h.env, delivery: undefined })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(b.session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
})

test('a sync group deduplicates recipients, asks once and retries without duplicate successes', async () => {
  const h = fixture(), args = { sessionIds: ['C', 'B', 'B'], message: 'group result', intent: 'information', requestId: 'group-request' }
  const sent = await h.run(args)
  assert.equal(h.approvals.length, 1); assert.equal(sent.results.length, 2)
  assert.ok(sent.results.every(x => x.status === 'accepted'))
  await h.run({ ...args, sessionIds: ['B', 'C'] })
  for (const id of ['B', 'C']) assert.equal(h.agents.get(id).session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
  await assert.rejects(h.run({ ...args, sessionIds: ['B'] }), /another message|another batch/)
})

test('retryFailed resumes only the failed recipients and preserves prior successes', async () => {
  const h = fixture(); h.grants.grant('A', ['B', 'C']); h.ctx.workspaceRegistry.archivedSessionIds.push('C')
  const args = { sessionIds: ['B', 'C'], message: 'update', intent: 'information', requestId: 'partial-group' }
  const first = await h.run(args)
  assert.equal(first.complete, false)
  h.ctx.workspaceRegistry.archivedSessionIds.splice(0)
  const retry = await h.run({ ...args, retryFailed: true })
  assert.equal(retry.complete, true)
  for (const id of ['B', 'C']) assert.equal(h.agents.get(id).session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
})

test('unknown post-write failure is never blindly retried', async () => {
  const h = fixture(); h.grants.grant('A', ['B'])
  h.agents.get('B').runMaintenance = async job => { await job(new AbortController().signal); throw Error('after write') }
  const args = { sessionId: 'B', message: 'once', intent: 'information', requestId: 'unknown-outcome' }
  await assert.rejects(h.run(args), /after write/)
  await assert.rejects(h.run(args), /outcome unknown/)
  assert.equal(h.agents.get('B').session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
})

test('approval rejection and revocation stop the entire group before any delivery', async () => {
  for (const revoke of [false, true]) {
    const h = fixture()
    h.ctx.get = () => ({ request: async () => { if (revoke) h.env.delivery.revoke('A'); return revoke ? 'allowed-once' : 'rejected' } })
    await assert.rejects(h.run({ sessionIds: ['B', 'C'], message: 'stop', intent: 'information', requestId: 'denied-group' }), /not authorized|authorization changed/)
    for (const id of ['B', 'C']) assert.equal(h.agents.get(id).session.snapshotEvents().some(e => e.type === 'user/message'), false)
  }
})

test('archiving during asynchronous preparation prevents sending to the old target', async () => {
  const h = fixture(); h.grants.grant('A', ['B'])
  h.ctx.sessions = { flush: async session => {
    const record = pluginRecordOf(session.snapshotEvents().at(-1))
    if (session.id === 'A' && record?.type === 'plugin:dsh-session-coordinator/delivery' && record.data.stage === 'intent') h.ctx.workspaceRegistry.archivedSessionIds.push('B')
    return true
  } }
  const args = { sessionId: 'B', message: 'stop', intent: 'information', requestId: 'archive-race' }
  await assert.rejects(h.run(args), /target changed/)
  assert.equal(h.agents.get('B').session.snapshotEvents().some(e => e.type === 'user/message'), false)
  h.ctx.sessions.flush = async () => true; h.ctx.workspaceRegistry.archivedSessionIds.splice(0)
  await h.run(args)
  assert.equal(h.agents.get('B').session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
})

test('request identity cannot change single/group recipients or content', async () => {
  const h = fixture(); h.grants.grant('A', ['B', 'C'])
  const args = { sessionId: 'B', intent: 'information', requestId: 'immutable-request', message: 'first' }
  await h.run(args)
  await assert.rejects(h.run({ ...args, sessionId: 'C', message: 'changed' }), /another message|another batch/)
  await assert.rejects(h.run({ intent: 'information', sessionIds: ['B', 'C'], requestId: args.requestId, message: 'first' }), /another message|another batch/)
})

test('a formerly running recipient is skipped; failed and unknown outcomes are distinct', async () => {
  const h = fixture(); h.grants.grant('A', ['B', 'C'])
  const skipped = await h.run({ sessionIds: ['B', 'C'], intent: 'information', message: 'update', requestId: 'running-snapshot', requireRunning: true })
  assert.ok(skipped.results.every(x => x.status === 'skipped'))
  h.ctx.workspaceRegistry.archivedSessionIds.push('B')
  h.agents.get('C').runMaintenance = async job => { await job(new AbortController().signal); throw Error('unknown after write') }
  const result = await h.run({ sessionIds: ['B', 'C'], intent: 'information', message: 'update', requestId: 'mixed-outcomes' })
  assert.equal(result.results.find(x => x.sessionId === 'B').status, 'failed')
  assert.equal(result.results.find(x => x.sessionId === 'C').status, 'unknown')
  h.ctx.workspaceRegistry.archivedSessionIds.splice(0)
  const retried = await h.run({ sessionIds: ['B', 'C'], intent: 'information', message: 'update', requestId: 'mixed-outcomes', retryFailed: true })
  assert.equal(retried.results.find(x => x.sessionId === 'B').status, 'accepted')
  assert.equal(retried.results.find(x => x.sessionId === 'C').status, 'unknown')
  assert.equal(h.agents.get('C').session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
})

test('target durability failure is unknown and never becomes accepted on retry', async () => {
  const h = fixture(); h.grants.grant('A', ['B'])
  h.ctx.sessions.flush = async session => session.id !== 'B'
  const args = { sessionIds: ['B'], intent: 'information', message: 'retain', requestId: 'target-flush-fail' }
  const first = await h.run(args)
  assert.equal(first.complete, false); assert.equal(first.results[0].status, 'unknown')
  h.ctx.sessions.flush = async () => true
  const retry = await h.run({ ...args, retryFailed: true })
  assert.equal(retry.results[0].status, 'unknown')
  assert.equal(h.agents.get('B').session.snapshotEvents().filter(e => e.type === 'user/message').length, 1)
})
