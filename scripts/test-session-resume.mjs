import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resumeBridgeSession } from '../src/session-create.ts'

function harness(options = {}) {
  const calls = [], records = [], mounts = [], hooks = new Map(), checks = [], live = new Map()
  let disposed = 0
  const header = { id: 'B', cwd: '/target', createdAt: 1, ...(options.header ?? {}) }
  const requestHeader = { config: { provider: 'target-provider', model: 'target-model', reasoningEffort: 'target-effort' }, ...(options.requestHeader ?? {}) }
  const events = options.events ?? [{ type: 'request/header', data: { header: requestHeader } }]
  const projections = options.projections ?? { values: { agentPreset: 'target-preset', modelSelection: { lastUsed: requestHeader.config, next: requestHeader.config } } }
  const agentCtx = { on(name, hook) { hooks.set(name, hook); return () => {} } }
  const agent = { id: 'B', ctx: agentCtx, session: { header, requestHeader: () => options.resumedHeader ?? requestHeader, snapshotEvents: () => events }, status: 'idle' }
  const ctx = {
    get: name => name === 'sessionQuery' ? { async observeSession(id) { assert.equal(id, 'B'); return { header, events, projections, [Symbol.dispose]() { disposed++ } } } }
      : name === 'llm' ? { async resolveCallConfig(selection) { checks.push(selection); if (options.invalidModel) throw new Error('native unsupported model') } }
      : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
      : name === 'sessionProjections' ? { stateOf: () => options.modelState ?? { pending: null } }
      : name === 'agentPresets' ? ctx.agentPresets : undefined,
    typert: { lookups: { get() { return options.noResolver ? undefined : { async resolve(id) { if (options.resolverError) throw new Error('native policy refused'); if (options.desktopResolver) { live.set(id, agent); return agent } } } } } },
    agents: { get: id => live.get(id), async resume(args) { calls.push(args); await options.beforeResume?.(); await args.setup?.(agentCtx, agent); live.set('B', agent); return { agent } } },
    agentPresets: { async resolve(id) { assert.equal(id, 'target-preset'); return { id } }, async mount(_ctx, id) { assert.equal(live.size, 0, 'mount before publication'); mounts.push(id); if (options.invalidPreset) throw new Error('preset missing') } },
    sessionPersistence: { async list() { return [{ header }] } },
    workspaceRegistry: { list: () => [], resolveByPath: async () => undefined },
  }
  const registry = { record: value => records.push(value), touch() {} }
  return { ctx, calls, records, mounts, checks, get disposed() { return disposed },
    run: args => resumeBridgeSession(ctx, registry, { sessionId: 'B', ...args }),
    async selected() {
      assert.ok(hooks.has('system-prompt/assemble'), 'official installModelSelection must couple prompt and request')
      const assembly = await hooks.get('system-prompt/assemble')({}, {}, async () => ({ variables: {} }))
      const request = await hooks.get('agent/request')({}, async () => ({ provider: 'caller', model: 'caller', reasoningEffort: 'caller-effort' }))
      return { variables: assembly.variables, request }
    },
  }
}

test('live-only native lookup falls back to an unpublished resume with target model and preset', async () => {
  const h = harness(); await h.run()
  assert.equal(h.calls.length, 1); assert.deepEqual(h.mounts, ['target-preset']); assert.equal(h.disposed, 1)
  assert.deepEqual((await h.selected()).request, { provider: 'target-provider', model: 'target-model', reasoningEffort: 'target-effort' })
  assert.equal(h.records[0].source, 'resume')
})

test('desktop native resolver is used without double mounting or fallback; refusal never bypasses it', async () => {
  const h = harness({ desktopResolver: true }); await h.run(); assert.equal(h.calls.length, 0); assert.deepEqual(h.mounts, [])
  const refused = harness({ resolverError: true }); await assert.rejects(refused.run(), /native policy refused/); assert.equal(refused.calls.length, 0)
})

test('pending native model selection wins and adapter-default effort is not promoted to explicit selection', async () => {
  const pending = harness({ projections: { values: { agentPreset: 'target-preset', modelSelection: { lastUsed: null, next: { provider: 'selected', model: 'next-model' } } } }, modelState: { pending: { provider: 'selected', model: 'next-model' } } })
  await pending.run(); assert.deepEqual((await pending.selected()).request, { provider: 'selected', model: 'next-model' })
  const defaults = harness({ requestHeader: { adapterDefaults: { reasoningEffort: true } } })
  await defaults.run(); assert.deepEqual((await defaults.selected()).request, { provider: 'target-provider', model: 'target-model' })
})

