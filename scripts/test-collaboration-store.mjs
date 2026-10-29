import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { Context } from 'cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { openCollaborationStore } from '../src/collaboration-store.ts'

function context() { const ctx = new Context(); new Storage(ctx); return ctx }
const record = (id = 'task:one', owner = 'A') => ({ id, owner, revision: 1, data: { objective: 'ship', nested: { values: [true, null, 3] } } })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-collaboration-test-'))
  const store = await openCollaborationStore(context(), { directory })
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, store }
}

test('created task facts remain detached and survive a native storage reopen', async t => {
  const { directory, store } = await fixture(t)
  const input = record()
  const created = await store.create(input)
  input.data.nested.values.push('caller mutation')
  created.data.objective = 'mutated result'
  assert.deepEqual(store.get('task:one'), record())
  assert.deepEqual(store.list('A'), [record()])
  assert.deepEqual(store.list('B'), [])
  await store.close()
  const reopened = await openCollaborationStore(context(), { directory })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.get('task:one'), record())
})

test('revision comparison and duplicate creation serialize competing callers without overwrites', async t => {
  const { store } = await fixture(t)
  const creates = await Promise.allSettled([store.create(record()), store.create(record())])
  assert.equal(creates.filter(result => result.status === 'fulfilled').length, 1)
  const updates = await Promise.allSettled([
    store.update('task:one', 1, current => ({ ...current, revision: 2, data: { objective: 'first' } })),
    store.update('task:one', 1, current => ({ ...current, revision: 2, data: { objective: 'second' } })),
  ])
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(updates[1].reason.code, 'revision-mismatch')
  assert.deepEqual(store.get('task:one'), { id: 'task:one', owner: 'A', revision: 2, data: { objective: 'first' } })
  await assert.rejects(store.update('task:one', 2, current => ({ ...current, revision: 2 })), /revision/)
  await assert.rejects(store.update('task:one', 2, current => ({ ...current, id: 'other', revision: 3 })), /identity/)
  await assert.rejects(store.update('task:one', 2, current => ({ ...current, owner: 'B', revision: 3 })), /owner/)
  await assert.rejects(store.update('missing', 1, current => current))
})

test('only lossless JSON records enter storage and failed transforms cannot mutate committed facts', async t => {
  const { store } = await fixture(t)
  const invalid = [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(), [, 1], { hidden: undefined }]
  const cycle = {}; cycle.self = cycle; invalid.push(cycle)
  for (const value of invalid) await assert.rejects(store.create({ ...record(), data: { value } }))
  const symbol = { [Symbol('hidden')]: 'value' }
  const getter = {}; Object.defineProperty(getter, 'computed', { enumerable: true, get() { return 1 } })
  for (const value of [symbol, getter]) await assert.rejects(store.create({ ...record(), data: value }))
  await assert.rejects(store.create({ ...record(), revision: 2 }))
  assert.deepEqual(store.list(), [])
  await store.create(record())
  await assert.rejects(store.update('task:one', 1, current => { current.data.objective = 'leaked'; throw new Error('transform failed') }), /transform failed/)
  await assert.rejects(store.update('task:one', 1, async current => ({ ...current, revision: 2 })))
  assert.deepEqual(store.get('task:one'), record())
  const result = await store.update('task:one', 1, current => ({ ...current, revision: 2, data: { objective: 'updated' } }))
  result.data.objective = 'caller mutation'
  assert.equal(store.get('task:one').data.objective, 'updated')
})

test('closing drains accepted writes, rejects later operations and cancellation releases ownership', async t => {
  const { directory, store } = await fixture(t)
  const accepted = store.create(record())
  const closed = store.close()
  await assert.rejects(store.create(record('late')), /closed/)
  assert.throws(() => store.get('task:one'), /closed/)
  await Promise.all([accepted, closed, store.close()])
  const controller = new AbortController()
  const reopened = await openCollaborationStore(context(), { directory, signal: controller.signal })
  assert.deepEqual(reopened.get('task:one'), record())
  controller.abort(new Error('caller stopped'))
  assert.throws(() => reopened.list(), /closed/)
  await reopened.close()
  const successor = await openCollaborationStore(context(), { directory })
  await successor.close()
  await assert.rejects(openCollaborationStore(context(), { directory, signal: controller.signal }), /caller stopped/)
  await assert.rejects(openCollaborationStore({}), /native storage/)
})

