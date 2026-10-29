#!/usr/bin/env node
/** Shared creation primitive regression (model/preset/workspace setup).
 * Public one-call authorization and delivery are covered by test-single-delegation.mjs.
 */
import assert from 'node:assert/strict'
import { createBridgeSession } from '../src/session-create.ts'
import { Context } from 'cordis'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name)
    console.error('     ' + (error instanceof Error ? error.message : String(error)))
  }
}

function tolerantCtx() {
  const target = {}
  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop === 'then') return undefined
      if (!(prop in obj)) obj[prop] = () => undefined
      return obj[prop]
    },
  })
}

const WS = { id: 'ws-1', path: 'D:/ws-one', sessionIds: [] }

function harness(options = {}) {
  const registered = new Map()
  const events = []
  const createCalls = []
  const records = []
  const touches = []
  const composed = []
  const mounted = []
  const followups = []
  const attached = []
  const renamed = []
  const modelChecks = []
  const llm = new LlmRuntime(new Context())
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model, signal) {
      modelChecks.push({ provider, model })
      await options.onModelLookup?.(signal)
      return { provider, id: model, name: model, ...(model === 'plain' ? {} : { reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }, { id: 'provider-defined', name: 'Provider-defined' }], defaultEffort: 'low' } }) }
    }
    async *stream() { throw new Error('capability validation must not call the model') }
  }
  llm.registerAdapter(['caller-provider', 'p2', 'fixture'], new FixtureAdapter())

  const agent = {
    id: 'sb-stub',
    status: 'running',
    options: {},
    ctx: tolerantCtx(),
    session: {
      // callerCwd: null → 这个会话没有记录工作目录（覆盖「不许猜」的拒绝路径）
      header: options.callerCwd === null ? {} : { cwd: options.callerCwd ?? 'D:/caller' },
      snapshotEvents: () => events,
      requestHeader: () => ({ config: { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'high' } }),
    },
    followup(message) {
      followups.push(message)
      // Simulate the model answering the first prompt: the tool's wait must see a
      // NEW event after the baseline it captured before the prompt was sent.
      events.push({ seq: events.length, time: Date.now(), type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'pong' }] } } })
    },
  }

  const ctx = {
    get: (name) => name === 'llm' ? options.modelValidationUnavailable ? undefined : llm : name === 'sessionTitle' && options.nativeTitles
      ? { rename(session, title) { if (options.titleError) throw new Error('native title unavailable'); renamed.push({ session, title }); assert.equal(followups.length, 0, 'title precedes first prompt') } }
      : undefined,
    tools: { register: (tool) => { registered.set(tool.name, tool) } },
    agents: {
      get: () => undefined,
      list: () => [],
      create: async (createOptions) => {
        createCalls.push(createOptions)
        if (typeof createOptions.setup === 'function') await createOptions.setup(tolerantCtx())
        return { agent }
      },
    },
    workspaceRegistry: {
      get: (id) => (id === WS.id ? WS : undefined),
      list: () => [WS],
      resolveByPath: async (cwd) => (cwd === WS.path
        ? { id: WS.id, path: WS.path, attachSession: async (sessionId) => { attached.push(sessionId) } }
        : undefined),
    },
    agentPresets: {
      composedPreset: () => options.inheritedPreset,
      composeFrom: (_agentCtx, parentCtx) => { composed.push(parentCtx); return options.joinedPreset ?? options.inheritedPreset },
      mount: async (_agentCtx, id) => { mounted.push(id) },
    },
    sessionPersistence: { open: async () => { throw new Error('not used') } },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = {
    record(entry) { records.push(entry) },
    touch(id) { touches.push(id) },
    all: async () => [],
    load: async () => {},
    persist: async () => {},
  }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  return {
    agent, events, createCalls, records, touches, composed, mounted, followups, attached, renamed, modelChecks,
    async run(args, withCaller = true) {
      const created = await createBridgeSession(ctx, registry, { ...args,
        ...(withCaller ? { caller: { ctx: tolerantCtx(), session: agent.session } } : {}) })
      return { ...created, title: args.title, sinceSeq: created.baselineSeq }
    },
  }
}

