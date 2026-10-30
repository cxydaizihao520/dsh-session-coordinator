import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { Session } from '@deepseek-ai/dsh-session'
import { openCollaborationStore } from '../src/collaboration-store.ts'
import { installCollaboration } from '../src/collaboration-tools.ts'
import { registerCollaborationMaterialTools } from '../src/collaboration-material-tools.ts'

test('registered material tools recover task checkpoints and fork once without copying running authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-material-tools-'))
  const nativeStorage = new Context(); new Storage(nativeStorage)
  const store = await openCollaborationStore(nativeStorage, { directory })
  const tools = new Map(), agents = new Map(); let forks = 0
  const services = { approval: { request: async () => 'allowed-once' }, sessionController: { fork: async () => { forks++; return { sessionId: 'actual-child' } } } }
  const ctx = { agents: { get: id => agents.get(id), list: () => [...agents.values()] }, tools: { register: t => tools.set(t.name, t) },
    get: name => services[name],
    on() { return () => {} }, effect() {}, workspaceRegistry: { list: () => [] } }
  for (const id of ['A', 'B', 'C']) { const session = Session.create(id); agents.set(id, { id, status: 'idle', session, ctx }) }
  agents.get('B').session.append('user/message', { id: 'original', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'current source evidence' }] }, { surfaceOp: 'append' })
  const env = { ctx, registry: { record() {} } }
  const ready = installCollaboration(env, { store }); registerCollaborationMaterialTools(env, ready)
  let call = 0
  const run = (name, args, caller = 'A', callId = 'call-' + ++call) => tools.get('session_coordinator_collaboration_' + name).execute(args, { agent: agents.get(caller), signal: new AbortController().signal, callId })
  try {
    const scope = await run('start', { objective: 'Deliver reviewed work', members: ['B', 'C'] })
    const task = await run('task', { scopeId: scope.id, objective: 'one task', members: ['B'] })
    const common = { scopeId: scope.id, taskId: task.id }
    const checkpoint = await run('material', { ...common, action: 'checkpoint', sourceSessionId: 'member:2', constraints: ['keep source'], decisions: ['use native'], pending: ['verify'] })
    const read = await run('material', { ...common, action: 'read-context', contextId: checkpoint.contextId }, 'B')
    assert.match(read.summary, /verify/)
    assert.equal(read.checkpoint.context.taskRevision, 1)
    await assert.rejects(run('material', { ...common, action: 'read-context', contextId: checkpoint.contextId }, 'C'), error => error.code === 'COLLABORATION_MATERIAL_REJECTED' && /member/.test(error.message))
    const fork = await run('material', { ...common, action: 'fork', sourceSessionId: 'B', atSeq: 0 }, 'A', 'stable-fork')
    assert.equal(fork.sessionId, 'actual-child'); assert.equal(fork.executionAuthority, 'none')
    assert.deepEqual(await run('material', { ...common, action: 'fork', sourceSessionId: 'B', atSeq: 0 }, 'A', 'stable-fork'), fork)
    assert.equal(forks, 1)
    services.sessionController.fork = async () => { forks++; throw new Error('fork acceptance unavailable') }
    await assert.rejects(run('material', { ...common, action: 'fork', sourceSessionId: 'B' }, 'A', 'lost-fork'), /acceptance unavailable/)
    await assert.rejects(run('material', { ...common, action: 'fork', sourceSessionId: 'B' }, 'A', 'lost-fork'), /unknown/)
    assert.equal(forks, 2)
    const status = await run('status', { scopeId: scope.id })
    assert.deepEqual(status.tasks[task.id].members, ['B'])
    assert.deepEqual(status.tasks[task.id].contextIds, [checkpoint.contextId])
    let entered, release
    const started = new Promise(resolve => { entered = resolve }), finish = new Promise(resolve => { release = resolve })
    services.worktrees = { create: async () => { entered(); await finish; return { path: '/scratch/B', repositoryRoot: '/scratch', baseCommit: 'a'.repeat(40), branch: 'work' } } }
    await assert.rejects(run('material', { ...common, action: 'checkpoint', sourceSessionId: 'member:3' }), /outside this task/)
    const worktree = run('material', { ...common, action: 'worktree', sessionId: 'member:2' })
    await started
    const second = await run('task', { scopeId: scope.id, objective: 'another task', members: ['B'] })
    await assert.rejects(run('material', { scopeId: scope.id, taskId: second.id, action: 'worktree', sessionId: 'B' }), /checkout/)
    release(); assert.equal((await worktree).ownerSessionId, 'B')
    assert.equal((await run('status', { scopeId: scope.id })).tasks[task.id].environments.B.path, '/scratch/B')
    await run('control', { ...common, action: 'pause', reason: 'hold' })
    await assert.rejects(run('material', { ...common, action: 'fork', sourceSessionId: 'member:2' }), /active|paused/)
    await run('control', { ...common, action: 'resume', reason: 'Exercise late native fork result' })
    let forkEntered, forkRelease
    const forkStarted = new Promise(resolve => { forkEntered = resolve }), forkGate = new Promise(resolve => { forkRelease = resolve })
    services.sessionController.fork = async () => { forks++; forkEntered(); await forkGate; return { sessionId: 'late-child' } }
    const pendingFork = run('material', { ...common, action: 'fork', sourceSessionId: 'B' }, 'A', 'late-fork')
    await forkStarted
    await run('control', { ...common, action: 'pause', reason: 'Fork already submitted' })
    forkRelease()
    assert.equal((await pendingFork).sessionId, 'late-child')
    const saved = await run('status', { scopeId: scope.id })
    assert.equal(Object.values(saved.tasks[task.id].materialOperations).find(op => op.result?.sessionId === 'late-child').status, 'completed')
    assert.equal(saved.tasks[task.id].state, 'paused')
    await run('control', { ...common, action: 'resume', reason: 'Inspect late fork identity' })
    assert.equal((await run('material', { ...common, action: 'fork', sourceSessionId: 'B' }, 'A', 'late-fork')).sessionId, 'late-child')
    assert.equal(forks, 3)
    let approvalEntered, approvalRelease
    const approvalStarted = new Promise(resolve => { approvalEntered = resolve }), approvalGate = new Promise(resolve => { approvalRelease = resolve })
    services.approval.request = async () => { approvalEntered(); await approvalGate; return 'allowed-once' }
    const awaitingApproval = run('material', { ...common, action: 'fork', sourceSessionId: 'B' }, 'A', 'pre-fork')
    await approvalStarted
    services.approval.request = async () => 'allowed-once'
    await run('control', { ...common, action: 'revise', objective: 'Revised before fork approval', reason: 'Use latest objective' })
    approvalRelease()
    await assert.rejects(awaitingApproval, /changed|revoked/)
    assert.equal(forks, 3)
    let disposeEntered, disposeRelease
    const disposeStarted = new Promise(resolve => { disposeEntered = resolve }), disposeGate = new Promise(resolve => { disposeRelease = resolve })
    services.sessionController.fork = async () => { disposeEntered(); await disposeGate; return { sessionId: 'dispose-child' } }
    const duringDispose = run('material', { ...common, action: 'fork', sourceSessionId: 'B' }, 'A', 'dispose-fork')
    await disposeStarted
    const closing = (await ready).close()
    disposeRelease()
    assert.equal((await duringDispose).sessionId, 'dispose-child')
    await closing
    const reopened = await openCollaborationStore(nativeStorage, { directory })
    try { assert.ok(Object.values(reopened.get(scope.id).data.tasks[task.id].materialOperations).some(op => op.result?.sessionId === 'dispose-child')) }
    finally { await reopened.close() }
  } finally { await (await ready).close(); await rm(directory, { recursive: true, force: true }) }
})


