import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const candidate = resolve(process.argv[2] ?? root)
const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const version = spawnSync(cli, ['--version'], { encoding: 'utf8' })
const hostVersion = version.stdout?.trim()
assert.equal(hostVersion, '0.2.2-rc.5', version.stderr)
const home = mkdtempSync(join(tmpdir(), 'dsh-coordinator-rc5-'))
const modules = join(home, 'profiles', 'headless', 'node_modules')
const coordinator = join(modules, 'dsh-session-coordinator')
const fixture = join(modules, 'rc5-native')
mkdirSync(coordinator, { recursive: true })
mkdirSync(fixture)
mkdirSync(join(home, 'workspace'))
for (const name of ['package.json', 'lib', 'dsh.plugin.json', 'cordis.patch.yml', 'src']) {
  cpSync(join(candidate, name), join(coordinator, name), { recursive: true })
}
cpSync(join(root, 'scripts', 'fixtures', 'rc5-native.mjs'), join(fixture, 'index.mjs'))
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'rc5-native', version: '1.0.0', main: 'index.mjs' }))
const overlay = join(home, 'probe.yml')
writeFileSync(overlay, `- id: headless-runner
  disabled: true
- id: session-title-llm
  disabled: true
- id: agent-default-model
  config:
    provider: coordinator-test
    model: fixture
- insert:
    - id: workspace-registry
      name: '@deepseek-ai/dsh-workspace'
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: acceptance
    - id: dsh-session-coordinator
      name: dsh-session-coordinator
    - id: rc5-native
      name: rc5-native
`)
const run = spawnSync(cli, ['headless', '--patch', overlay, 'run fixture'], {
  encoding: 'utf8', cwd: join(home, 'workspace'), env: { ...process.env, DSH_HOME: home }, timeout: 25000,
})
const reportPath = join(home, 'rc5-native.json')
writeFileSync(join(home, 'runtime.log'), [run.stdout, run.stderr, run.error?.message].filter(Boolean).join('\n'))
console.log('rc.5 native evidence', reportPath)
assert.ok(existsSync(reportPath), 'Host exited without a report. Inspect ' + join(home, 'runtime.log'))
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const pluginVersion = JSON.parse(readFileSync(join(coordinator, 'package.json'), 'utf8')).version
const hostBundleSha256 = createHash('sha256').update(readFileSync(join(coordinator, 'lib', 'index.js'))).digest('hex')
writeFileSync(reportPath, JSON.stringify({ hostVersion, pluginVersion, hostBundleSha256, ...report }, null, 2) + '\n')
assert.equal(run.status, 0, report.error ?? run.stderr)
assert.equal(report.checks.length, 3)
console.log(report.checks.join('\n'))
