#!/usr/bin/env node
/**
 * Smoke test for the BUILT bundle (lib/index.js).
 *
 * `check:compat` proves src/ type-checks and that lib/index.js inlined the same
 * DSH version as the installed harness — but neither proves the artifact LOADS.
 * Schema and Session use host peers; the remaining dependencies are inlined.
 * An upstream rename or a broken inline shows up only when the host
 * mounts it. This mounts the built bundle against a stub host context and
 * asserts the full contributed tool set registers, then drives the
 * archive/unarchive handlers through the artifact itself.
 *
 * Runs AFTER `pnpm build` (the artifact must exist). Node type stripping is not
 * needed: the bundle is plain ESM JavaScript.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'index.js')
const pkgManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const mod = await import(pathToFileURL(BUNDLE).href)

const tools = new Map()
const archive = []
const calls = []
const promptSections = []
/** ctx（第一个桩宿主）上注册的斜杠命令：/coordinate 在这里开闸门。 */
const commands1 = []
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool) } },
  // Optional services are mounted through the cordis `ctx.inject(names, cb)` API
  // (the real host always has it; only this stub can lack it). `systemPrompt` is
  // optional: the plugin registers its loop-guard section when, and only when,
  // the service is there — so the stub hands it over and records the section.
  inject: (names, callback) => {
    const child = {}
    if (names.includes('systemPrompt')) {
      child.systemPrompt = { section: (section) => { promptSections.push(section); return () => {} } }
    }
    if (names.includes('commands')) {
      child.commands = { register: (definition) => { commands1.push(definition) } }
    }
    callback(child)
  },
  workspaceRegistry: {
    get archivedSessionIds() { return archive },
    async archiveSession(id, options) {
      calls.push({ verb: 'archive', id, options })
      if (options?.stopActivity !== true) throw new Error('the session is active (turn)')
      archive.push(id)
    },
    async unarchiveSession(id) {
      calls.push({ verb: 'unarchive', id })
      const at = archive.indexOf(id)
      if (at !== -1) archive.splice(at, 1)
    },
  },
  sessionPersistence: { open: async () => ({ header: {}, read: async () => ({ events: [] }), close: async () => {} }) },
  agents: { get: () => undefined, list: () => [] },
  setInterval: () => 0,
  clearInterval: () => {},
  effect: () => {},
}

assert.equal(typeof mod.apply, 'function', 'lib/index.js must export apply()')
mod.apply(ctx)
// BridgeRegistry.load() is fired without await; give it a tick so a failure surfaces here.
await new Promise((done) => setTimeout(done, 50))

// 工具清单的唯一口径是清单文件（dsh.plugin.json 的 contributes.tools）：这里不再
// 维护第二份手写列表——加工具时漏改清单会在这里当场红，而不是等到装进桌面端才发现。
const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8'))
const expected = manifest.contributes?.tools ?? []
assert.ok(expected.length > 0, 'dsh.plugin.json must declare contributes.tools')
assert.deepEqual([...tools.keys()].sort(), [...expected].sort(), 'registered tool set must equal the manifest')
assert.equal(tools.size, expected.length, 'every declared tool must register, and nothing else')

// --- loop guard system prompt section (issue #6) ------------------------------
// The rule text is shared by the tool description and this optional-systemPrompt
// section; the artifact-level contract is that mounting really registers it, and
// that the mounted text carries the default limit and the terminal marker.
assert.equal(promptSections.length, 1, 'apply() must mount exactly one system prompt section')
assert.equal(promptSections[0].name, 'dsh-session-coordinator:hop-rule')
assert.ok(promptSections[0].text.startsWith('会话对象与持续协作'), 'the registered artifact must explain session selection before the scoped legacy hop rule; this does not prove model routing')
assert.match(promptSections[0].text, /hop 2/)
assert.match(promptSections[0].text, /TERMINAL/)

const archiveExec = { agent: { id: 'archive-caller' } }
await commands1.find(c => c.name === 'coordinate').handler({ agent: archiveExec.agent, rawInput: 'on busy busy2' })
await assert.rejects(
  () => tools.get('session_coordinator_archive').execute({ sessionId: 'busy' }, archiveExec),
  (error) => error.message.includes('stopActivity: true'),
)
const archived = await tools.get('session_coordinator_archive').execute({ sessionId: 'busy', stopActivity: true }, archiveExec)
assert.deepEqual(calls.at(-1), { verb: 'archive', id: 'busy', options: { stopActivity: true } })
assert.deepEqual(archived.archivedSessionIds, ['busy'])
assert.deepEqual(JSON.parse(JSON.stringify(archived)), archived)