for (const boundary of [{ task: true, action: 'pause' }, { task: false, action: 'pause' }, { task: true, action: 'cancel' }, { task: false, action: 'cancel' }, { task: true, action: 'revise' }, { task: true, action: 'finish' }])
test(`approved ${boundary.task ? 'task' : 'scope'} ${boundary.action} revokes an in-flight native worktree before its side effect`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-material-revoke-'))
  const storage = new Context(); new Storage(storage)
  const store = await openCollaborationStore(storage, { directory })
  const tools = new Map(), agents = new Map(), listeners = new Map(), messages = []
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  let entered, release, mutated = false
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const services = { approval: { request: async () => 'allowed-once' }, worktrees: { async create(_agent, _request, signal) {
    entered(); await gate; signal.throwIfAborted(); mutated = true
    return { path: '/scratch/B', repositoryRoot: '/scratch', baseCommit: 'a'.repeat(40), branch: 'work' }
  } } }
  const ctx = { agents: { get: id => agents.get(id), list: () => [...agents.values()] }, tools: { register: t => tools.set(t.name, t) },
    get: name => services[name], on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => {} }, effect() {}, workspaceRegistry: { list: () => [] } }
  for (const id of ['A', 'B']) agents.set(id, { id, status: 'idle', session: Session.create(id), ctx })
  const delivery = { async deliverScoped(target, message, _caller, options) { options.validate(agents.get(target)); messages.push(message); return { messageId: message.id, sinceSeq: 0 } } }
  const ready = installCollaboration({ ctx, delivery, registry: { record() {} } }, { store }); registerCollaborationMaterialTools({ ctx }, ready)
  let call = 0
  const run = (name, args, callId = 'call-' + ++call, caller = 'A') => tools.get('session_coordinator_collaboration_' + name).execute(args, { agent: agents.get(caller), signal: new AbortController().signal, callId })
  try {
    const scope = await run('start', { objective: 'Stop safely', members: ['B'] })
    const task = await run('task', { scopeId: scope.id, objective: 'Isolate work', members: ['B'] })
    const common = { scopeId: scope.id, taskId: task.id }
    let result
    if (boundary.action === 'finish') {
      const op = await run('send', { ...common, taskRevision: 1, sessionId: 'B', message: 'Review evidence', intent: 'task' })
      const agent = agents.get('B')
      emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
      emit('session/event', agent.session, { type: 'user/message', data: messages.find(message => message.id === op.id) })
      await run('status', { scopeId: scope.id })
      result = await run('result', { ...common, taskRevision: 1, operationId: op.id, text: 'Reviewed and verified' }, undefined, 'B')
      emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
    }
    const operation = run('material', { ...common, action: 'worktree', sessionId: 'B' }, 'stable-worktree')
    await started
    await run('control', { scopeId: scope.id, ...(boundary.task ? { taskId: task.id } : {}), action: boundary.action, reason: 'Stop before mutation', ...(boundary.action === 'revise' ? { objective: 'Corrected task' } : {}), ...(result ? { resultIds: [result.id] } : {}) })
    release()
    await assert.rejects(operation, /revoked|pause|active/)
    assert.equal(mutated, false)
    const status = await run('status', { scopeId: scope.id })
    assert.equal(status.tasks[task.id].environments, undefined)
    assert.equal(Object.values(status.tasks[task.id].materialOperations)[0].status, 'unknown')
    if (boundary.action === 'pause') {
      await run('control', { scopeId: scope.id, ...(boundary.task ? { taskId: task.id } : {}), action: 'resume', reason: 'Inspect retained operation' })
      await assert.rejects(run('material', { ...common, action: 'worktree', sessionId: 'B' }, 'stable-worktree'), /unknown/)
    }
  } finally { release(); await (await ready).close(); await rm(directory, { recursive: true, force: true }) }
})