test('explicit resume override still mounts the original target preset and couples prompt routing', async () => {
  const h = harness(); await h.run({ provider: 'new-provider', model: 'new-model', reasoningEffort: 'custom-effort' })
  assert.deepEqual(h.mounts, ['target-preset'])
  assert.deepEqual((await h.selected()).request, { provider: 'new-provider', model: 'new-model', reasoningEffort: 'custom-effort' })
  assert.deepEqual(h.checks, [{ provider: 'new-provider', model: 'new-model', reasoningEffort: 'custom-effort' }])
})

test('preset and capability failures do not publish or record a partially composed target', async () => {
  for (const options of [{ invalidPreset: true }, { invalidModel: true }]) {
    const h = harness(options); await assert.rejects(h.run(), /preset missing|native unsupported/)
    assert.equal(h.ctx.agents.get('B'), undefined); assert.deepEqual(h.records, []); assert.equal(h.disposed, 1)
  }
})

test('pending selection without its projection and subagent ownership fail closed without resume', async () => {
  const unprojected = harness({ projections: { values: { agentPreset: 'target-preset' } }, events: [{ type: 'model/selection', data: { provider: 'pending', model: 'pending' } }] })
  await assert.rejects(unprojected.run(), /model.selection.*projection/i); assert.equal(unprojected.calls.length, 0); assert.equal(unprojected.disposed, 1)
  const child = harness({ header: { origin: 'subagent' } }); await assert.rejects(child.run(), /subagent/); assert.equal(child.calls.length, 0)
})

test('preset-free headless uses its persisted target route without inventing a default preset', async () => {
  const h = harness({ projections: { values: {} } })
  await h.run(); assert.deepEqual(h.mounts, []); assert.equal((await h.selected()).request.provider, 'target-provider')
})

test('unpublished resumed Session header wins over a stale preflight observation', async () => {
  const h = harness({ resumedHeader: { config: { provider: 'latest-provider', model: 'latest-model', reasoningEffort: 'latest-effort' }, adapterDefaults: { reasoningEffort: true } } })
  await h.run(); assert.deepEqual((await h.selected()).request, { provider: 'latest-provider', model: 'latest-model' })
})

test('concurrent same-target cold resumes share one writer; conflicting model overrides refuse and failure releases the slot', async () => {
  let release
  const h = harness({ beforeResume: () => new Promise(resolve => { release = resolve }) })
  const first = h.run(), same = h.run()
  await assert.rejects(h.run({ model: 'another' }), /already pending/)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  release(); await Promise.all([first, same]); assert.equal(h.calls.length, 1); assert.equal(h.mounts.length, 1)
  const options = { invalidModel: true }, failed = harness(options)
  await assert.rejects(failed.run(), /native unsupported/); options.invalidModel = false
  await failed.run(); assert.equal(failed.calls.length, 2)
})

test('installed native projection wire next and internal pending remain distinct during resume setup', { skip: !existsSync(fileURLToPath(new URL('../tools/asar.mjs', import.meta.url))) || !existsSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar') }, async () => {
  // Execute the installed official projection; do not recreate its reducer or wire shape in the test.
  let source = execFileSync(process.execPath, [fileURLToPath(new URL('../tools/asar.mjs', import.meta.url)), 'cat', '/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js'], { encoding: 'utf8' })
  source = source.replace("from 'zod'", 'from ' + JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod')).href))
  const native = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  let definition
  native.installModelSelectionProjection({ sessionProjections: { register(value) { definition = value } } })
  const config = { provider: 'target-provider', model: 'target-model', reasoningEffort: 'target-effort' }
  const header = { config, adapterDefaults: { reasoningEffort: true } }
  for (const selected of [{ provider: 'pending-provider', model: 'pending-model' }, config]) {
    const events = [{ type: 'request/header', data: { header } }, { type: 'model/selection', data: selected }]
    const state = definition.stateSchema.parse(events.reduce((state, event) => definition.apply(state, event), definition.init()))
    const wire = definition.wire.viewSchema.parse(definition.wire.view(state))
    assert.equal(wire.pending, undefined); assert.deepEqual(wire.next, selected)
    const h = harness({ events, requestHeader: header, projections: { values: { agentPreset: 'target-preset', modelSelection: wire } }, modelState: state })
    await h.run(); assert.deepEqual((await h.selected()).request, selected, 'use native state pending, including an explicit effort equal to the previous adapter default')
  }
})