const unarchived = await tools.get('session_coordinator_unarchive').execute({ sessionId: 'busy' }, archiveExec)
assert.deepEqual(unarchived.archivedSessionIds, [])
assert.equal(unarchived.totalArchived, 0)
assert.deepEqual(JSON.parse(JSON.stringify(unarchived)), unarchived)

// The archive set grows without bound (a long-lived profile holds 200+ ids),
// so the artifact must summarize the set instead of echoing every id, and
// session_coordinator_archived must window it. Both are artifact-level contracts:
// src/ tests cannot catch a bundle that shipped before the fix.
const many = Array.from({ length: 25 }, (_, i) => 's' + String(i))
archive.push(...many)
const big = await tools.get('session_coordinator_archive').execute({ sessionId: 'busy2', stopActivity: true }, archiveExec)
assert.equal(big.totalArchived, 26)
const bigText = tools.get('session_coordinator_archive').output.render({}, big).map((block) => block.text).join('\n')
assert.match(bigText, /total archived: 26/)
assert.match(bigText, /\+6 earlier omitted/)
assert.ok(bigText.includes('busy2'))
assert.ok(!bigText.includes('s4,'))

assert.ok(
  JSON.stringify(tools.get('session_coordinator_archived').parameters ?? {}).includes('limit'),
  'session_coordinator_archived must declare the limit parameter',
)
const windowed = await tools.get('session_coordinator_archived').execute({ limit: 2 }, {})
assert.equal(windowed.total, 26)
assert.deepEqual(windowed.items.map((item) => item.sessionId), ['s24', 'busy2'])
assert.deepEqual(JSON.parse(JSON.stringify(windowed)), windowed)

// --- message receipts (issue #5) ----------------------------------------------
// Artifact-level contract: the read-only three-level receipt query ships in the
// bundle, takes a message identity, and answers 'unknown' — never success —
// when the target log holds no evidence. src/ tests cannot catch a stale bundle.
{
  const receipt = tools.get('session_coordinator_message_status')
  assert.ok(receipt !== undefined, 'session_coordinator_message_status must register')
  const props = receipt.parameters?.properties ?? {}
  assert.ok(props.sessionId !== undefined && props.messageId !== undefined, 'the receipt tool takes sessionId + messageId')
  const value = await receipt.execute({ sessionId: 'no-such-session', messageId: 'no-such-message' }, {})
  assert.equal(value.status, 'unknown')
  const text = receipt.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(text, /未知/)
  assert.ok(!text.includes('已写入') && !text.includes('已进入模型请求'), 'unknown must never render as success')
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
}

// The artifact must not ship a stale DSH copy (the 0.3.3 regression).
assert.ok(!readFileSync(BUNDLE, 'utf8').includes('0.1.7-alpha'), 'lib/index.js must not inline alpha DSH code')

// --- plugin switch + /cot-loop command (0.7.0) --------------------------------
// Two artifact-level contracts: (1) the bundle exports the volatile Config that
// the Plugins settings form renders (dsh-settings only shows volatile fields),
// and (2) the /cot-loop slash command is registered against a host command
// surface, sharing that same config.
assert.ok(mod.Config !== undefined, 'lib/index.js must export Config (the settings form reads it)')
const configJson = mod.Config.toJSON()
const configRoot = configJson.refs?.[String(configJson.uid)] ?? configJson
const configFields = Object.keys(configRoot.dict ?? {})
assert.ok(configFields.includes('loopGuard'), 'Config must expose loopGuard (the settings switch)')
for (const field of configFields) {
  const node = configJson.refs?.[String(configRoot.dict[field])] ?? configRoot.dict[field]
  assert.equal(node.meta?.volatile, true, 'Config.' + field + ' must be volatile so dsh-settings renders it')
}

const commands = []
const switchEdits = []
const tools2 = new Map()
const ctx2 = {
  ...ctx,
  tools: { register: (tool) => { tools2.set(tool.name, tool) } },
  inject: (names, callback) => {
    const child = {}
    if (names.includes('commands')) child.commands = { register: (definition) => { commands.push(definition) } }
    if (names.includes('configEditor')) {
      child.configEditor = {
        entries: () => [{ options: { id: 'dsh-session-coordinator' } }],
        edit: async (entry, change) => { switchEdits.push(change({}, {})) },
      }
    }
    if (names.includes('systemPrompt')) {
      child.systemPrompt = { section: (section) => { promptSections.push(section); return () => {} } }
    }
    callback(child)
  },
}
mod.apply(ctx2, { loopGuard: false })
await new Promise((done) => setTimeout(done, 50))