test('registered material revocation blocks real Git merge and cwd publication across nested awaits', async () => {
  const { execFile, execFileSync } = await import('node:child_process'), { promisify } = await import('node:util')
  const { realpath, writeFile } = await import('node:fs/promises')
  const exec = promisify(execFile)
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-material-git-')))
  const storage = new Context(); new Storage(storage)
  const store = await openCollaborationStore(storage, { directory: join(directory, 'records') })
  const repo = join(directory, 'repo'); const { mkdir } = await import('node:fs/promises'); await mkdir(repo)
  git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, '.gitignore'), '.agents/\n'); await writeFile(join(repo, 'work.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  const tools = new Map(), agents = new Map(), cwds = new Map([['A', repo], ['B', repo], ['C', repo]])
  let enter, release, hold, gateMode, merges = 0
  const gate = mode => { gateMode = mode; hold = new Promise(resolve => { release = resolve }); return new Promise(resolve => { enter = resolve }) }
  const services = {
    approval: { request: async () => 'allowed-once' },
    fs: { resolve: async p => p, processPath: p => p },
    workingDirectory: { ensure: async agent => cwds.get(agent.id), set: async (agent, path) => { cwds.set(agent.id, path); return path } },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: { resolveExecutable: async name => name,
      spawn({ argv, cwd, env, signal }) {
        let stdout = '', stderr = ''
        if (argv.includes('merge')) merges++
        const child = exec(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) }, signal })
        let done = child.then(result => { stdout = result.stdout; stderr = result.stderr; return { exitCode: 0 } }, error => { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; return { exitCode: error.code ?? null } })
        if (gateMode === 'merge' && cwd === repo && argv.at(-1) === 'HEAD') done = done.then(async outcome => { enter(); await hold; return outcome })
        return { done, collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } }, terminate() {},
          async waitForExit() { await done; if (gateMode === 'cwd' && argv.includes('reset')) { enter(); await hold } } }
      } },
  }
  const ctx = { agents: { get: id => agents.get(id), list: () => [...agents.values()] }, tools: { register: tool => tools.set(tool.name, tool) }, get: name => services[name], on() { return () => {} }, effect() {}, workspaceRegistry: { list: () => [] } }
  for (const id of ['A', 'B', 'C']) agents.set(id, { id, status: 'idle', session: Session.create(id), ctx })
  const env = { ctx, registry: { record() {} } }, ready = installCollaboration(env, { store }); registerCollaborationMaterialTools(env, ready)
  let call = 0
  const run = (name, args) => tools.get('session_coordinator_collaboration_' + name).execute(args, { agent: agents.get('A'), signal: new AbortController().signal, callId: 'call-' + ++call })
  try {
    const scope = await run('start', { objective: 'Review isolated changes', members: ['B', 'C'] })
    const task = await run('task', { scopeId: scope.id, objective: 'Change file', members: ['B'] })
    const common = { scopeId: scope.id, taskId: task.id }
    const environment = await run('material', { ...common, action: 'worktree', sessionId: 'B', path: join(repo, '.agents', 'B') })
    await writeFile(join(environment.path, 'work.txt'), 'reviewed change\n'); git(environment.path, 'add', '.'); git(environment.path, 'commit', '-m', 'task change')
    const source = git(environment.path, 'rev-parse', 'HEAD')
    const mergeEntered = gate('merge')
    const integrate = run('material', { ...common, action: 'integrate', sessionId: 'B', expectedSourceCommit: source, expectedTargetCommit: base })
    await mergeEntered
    await run('control', { ...common, action: 'pause', reason: 'Stop before merge' }); release()
    await assert.rejects(integrate, /revoked/)
    assert.equal(merges, 0); assert.equal(git(repo, 'rev-parse', 'HEAD'), base)
    assert.equal(git(environment.path, 'rev-parse', 'HEAD'), source)
    assert.equal(Object.values((await run('status', { scopeId: scope.id })).tasks[task.id].materialOperations).at(-1).status, 'unknown')
    const other = await run('task', { scopeId: scope.id, objective: 'Other isolation', members: ['C'] })
    const cwdEntered = gate('cwd')
    const checkoutPath = join(repo, '.agents', 'C')
    const create = run('material', { scopeId: scope.id, taskId: other.id, action: 'worktree', sessionId: 'C', path: checkoutPath })
    await cwdEntered
    await run('control', { scopeId: scope.id, taskId: other.id, action: 'cancel', reason: 'Stop before cwd publication' }); release()
    await assert.rejects(create, /retained.*revoked/)
    assert.equal(cwds.get('C'), repo)
    assert.equal(git(checkoutPath, 'rev-parse', 'HEAD'), base, 'allocated checkout remains available for reconciliation')
  } finally { release?.(); await (await ready).close(); await rm(directory, { recursive: true, force: true }) }
})