// --- creation contract ---------------------------------------------------------
await test('create: native model validation rejects unsupported effort before agent creation', async () => {
  const h = harness()
  await assert.rejects(h.run({ cwd: 'D:/target', provider: 'fixture', model: 'plain', reasoningEffort: 'medium' }, false), error => error.code === 'UNSUPPORTED_REASONING_EFFORT')
  assert.equal(h.createCalls.length, 0); assert.equal(h.records.length, 0); assert.equal(h.followups.length, 0)
})

await test('create: provider-defined effort stays exact and native defaults are not adopted', async () => {
  const explicit = harness()
  await explicit.run({ cwd: 'D:/target', provider: 'fixture', model: 'reasoning', reasoningEffort: 'provider-defined' }, false)
  assert.equal(explicit.createCalls[0].agentOptions.reasoningEffort, 'provider-defined')
  const inherited = harness()
  await inherited.run({ cwd: 'D:/target', provider: 'fixture', model: 'reasoning' }, false)
  assert.deepEqual(inherited.createCalls[0].agentOptions, { provider: 'fixture', model: 'reasoning' })
  assert.equal(inherited.modelChecks.length, 1)
})

await test('create: selected routes require validation support, while host defaults stay compatible', async () => {
  const missing = harness({ modelValidationUnavailable: true })
  await assert.rejects(missing.run({ cwd: 'D:/target', provider: 'fixture', model: 'plain' }, false), /capability validation is unavailable/)
  assert.equal(missing.createCalls.length, 0)
  await missing.run({ cwd: 'D:/target' }, false)
  assert.equal(missing.createCalls.length, 1)
})

await test('create: cancellation during native capability lookup creates nothing', async () => {
  const controller = new AbortController()
  const h = harness({ onModelLookup() { controller.abort() } })
  await assert.rejects(h.run({ cwd: 'D:/target', provider: 'fixture', model: 'plain', signal: controller.signal }, false), error => error.name === 'AbortError')
  assert.equal(h.createCalls.length, 0); assert.equal(h.followups.length, 0)
})

await test('create: native title is applied to the exact new session before its prompt', async () => {
  const h = harness({ nativeTitles: true })
  await h.run({ cwd: 'D:/target', title: '  可见协作者  ', prompt: '执行任务' })
  assert.deepEqual(h.renamed, [{ session: h.agent.session, title: '可见协作者' }])
  assert.equal(h.records[0].title, '可见协作者')
})

await test('create: title failure leaves the known creation discoverable without dispatching', async () => {
  const h = harness({ nativeTitles: true, titleError: true })
  await assert.rejects(h.run({ cwd: 'D:/target', title: '任务会话', prompt: '执行任务' }), /native title unavailable/)
  assert.equal(h.records[0].sessionId, h.createCalls[0].sessionId)
  assert.equal(h.followups.length, 0)
})

await test('create: cwd target, first prompt, anchor and registry record', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target', prompt: '做 X', title: '任务会话' })
  assert.match(created.sessionId, /^sb-/)
  assert.equal(created.cwd, 'D:/target')
  assert.equal(created.title, '任务会话')
  // The anchor is the maxSeq captured BEFORE the prompt; a brand-new session has an
  // empty log, so maxSeq is -1 — the same "count every event from the start" sentinel
  // session_coordinator_wait documents.
  assert.equal(created.sinceSeq, -1)
  assert.equal(created.reply, undefined, 'waitForReply defaults to false')

  assert.equal(h.createCalls.length, 1)
  assert.equal(h.createCalls[0].sessionId, created.sessionId)
  assert.equal(h.createCalls[0].meta.cwd, 'D:/target')
  assert.deepEqual(h.createCalls[0].meta.agentPreset, undefined)
  assert.equal(h.followups.length, 1, 'first prompt delivered once')
  assert.deepEqual(h.followups[0].content, [{ type: 'text', text: '做 X' }])
  assert.deepEqual(h.touches, [created.sessionId])
  assert.equal(h.records.length, 1)
  assert.equal(h.records[0].sessionId, created.sessionId)
  assert.equal(h.records[0].source, 'create')
  assert.equal(h.records[0].title, '任务会话')
  assert.equal(h.records[0].cwd, 'D:/target')
})

