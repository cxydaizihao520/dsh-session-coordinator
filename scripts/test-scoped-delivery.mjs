import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionDelivery, InformationDeliveryError } from '../src/delivery.ts'
import { createGrants } from '../src/coordinate.ts'

function fixture() {
  const agents = new Map()
  for (const id of ['A', 'B']) {
    const session = Session.create(id)
    const inbox = { nextStep: [], nextTurn: [], remove(id) {
      for (const queue of [this.nextStep, this.nextTurn]) {
        const i = queue.findIndex(m => m.id === id)
        if (i >= 0) { queue.splice(i, 1); return true }
      }
      return false
    } }
    agents.set(id, { id, session, inbox, status: 'idle', wakes: 0,
      followup(m) { this.wakes++; inbox.nextTurn.push(m) },
      steer(m) { this.wakes++; inbox.nextStep.push(m) },
      inject(m) { inbox.nextStep.push(m) }, send(m, target, wake) { assert.equal(wake, false); inbox.nextStep.push(m) },
      whenIdle: () => new Promise(() => {}),
      runMaintenance(job) { if (this.status === 'running') throw Error('busy'); return job() },
    })
  }
  const ctx = { agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    sessions: { flush: async () => true }, workspaceRegistry: { archivedSessionIds: [] }, on() {}, effect() {} }
  const delivery = new SessionDelivery(ctx, {}, createGrants())
  const message = { id: 'op-1', role: 'user', source: { kind: 'session-collaboration', scopeId: 'scope' }, content: [{ type: 'text', text: 'task' }] }
  const run = options => delivery.deliverScoped('B', message, agents.get('A'), { mode: 'queue', validate() {}, ...options })
  return { ctx, agents, run, message }
}

test('scoped tasks bind the actual target before native queue delivery and flush it', async () => {
  const h = fixture(), target = h.agents.get('B'), calls = []
  h.ctx.sessions.flush = async session => { calls.push(session.id); return true }
  const sent = await h.run({ beforeSubmit: agent => { assert.equal(agent, target); assert.equal(agent.wakes, 0) } })
  assert.equal(sent.messageId, 'op-1'); assert.equal(target.wakes, 1)
  assert.equal(target.inbox.nextTurn[0], h.message); assert.deepEqual(calls.filter(id => id === 'B'), ['B']); assert.equal(calls[0], 'B', 'actual target durability precedes optional caller diagnostics')
})

test('scope validation and cancellation fail before native delivery', async () => {
  for (const options of [{ validate() { throw Error('revoked') } }, { signal: AbortSignal.abort() }]) {
    const h = fixture(); await assert.rejects(h.run(options)); assert.equal(h.agents.get('B').wakes, 0)
  }
  const h = fixture(); h.ctx.workspaceRegistry.archivedSessionIds.push('B')
  await assert.rejects(h.run(), /归档|archived/); assert.equal(h.agents.get('B').wakes, 0)
})

test('scoped context stays idle and failures after native submission are unknown', async () => {
  const h = fixture(), target = h.agents.get('B')
  await h.run({ mode: 'context' })
  assert.equal(target.wakes, 0); assert.equal(target.session.snapshotEvents().at(-1).data.id, 'op-1')
  const other = fixture(); other.ctx.sessions.flush = async () => { throw Error('disk') }
  await assert.rejects(other.run(), error => error instanceof InformationDeliveryError && error.outcome === 'unknown')
  assert.equal(other.agents.get('B').wakes, 1)
})

test('asynchronous material preparation rechecks authority and keeps the operation identity', async () => {
  const h = fixture(); let authorized = true
  await assert.rejects(h.run({ validate() { if (!authorized) throw Error('revoked') },
    prepareMessage: async () => { authorized = false; return h.message } }), /revoked/)
  assert.equal(h.agents.get('B').wakes, 0)
  const changed = fixture()
  await assert.rejects(changed.run({ prepareMessage: async () => ({ ...changed.message, id: 'another-operation' }) }), /identity/)
  assert.equal(changed.agents.get('B').wakes, 0)
})

test('a scoped peer message grants no legacy unrelated task or reply permission', () => {
  const h = fixture()
  h.agents.get('A').session.append('user/message', h.message, { surfaceOp: 'append' })
  const delivery = new SessionDelivery(h.ctx, {}, createGrants())
  assert.throws(() => delivery.assertNewTask(h.agents.get('A')), /approved task/)
})
