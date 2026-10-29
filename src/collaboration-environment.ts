import { isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MaterialContext } from './collaboration-materials.ts'

export interface EnvironmentAgent { id: string; session: { header: { cwd?: string } } }
export interface CollaborationWorktree {
  taskId: string
  ownerSessionId: string
  integrationOwnerSessionId: string
  path: string
  repositoryRoot: string
  baseCommit: string
  branch?: string
}
export interface CreateCollaborationWorktree {
  taskId: string
  integrationOwnerSessionId: string
  from?: string
  name?: string
  /** An explicit path uses the sandboxed Git fallback; otherwise prefer the native service. */
  path?: string
}
interface WorkingDirectory {
  ensure(agent: EnvironmentAgent, signal?: AbortSignal): Promise<string>
  set(agent: EnvironmentAgent, path: string, signal?: AbortSignal): Promise<string>
}
interface Captured { readFrom(offset: number): { text: string; lossy: boolean } }
interface Subprocess {
  resolveExecutable(name: string, cwd: undefined, signal: AbortSignal): Promise<string>
  spawn(options: { argv: readonly string[]; cwd: string; env: Record<string, string | undefined>; signal: AbortSignal; graceMs: number; stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } } }): {
    done: Promise<{ exitCode: number | null; signal?: string }>
    collected: { stdout: Captured; stderr: Captured }
    terminate(): void
    waitForExit(): Promise<unknown>
  }
}

const GIT_ENV = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE'].map(key => [key, undefined]))

function service<T>(ctx: MaterialContext, name: string): T {
  const value = ctx.get(name)
  if (value === undefined) throw new Error(`Environment capability unavailable: ${name}`)
  return value as T
}

