import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCollaborationWorktree, inspectCollaborationWorktree, integrateCollaborationWorktree } from '../src/collaboration-environment.ts'

const exec = promisify(execFile)
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('parallel task checkout uses a pinned commit and leaves source changes in their original checkout', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-')))
  try {
    git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
    await writeFile(join(repo, '.gitignore'), '.agents/\n')
    await writeFile(join(repo, 'work.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    await writeFile(join(repo, 'work.txt'), 'source dirty\n')
    let cwd = repo
    const agent = { id: 'B', session: { header: { cwd: repo } } }
    const services = {
      fs: { resolve: async p => p, processPath: p => p },
      workingDirectory: { ensure: async () => cwd, set: async (_a, path) => { cwd = path; return path } },
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
      subprocess: {
        resolveExecutable: async name => name,
        spawn({ argv, cwd, env, signal }) {
          let stdout = '', stderr = ''
          const child = exec(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) }, signal })
          const done = child.then(r => { stdout = r.stdout; stderr = r.stderr; return { exitCode: 0 } }, e => { stdout = e.stdout ?? ''; stderr = e.stderr ?? ''; return { exitCode: e.code ?? null } })
          return { done, collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } }, terminate() {}, waitForExit: () => done }
        },
      },
    }
    const ctx = { get: name => services[name] }
    const record = await createCollaborationWorktree(ctx, agent, { taskId: 'task-1', integrationOwnerSessionId: 'A', name: 'task-change', path: join(repo, '.agents', 'task-1') })
    assert.equal(record.baseCommit, base)
    assert.equal(git(record.path, 'branch', '--show-current'), 'task-change')
    assert.equal(record.ownerSessionId, 'B'); assert.equal(record.integrationOwnerSessionId, 'A')
    assert.equal(await readFile(join(record.path, 'work.txt'), 'utf8'), 'base\n')
    assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'source dirty\n')
    assert.equal((await inspectCollaborationWorktree(ctx, agent, record)).dirty, false)
    await writeFile(join(record.path, 'work.txt'), 'task change\n')
    assert.equal((await inspectCollaborationWorktree(ctx, agent, record)).dirty, true)
    await assert.rejects(inspectCollaborationWorktree(ctx, { ...agent, id: 'C' }, record), /owner/)
    git(record.path, 'add', '.'); git(record.path, 'commit', '-m', 'task result')
    const sourceCommit = git(record.path, 'rev-parse', 'HEAD')
    cwd = repo
    const integrator = { id: 'A', session: { header: { cwd: repo } } }
    const request = { expectedSourceCommit: sourceCommit, expectedTargetCommit: base }
    await assert.rejects(integrateCollaborationWorktree(ctx, agent, record, request), /integration owner/)
    await assert.rejects(integrateCollaborationWorktree(ctx, integrator, record, request), /clean/)
    git(repo, 'restore', 'work.txt')
    const integration = await integrateCollaborationWorktree(ctx, integrator, record, request)
    assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'task change\n')
    assert.equal(integration.sourceCommit, sourceCommit)
    assert.equal(integration.validation, 'required')
  } finally { await rm(repo, { recursive: true, force: true }) }
})