await test('create: no prompt means no followup, no anchor and no touch', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target' })
  assert.equal(h.followups.length, 0)
  assert.equal(h.touches.length, 0)
  assert.equal(created.sinceSeq, undefined, 'nothing was sent, so there is no anchor')
  assert.equal(JSON.parse(JSON.stringify(created)).sinceSeq, undefined)
})

await test('create: an empty prompt is treated as no prompt', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target', prompt: '   ' })
  assert.equal(h.followups.length, 0)
  assert.equal(created.sinceSeq, undefined)
})

await test('create: workspace accounting follows the resolved cwd', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/ws-one' })
  assert.equal(created.workspaceId, 'ws-1')
  assert.deepEqual(h.attached, [created.sessionId], 'session attached to its workspace')
  assert.equal(h.records[0].workspaceId, 'ws-1')
})

await test('create: workspaceId resolves to the workspace path', async () => {
  const h = harness()
  const created = await h.run({ workspaceId: 'ws-1' })
  assert.equal(created.cwd, 'D:/ws-one')
  assert.equal(created.workspaceId, 'ws-1')
})

await test('create: an unknown workspaceId is rejected before creating anything', async () => {
  const h = harness()
  await assert.rejects(() => h.run({ workspaceId: 'nope' }), /workspace not found: nope/)
  assert.equal(h.createCalls.length, 0)
})

await test('create: with no target and no caller cwd it refuses to guess', async () => {
  const h = harness({ callerCwd: null })
  await assert.rejects(() => h.run({}), /cannot determine target working directory/)
  assert.equal(h.createCalls.length, 0)
})

// --- model / preset inheritance ------------------------------------------------
await test('create: model selection is inherited from the caller conversation', async () => {
  const h = harness()
  await h.run({ cwd: 'D:/target' }, true)
  assert.deepEqual(h.createCalls[0].agentOptions, { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'high' })
  assert.equal(h.composed.length, 1, 'caller presets are composed when no explicit preset is requested')
  assert.deepEqual(h.mounted, [])
})

await test('create: explicit model overrides beat the caller conversation', async () => {
  const h = harness()
  await h.run({ cwd: 'D:/target', provider: 'p2', model: 'm2', reasoningEffort: 'low' }, true)
  assert.deepEqual(h.createCalls[0].agentOptions, { provider: 'p2', model: 'm2', reasoningEffort: 'low' })
})

await test('create: an explicit agentPreset is mounted instead of joining the caller', async () => {
  const h = harness({ inheritedPreset: 'inherited' })
  await h.run({ cwd: 'D:/target', agentPreset: 'reviewer' }, true)
  assert.equal(h.createCalls[0].meta.agentPreset, 'reviewer')
  assert.deepEqual(h.mounted, ['reviewer'])
  assert.equal(h.composed.length, 0, 'an explicit preset must not also join the caller composition')
})

await test('create: implicitly inherited preset identity is durable while setup still joins the retained revision', async () => {
  const h = harness({ inheritedPreset: 'inherited' })
  await h.run({ cwd: 'D:/target' }, true)
  assert.equal(h.createCalls[0].meta.agentPreset, 'inherited')
  assert.equal(h.composed.length, 1); assert.deepEqual(h.mounted, [])
  const changed = harness({ inheritedPreset: 'inherited', joinedPreset: 'changed' })
  await assert.rejects(changed.run({ cwd: 'D:/target' }, true), /preset changed/)
  assert.equal(changed.records.length, 0); assert.equal(changed.followups.length, 0)
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)