/** Use the same execution world and sandbox contract as native worktrees; never shell-evaluate args. */
async function git(ctx: MaterialContext, agent: EnvironmentAgent, cwd: string, args: string[], signal?: AbortSignal, allowed = [0], env: Record<string, string> = {}): Promise<string> {
  const subprocess = service<Subprocess>(ctx, 'subprocess')
  const policy = service<{ resolve(input: { session: EnvironmentAgent['session'] }): { mode: string } }>(ctx, 'sandboxPolicy').resolve({ session: agent.session })
  const runSignal = signal === undefined ? AbortSignal.timeout(60_000) : AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  runSignal.throwIfAborted()
  const command = [await subprocess.resolveExecutable('git', undefined, runSignal), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]
  const argv = policy.mode === 'danger-full-access' ? command : (await service<{ confine(argv: string[], policy: { mode: string }, signal: AbortSignal): Promise<{ argv: string[] }> }>(ctx, 'sandbox').confine(command, policy, runSignal)).argv
  runSignal.throwIfAborted()
  const child = subprocess.spawn({ argv, cwd, env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', ...env }, signal: runSignal, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
  try {
    const outcome = await child.done
    runSignal.throwIfAborted()
    const stdout = child.collected.stdout.readFrom(0), stderr = child.collected.stderr.readFrom(0)
    if (outcome.exitCode === null || !allowed.includes(outcome.exitCode)) throw new Error(`Git command failed (${String(outcome.exitCode)}): ${stderr.text.trim()}`)
    if (stdout.lossy || stderr.lossy) throw new Error('Git command output was truncated')
    return stdout.text.replace(/\r?\n$/, '')
  } finally { child.terminate(); await child.waitForExit() }
}

/** Isolate actual checkout files and move only the assigned participant into its checkout. */
export async function createCollaborationWorktree(ctx: MaterialContext, agent: EnvironmentAgent, request: CreateCollaborationWorktree, signal?: AbortSignal): Promise<CollaborationWorktree> {
  if (!request.taskId || !request.integrationOwnerSessionId || !agent.id) throw new Error('Task, owner and integration owner are required')
  signal?.throwIfAborted()
  const native = ctx.get('worktrees') as { create(agent: EnvironmentAgent, request: { name?: string; from?: string }, signal?: AbortSignal): Promise<{ path: string; repositoryRoot: string; baseCommit: string; branch: string }> } | undefined
  if (native !== undefined && request.path === undefined) {
    const created = await native.create(agent, { name: request.name, from: request.from }, signal)
    return { ...created, taskId: request.taskId, ownerSessionId: agent.id, integrationOwnerSessionId: request.integrationOwnerSessionId }
  }
  const directory = service<WorkingDirectory>(ctx, 'workingDirectory')
  const cwd = await directory.ensure(agent, signal)
  const repositoryRoot = await git(ctx, agent, cwd, ['rev-parse', '--show-toplevel'], signal)
  const baseCommit = (await git(ctx, agent, repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${request.from ?? 'HEAD'}^{commit}`], signal)).trim()
  const requestedPath = request.path ?? join(repositoryRoot, '.agents', 'worktrees', `collaboration-${randomUUID()}`)
  if (!isAbsolute(requestedPath)) throw new Error('Worktree path must be absolute')
  const fs = service<{ resolve(path: string, options: { cwd: string; signal?: AbortSignal }): Promise<unknown>; processPath(target: unknown): string }>(ctx, 'fs')
  const path = fs.processPath(await fs.resolve(requestedPath, { cwd: repositoryRoot, signal }))
  const inside = relative(repositoryRoot, path)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Fallback worktree must be inside its repository workspace')
  if (request.name !== undefined) await git(ctx, agent, repositoryRoot, ['check-ref-format', `refs/heads/${request.name}`], signal)
  try {
    await git(ctx, agent, repositoryRoot, ['worktree', 'add', '--no-checkout', ...(request.name === undefined ? ['--detach'] : ['-b', request.name]), '--', path, baseCommit], signal)
    // Match the native checkout contract: repository filters must not execute while materializing files.
    const configured = await git(ctx, agent, path, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], signal, [0, 1])
    const drivers = new Set(configured.split('\0').filter(Boolean).map(key => key.slice(7, key.lastIndexOf('.'))))
    const overrides: Record<string, string> = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
    let index = 0
    for (const driver of drivers) for (const attribute of ['clean', 'smudge', 'process', 'required']) {
      overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
      overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
      index++
    }
    await git(ctx, agent, path, ['reset', '--hard', '--no-recurse-submodules', baseCommit], signal, [0], overrides)
    signal?.throwIfAborted()
    return { taskId: request.taskId, ownerSessionId: agent.id, integrationOwnerSessionId: request.integrationOwnerSessionId, repositoryRoot, baseCommit, path: await directory.set(agent, path, signal), ...(request.name === undefined ? {} : { branch: request.name }) }
  } catch (error) {
    throw new Error(`Could not finish task checkout at ${path}; any allocated checkout is retained. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** Pin review evidence to the contributor's commit and diff, without modifying either checkout. */
export async function inspectCollaborationWorktree(ctx: MaterialContext, agent: EnvironmentAgent, environment: CollaborationWorktree, signal?: AbortSignal): Promise<{ headCommit: string; baseCommit: string; dirty: boolean; status: string; diff: string; integrationOwnerSessionId: string }> {
  if (environment.ownerSessionId !== agent.id && environment.integrationOwnerSessionId !== agent.id) throw new Error('Only the checkout owner or integration owner may inspect task changes')
  const common = await git(ctx, agent, environment.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
  const expected = await git(ctx, agent, environment.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
  if (common !== expected) throw new Error('Task checkout no longer belongs to the recorded repository')
  const headCommit = await git(ctx, agent, environment.path, ['rev-parse', 'HEAD'], signal)
  const status = await git(ctx, agent, environment.path, ['status', '--porcelain=v1', '--untracked-files=all'], signal)
  const diff = await git(ctx, agent, environment.path, ['diff', '--no-ext-diff', '--no-textconv', '--binary', environment.baseCommit, '--'], signal)
  return { headCommit, baseCommit: environment.baseCommit, dirty: status !== '', status, diff, integrationOwnerSessionId: environment.integrationOwnerSessionId }
}

/** Merge only the reviewed commit, under the named integrator; business validation remains explicit. */
export async function integrateCollaborationWorktree(ctx: MaterialContext, agent: EnvironmentAgent, environment: CollaborationWorktree, request: { expectedSourceCommit: string; expectedTargetCommit: string }, signal?: AbortSignal): Promise<{ sourceCommit: string; targetBeforeCommit: string; integratedCommit: string; validation: 'required' }> {
  if (agent.id !== environment.integrationOwnerSessionId) throw new Error('Only the integration owner may merge task changes')
  if (![request.expectedSourceCommit, request.expectedTargetCommit].every(commit => /^[0-9a-f]{40,64}$/u.test(commit))) throw new Error('Integration requires exact commit identities')
  const source = await inspectCollaborationWorktree(ctx, agent, environment, signal)
  if (source.dirty || source.headCommit !== request.expectedSourceCommit) throw new Error('Task checkout must be clean and still at the reviewed commit')
  const cwd = await service<WorkingDirectory>(ctx, 'workingDirectory').ensure(agent, signal)
  const common = await git(ctx, agent, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
  const expected = await git(ctx, agent, environment.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
  if (common !== expected || cwd === environment.path) throw new Error('Integration must use a separate checkout of the recorded repository')
  if (await git(ctx, agent, cwd, ['status', '--porcelain=v1', '--untracked-files=all'], signal) !== '') throw new Error('Integration checkout must be clean')
  const before = await git(ctx, agent, cwd, ['rev-parse', 'HEAD'], signal)
  if (before !== request.expectedTargetCommit) throw new Error('Integration target changed; review the latest commit before merging')
  try {
    await git(ctx, agent, cwd, ['-c', 'commit.gpgSign=false', 'merge', '--no-ff', '--no-edit', '--no-verify', request.expectedSourceCommit], signal)
  } catch (error) {
    // Never abort automatically: the integrator owns conflict resolution and retained work.
    throw new Error(`Integration did not finish; inspect the integration checkout before retrying. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const integratedCommit = await git(ctx, agent, cwd, ['rev-parse', 'HEAD'], signal)
  const parents = (await git(ctx, agent, cwd, ['show', '-s', '--format=%P', integratedCommit], signal)).split(' ')
  if (integratedCommit !== before && parents[0] !== before) throw new Error('Integration target moved concurrently; the resulting commit requires reconciliation')
  return { sourceCommit: request.expectedSourceCommit, targetBeforeCommit: before, integratedCommit, validation: 'required' }
}
