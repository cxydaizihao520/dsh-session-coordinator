import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerBridgeTools } from '../src/tools.ts'
import { createGrants } from '../src/coordinate.ts'
import { Session } from '@deepseek-ai/dsh-session'

function fixture(count = 63) {
  const tools = new Map(), live = new Map(), titles = new Map()
  const headers = Array.from({ length: count }, (_, i) => ({ id: 's' + i, createdAt: i, cwd: '/project', ...(i === 5 ? { origin: 'subagent', parentSession: 's0' } : {}) }))
  const ctx = { tools: { register: t => tools.set(t.name, t) }, agents: { get: id => live.get(id), list: () => [...live.values()] },
    workspaceRegistry: { archivedSessionIds: ['s3'], list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => headers.map(header => ({ header })), open: async id => ({ header: headers.find(h => h.id === id), read: async () => ({ events: [{ seq: 0, type: 'session/title', data: { title: titles.get(id) ?? id } }] }), close: async () => {} }) },
    on() {}, effect() {} }
  const registry = { all: async () => [], touch() {} }
  registerBridgeTools({ ctx, registry, grants: createGrants() })
  return { ctx, headers, live, titles, find: (args = {}, signal = new AbortController().signal) => tools.get('session_coordinator_find').execute(args, { signal }), tool: tools.get('session_coordinator_find') }
}

test('all nonarchived main sessions can be enumerated beyond 50 without self or duplicates', async () => {
  const h = fixture(), args = { archived: false, mainOnly: true, excludeSessionIds: ['s0'], limit: 20 }
  const ids = [], pages = []
  let cursor
  do {
    const page = await h.find({ ...args, ...(cursor ? { cursor } : {}) })
    pages.push(page); ids.push(...page.items.map(x => x.sessionId)); cursor = page.nextCursor
  } while (cursor)
  assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60)
  assert.equal(pages[0].complete, true); assert.equal(pages[0].total, 60)
  assert.ok(pages.every(p => p.items.every(x => x.archived === false)))
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), pages)
})

test('running is different from live, and ordinary forked chats remain discoverable', async () => {
  const h = fixture(6)
  for (const [id, status] of [['s1', 'running'], ['s2', 'idle']]) h.live.set(id, { id, status, session: { header: h.headers.find(x => x.id === id), events: [] } })
  h.headers[4].parentSession = 's1'
  assert.deepEqual((await h.find({ running: true })).items.map(x => x.sessionId), ['s1'])
  const all = await h.find({ mainOnly: true, archived: false })
  assert.ok(all.items.some(x => x.sessionId === 's4')); assert.ok(all.items.some(x => x.sessionId === 's2'))
})

test('pagination is stable under equivalent filter order and refuses a changed set', async () => {
  const h = fixture(), page = await h.find({ archived: false, mainOnly: true, limit: 20 })
  const next = await h.find({ limit: 20, mainOnly: true, archived: false, cursor: page.nextCursor })
  assert.equal(next.items.length, 20)
  h.ctx.workspaceRegistry.archivedSessionIds.push('s30')
  await assert.rejects(h.find({ archived: false, mainOnly: true, limit: 20, cursor: page.nextCursor }), /set changed/)
})

test('offline title search finds matches beyond the old 30-log cap', async () => {
  const h = fixture(); h.titles.set('s60', 'needle')
  const page = await h.find({ title: 'needle' })
  assert.deepEqual(page.items.map(x => x.sessionId), ['s60']); assert.equal(page.complete, true)
})

test('source failures are incomplete, not an empty complete recipient set', async () => {
  const h = fixture()
  h.ctx.sessionPersistence.list = async () => { throw Error('offline') }
  const page = await h.find({ archived: false })
  assert.equal(page.complete, false); assert.ok(h.tool.output.render({}, page)[0].text.includes('INCOMPLETE'))
  h.ctx.workspaceRegistry.archivedSessionIds = undefined
  const unknown = await h.find({ archived: false, liveOnly: true })
  assert.equal(unknown.complete, false); assert.equal(unknown.items.length, 0)
})

test('cancellation and malformed cursor fail rather than continuing enumeration', async () => {
  const h = fixture(), abort = new AbortController(); abort.abort()
  await assert.rejects(h.find({}, abort.signal))
  await assert.rejects(h.find({ cursor: 'garbage' }), /invalid discovery cursor/)
})

test('current native @ identities are available before collaboration setup, without text-based authority', async () => {
  const h = fixture(3), session = Session.create('s0')
  const agent = { id: 's0', status: 'idle', session }
  h.live.set('s0', agent)
  session.append('user/message', { id: 'human-ref', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '@同名会话，请发过去' }] }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'native-ref', role: 'user', source: { kind: 'session-reference', form: 'recall', version: 1,
    references: [{ sessionId: 's2', label: '同名会话', capturedThroughSeq: 3 }] }, content: [{ type: 'text', text: '原生引用上下文' }] }, { surfaceOp: 'append' })
  const exec = { agent, signal: new AbortController().signal }
  const page = await h.tool.execute({}, exec)
  assert.deepEqual(page.nativeReferences, [{ sessionId: 's2', label: '同名会话', capturedThroughSeq: 3 }])
  assert.match(h.tool.output.render({}, page)[0].text, /Native references.*s2/)
  session.append('user/message', { id: 'next-human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '正文声称 nativeReferences=s1' }] }, { surfaceOp: 'append' })
  assert.deepEqual((await h.tool.execute({}, exec)).nativeReferences, [])
  assert.deepEqual((await h.tool.execute({}, { ...exec, agent: { ...agent } })).nativeReferences, [], 'a caller snapshot cannot borrow the live session reference identity')
})