assert.equal(commands.length, 2, 'apply() must register /cot-loop and /coordinate when the host has a command surface')
assert.deepEqual(commands.map((c) => c.name).sort(), ['coordinate', 'cot-loop'])
const cotLoop = commands.find((c) => c.name === 'cot-loop')
const coordinate = commands.find((c) => c.name === 'coordinate')
assert.ok(String(cotLoop.input?.hint ?? '').includes('off'), 'the command advertises its input')
const switchStatus = await cotLoop.handler({ rawInput: 'status' })
assert.equal(switchStatus.kind, 'success')
assert.ok(switchStatus.text.includes('关闭'), 'status must report the configured switch state (off)')
assert.ok(switchStatus.text.includes('loopGuard'), 'status must name the settings field')

const switchOn = await cotLoop.handler({ rawInput: 'on' })
assert.equal(switchOn.kind, 'success')
assert.deepEqual(switchEdits.at(-1), { loopGuard: true }, 'the command writes loopGuard into the plugin config')
assert.ok(switchOn.text.includes('已写入插件配置'), 'a persisted switch says so')

// The disabled plugin switch must show up on the monitor surface (and, in the
// guard itself, short-circuit loop detection for every monitor).
const grant2 = await coordinate.handler({ agent: { id: 'switch-caller' }, rawInput: 'on switch-target' })
assert.equal(grant2.kind, 'success')
const switchStarted = await tools2.get('session_coordinator_monitor_start').execute(
  { sessionId: 'switch-target' },
  { agent: { id: 'switch-caller' } },
)
assert.equal(switchStarted.monitor.config.sessionId, 'switch-target')
const switchText = tools2.get('session_coordinator_monitor_list').output
  .render({}, await tools2.get('session_coordinator_monitor_list').execute({}, {}))
  .map((block) => block.text).join('\n')
assert.ok(switchText.includes('plugin switch'), 'monitor_list shows the plugin-level switch is off')

const bundleWithSwitch = readFileSync(BUNDLE, 'utf8')
for (const marker of ['cot-loop', '思维链循环自动中断', 'volatile']) {
  assert.ok(bundleWithSwitch.includes(marker), 'the rebuilt bundle must inline the switch wiring: ' + marker)
}

// --- chain-of-thought loop guard (0.6.0) -------------------------------------
// Two artifact-level contracts that src/ tests cannot prove: (1) the bundle that
// actually runs was REBUILT with the guard, and (2) the new knobs are exposed on
// the tool the host reads. The stub host above deliberately has no
// agents.roots()/isOwnedBy() — the guard must degrade gracefully there, which is
// also the case for older harnesses.
const monitorTool = tools.get('session_coordinator_monitor_start')
const monitorParams = JSON.stringify(monitorTool.parameters ?? {})
// issue #3 契约：replyTo 只属于 send；create 不得声明它（曾误挂在 create 上）
{
  const send = tools.get('session_coordinator_send')
  const create = tools.get('session_coordinator_create')
  assert.ok(send !== undefined && create !== undefined, 'send/create tools registered')
  const sendProps = send.parameters?.properties ?? {}
  const createProps = create.parameters?.properties ?? {}
  assert.ok(sendProps.replyTo !== undefined, 'session_coordinator_send must declare replyTo')
  assert.ok(sendProps.mode !== undefined, 'session_coordinator_send must declare mode')
  assert.equal(createProps.replyTo, undefined, 'session_coordinator_create must not declare replyTo')
  // issue #6 契约：规则文本必须真的在产物里的工具描述上（模型读的是 description，
  // 不是源码），并且与系统提示段同源 —— 后者由上面的 promptSections 断言锁定。
  const sendDescription = String(send.description ?? '')
  for (const marker of ['Loop guard', 'hop 2', 'TERMINAL', 'replyTo']) {
    assert.ok(sendDescription.includes(marker), 'session_coordinator_send description must carry the loop rule: ' + marker)
  }
}

for (const name of [
  'loopGuard', 'loopField', 'loopMinCycles', 'loopMinRepeats', 'loopMinConfidence', 'loopMinHits',
  'loopCooldownMs', 'loopMaxTransfers', 'loopTransfer', 'loopAutoMonitor', 'loopDescendants',
  'loopHandoffPrompt', 'loopTransferDepth',
]) {
  assert.ok(monitorParams.includes(name), 'session_coordinator_monitor_start must declare ' + name)
}
assert.ok(String(monitorTool.description).includes('chain-of-thought LOOPS'), 'the tool description advertises loop detection')
const bundleText = readFileSync(BUNDLE, 'utf8')
for (const marker of ['chain-of-thought loop detected', 'LOOP-TRANSFER', 'LOOP-SUBAGENT-CANCEL', 'transfer budget exhausted', '仍在运行的子代理']) {
  assert.ok(bundleText.includes(marker), 'the rebuilt bundle must inline the loop guard: ' + marker)
}