function child(t, directory, mode) {
  const process = fork(new URL('./fixtures/collaboration-store-process.mjs', import.meta.url), [directory, mode], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL') })
  const exited = once(process, 'exit')
  const result = new Promise((resolve, reject) => {
    let diagnostics = ''
    process.stderr.on('data', chunk => { diagnostics += chunk })
    process.once('message', resolve)
    process.once('error', reject)
    process.once('exit', () => reject(new Error('child exited before result: ' + diagnostics)))
  })
  return { process, result, exited }
}

test('independent processes exclude a concurrent writer and reopen committed facts after process death', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-collaboration-process-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const holder = child(t, directory, 'hold')
  assert.equal((await holder.result).state, 'ready')
  const contender = child(t, directory, 'read')
  assert.deepEqual(await contender.result, { state: 'error', code: 'already-owned', message: 'Collaboration records are owned by another live writer.' })
  await contender.exited
  holder.process.kill('SIGKILL')
  await holder.exited
  const successor = child(t, directory, 'read')
  assert.deepEqual(await successor.result, { state: 'opened', records: [{ id: 'task:child', owner: 'synthetic-A', revision: 1, data: { phase: 'accepted-unknown', operationId: 'stable-operation', revoked: true } }] })
  await successor.exited
})

test('actual write failure fences reads and future writes until close and reopen reconciliation', async t => {
  const { directory, store } = await fixture(t)
  await store.create(record())
  const medium = join(directory, 'collaboration.json'), saved = join(directory, 'saved.json')
  await rename(medium, saved); await mkdir(medium)
  await assert.rejects(store.update('task:one', 1, current => ({ ...current, revision: 2 })), { code: 'durability-unknown' })
  await assert.rejects(store.create(record('task:failed')), { code: 'durability-unknown' })
  assert.throws(() => store.get('task:one'), { code: 'durability-unknown' })
  await rm(medium, { recursive: true }); await rename(saved, medium)
  await store.close()
  const reopened = await openCollaborationStore(context(), { directory })
  t.after(() => reopened.close())
  assert.equal(reopened.get('task:one').revision, 1)
  assert.equal(reopened.get('task:failed'), undefined)
  await reopened.create(record('task:failed'))
})

test('corrupt or foreign schemas reject without erasing records and failed opens release the lease', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-collaboration-corrupt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const medium = join(directory, 'collaboration.json')
  const documents = [
    'not json',
    JSON.stringify({ unit: { name: 'collaboration', version: 9 }, tables: { tasks: {} }, global: null }),
    JSON.stringify({ unit: { name: 'collaboration', version: 1 }, tables: { tasks: { 'task:one': { ...record(), revision: -1 } } }, global: null }),
    JSON.stringify({ unit: { name: 'collaboration', version: 1 }, tables: { tasks: { 'wrong-key': record() } }, global: null }),
  ]
  for (const bytes of documents) {
    await writeFile(medium, bytes)
    await assert.rejects(openCollaborationStore(context(), { directory }))
  }
  await rm(medium)
  const repaired = await openCollaborationStore(context(), { directory })
  await repaired.create(record())
  await repaired.close()
  // Removing read access by substituting a directory exercises actual native read failure, even as root.
  const saved = join(directory, 'saved.json')
  await rename(medium, saved); await mkdir(medium)
  await assert.rejects(openCollaborationStore(context(), { directory }))
  await rm(medium, { recursive: true }); await rename(saved, medium)
  const restored = await openCollaborationStore(context(), { directory })
  assert.deepEqual(restored.get('task:one'), record())
  await restored.close()
})

test('JSON dictionary keys roundtrip without silent schema stripping', async t => {
  const { directory, store } = await fixture(t)
  const input = { ...record(), data: JSON.parse('{"__proto__":{"safe":true},"nested":{"__proto__":"literal","constructor":3}}') }
  await store.create(input)
  assert.deepEqual(store.get(input.id), input)
  await store.close()
  const reopened = await openCollaborationStore(context(), { directory })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.get(input.id), input)
})

test('failed runtime startup releases its install-owned native lease and disposal cancels pending startup', async t => {
  for (const mode of ['invalid', 'dispose']) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-startup-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const worker = fork(new URL('./fixtures/collaboration-startup-process.mjs', import.meta.url), [directory, mode], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    t.after(() => { if (worker.exitCode === null) worker.kill('SIGKILL') })
    const exited = once(worker, 'exit')
    const message = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    await exited
    assert.deepEqual(message, { state: 'released' }, mode)
  }
})