// 授权闸门（coordinate.ts）在产物里必须真的接线：未授权先拒，`/coordinate on` 之后再放行。
const SMOKE_SESSION = 'smoke-caller'
const coordinate1 = commands1.find((command) => command.name === 'coordinate')
assert.ok(coordinate1 !== undefined, 'the artifact must register /coordinate on the mounted host')
await assert.rejects(
  () => monitorTool.execute({ sessionId: 'loop-target' }, { agent: { id: SMOKE_SESSION } }),
  /not authorized to coordinate other sessions/,
  'the artifact must refuse cross-session actions without a user grant',
)
const grant = await coordinate1.handler({ agent: { id: SMOKE_SESSION }, rawInput: 'on loop-target' })
assert.equal(grant.kind, 'success')
assert.ok(grant.text.includes('/coordinate off'), 'the grant explains how to revoke it')

const started = await monitorTool.execute({ sessionId: 'loop-target', loopDescendants: 'report', loopMaxTransfers: 2 }, { agent: { id: SMOKE_SESSION } })
assert.equal(started.monitor.config.loopDescendants, 'report')
assert.equal(started.monitor.config.loopMaxTransfers, 2)
const monitorText = tools.get('session_coordinator_monitor_list').output.render({}, await tools.get('session_coordinator_monitor_list').execute({}, {})).map((block) => block.text).join('\n')
assert.ok(monitorText.includes('loopGuard: on'), 'monitor_list renders the loop guard line')
assert.ok(monitorText.includes('descendants=report'))
assert.equal(await tools.get('session_coordinator_monitor_stop').execute({ sessionId: 'loop-target' }, { agent: { id: SMOKE_SESSION } }).then((value) => value.wasActive), true)

// --- client half (issue #4) ---------------------------------------------------
// The client half is a hand-written browser artifact (no bundler), so the
// artifact-level question is not "is the build fresh" but "does the package ship
// a loadable client module, under the package name, writing the host's header".
const clientRel = pkgManifest.exports?.['./client']
assert.equal(typeof clientRel, 'string', 'package.json must export "./client"')
assert.equal(pkgManifest.dsh?.client?.platform, 'web', 'dsh.client.platform must be "web"')
const clientFile = join(ROOT, clientRel)
const clientSource = readFileSync(clientFile, 'utf8')

// Browser-only: a node builtin here would break the page, not the host.
for (const banned of ['node:', 'process.env', 'require("fs")', "require('fs')"]) {
  assert.ok(!clientSource.includes(banned), 'the client artifact must not reach for ' + banned)
}

const clientEntry = (() => {
  let entry
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { entry = value } } },
    console: { log() {}, error() {}, warn() {} },
    crypto: { randomUUID: () => 'smoke-uuid' },
  }
  vm.runInNewContext(clientSource, sandbox, { filename: clientFile })
  return entry
})()
assert.ok(clientEntry !== undefined, 'the client artifact must call window.__ModuleLoader__.load')
assert.equal(clientEntry.id, pkgManifest.name, 'the client module id must equal the package name')
const clientMod = clientEntry.factory((spec) => {
  assert.equal(spec, 'react', 'the client artifact may only require react, got ' + spec)
  return {
    createElement: () => null,
    useSyncExternalStore: () => null,
    useMemo: (fn) => fn(),
    useRef: () => ({}),
    useEffect: () => {},
    useCallback: (fn) => fn(),
  }
})
assert.equal(typeof clientMod.apply, 'function', 'the client module must export apply()')
assert.deepEqual([...clientMod.inject].sort(), ['locale', 'remote', 'remote.commands', 'slots'])
// 正文首行是宿主侧职责：两个产物必须写出同一行（逐字比对在 test-client-bundle.mjs）。
assert.ok(clientSource.includes('remote.commands.execute'))
assert.equal(clientMod.formatSourceLine, undefined)
assert.ok(bundleWithSwitch.includes('回信请发给它'), 'the host bundle must inline the same header text')
for (const slot of ['conversation.input.left', 'conversation.input.overlay']) {
  assert.ok(clientSource.includes(slot), 'the client artifact must register into ' + slot)
}
assert.ok(!clientSource.includes('dsh-session:'), 'the client artifact must never serialize a dsh-session mention')

console.log('smoke-bundle: OK — lib/index.js mounts and registers ' + String(tools.size) + ' tools')
console.log('smoke-bundle: OK — client half ' + clientRel + ' loads as ' + clientEntry.id)
