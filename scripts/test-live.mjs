#!/usr/bin/env node
/** macOS 桌面 DSH 的真实双会话验收；只使用隔离临时目录，凭据由现有只读 provider 解析。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const summaryArg = process.argv.indexOf('--summary')
const naturalSummary = summaryArg >= 0
const collaboration = process.argv.includes('--collaboration')
const collaborationFailure = process.argv.includes('--collaboration-failure')
const collaborationTenRounds = process.argv.includes('--collaboration-ten-rounds')
const collaborationBusyOwner = process.argv.includes('--collaboration-busy-owner')
const collaborationControls = process.argv.includes('--collaboration-controls')
const collaborationRecovery = process.argv.includes('--collaboration-recovery')
const collaborationPreset = process.argv.includes('--collaboration-preset-proof')
const loopScenario = ['boundary', 'normal', 'varied'].map(name => 'collaboration-loop-' + name).find(name => process.argv.includes('--' + name))
const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const userHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const desktop = join(userHome, 'profiles', 'desktop')
assert.ok(existsSync(cli), '需要安装 macOS DeepSeek Harness')
const yaml = createRequire(join(desktop, 'package.json'))('yaml')
const rows = yaml.parse(readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8'))
const chosen = rows.filter(row => ['agent-default-model', 'llm-pi-ai'].includes(row.id)).map(row => ({ id: row.id, config: row.config }))
assert.equal(chosen.length, 2, '验收需要 desktop profile 中已有的 agent-default-model 和 llm-pi-ai 配置')
const runtime = execFileSync(process.execPath, ['tools/asar.mjs', 'doctor'], { cwd: root, encoding: 'utf8' }).match(/runtime:\s+(\S+)/)?.[1]
assert.ok(runtime, '必须核实实际 DSH 版本')
const home = mkdtempSync(join(tmpdir(), 'dsh-coordinator-live-'))
const workspace = naturalSummary && !process.argv.includes('--repo-context') ? join(home, 'workspace') : root
if (workspace !== root) mkdirSync(workspace)
const env = { ...process.env, DSH_HOME: home, DSH_LIVE_RUNTIME: runtime }
execFileSync(cli, ['headless', '--help'], { env, stdio: 'ignore' })
const modules = join(home, 'profiles', 'headless', 'node_modules')
mkdirSync(modules, { recursive: true })
symlinkSync(root, join(modules, 'dsh-session-coordinator'))
symlinkSync(join(root, 'scripts', 'live'), join(modules, 'dsh-live-acceptance'))
const patches = [
  ...chosen,
  { id: 'credentials', disabled: false, config: { path: join(userHome, '.credentials.yaml') } },
  { id: 'session-title-llm', disabled: true },
  { insert: [
    { id: 'workspace-registry', name: '@deepseek-ai/dsh-workspace' },
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'acceptance' } },
    { id: 'coordinator', name: 'dsh-session-coordinator' },
    { id: 'acceptance', name: 'dsh-live-acceptance' },
  ] },
]
const overlay = join(home, 'profile.yml')
writeFileSync(overlay, yaml.stringify(patches), { mode: 0o600 })
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const artifacts = { host: hash(join(root, 'lib/index.js')), client: hash(join(root, 'src/client/index.js')) }
const outputArg = process.argv.indexOf('--output')
const output = outputArg >= 0 ? resolve(process.argv[outputArg + 1]) : collaborationPreset ? join(root, 'docs', 'acceptance', 'preset-cold-live') : loopScenario ? join(root, 'docs', 'acceptance', loopScenario + '-live') : collaborationRecovery ? join(root, 'docs', 'acceptance', 'recovery-native-live') : naturalSummary ? resolve(process.argv[summaryArg + 1] ?? join(root, 'docs', 'acceptance', 'g5-summary')) : collaborationControls ? join(root, 'docs', 'acceptance', 'collaboration-controls-live') : collaborationBusyOwner ? join(root, 'docs', 'acceptance', 'collaboration-busy-owner-live') : collaborationTenRounds ? join(root, 'docs', 'acceptance', 'collaboration-ten-rounds-live') : collaborationFailure ? join(root, 'docs', 'acceptance', 'collaboration-failure-live') : collaboration ? join(root, 'docs', 'acceptance', 'collaboration-native-live') : join(root, 'docs', 'acceptance')
mkdirSync(output, { recursive: true })
const summary = { testedAt: new Date().toISOString(), runtime, ...(loopScenario || collaborationBusyOwner || collaborationControls || collaborationRecovery || collaborationPreset ? {} : { model: chosen.find(row=>row.id==='agent-default-model').config }), artifacts, isolationHome: home, cases: [] }
const scenarios = collaborationPreset ? ['collaboration-preset-create', 'collaboration-preset-reopen'] : loopScenario ? [loopScenario] : collaborationRecovery ? ['collaboration-recovery-fail', 'collaboration-recovery-inspect', 'collaboration-recovery-recover'] : collaborationControls ? ['collaboration-controls'] : collaborationBusyOwner ? ['collaboration-busy-owner'] : collaborationTenRounds ? ['collaboration-ten-rounds'] : collaborationFailure ? ['collaboration-failure'] : collaboration ? ['collaboration'] : naturalSummary
  ? process.argv.includes('--ready-history') ? ['summary-ready', 'summary-ready-math'] : ['summary-review', 'summary-math', 'summary-limit', 'summary-ready', 'summary-ready-math']
  : ['idle', 'busy', 'panel']
for (const scenario of scenarios) {
  console.log('LIVE ' + scenario + ': real DSH Agents and configured model')
  const phase = collaborationRecovery ? scenario.slice('collaboration-recovery-'.length) : collaborationPreset ? scenario.slice('collaboration-preset-'.length) : undefined
  const adopt = collaborationRecovery && phase !== 'fail' ? ['--session-id', JSON.parse(readFileSync(join(home, 'collaboration-recovery-fail-report.json'), 'utf8')).sessions.A] : collaborationPreset && phase === 'reopen' ? ['--session-id', JSON.parse(readFileSync(join(home, 'collaboration-preset-create-report.json'), 'utf8')).sessions.A] : []
  let processError
  try {
    const stdout = execFileSync(cli, ['--profile', 'headless', '--patch', overlay, '--json', ...adopt, '验收由本地测试插件设置，仅执行验收任务。'],
      { cwd: workspace, env: { ...env, DSH_LIVE_CASE: scenario, ...(collaborationRecovery ? { DSH_LIVE_RECOVERY_PHASE: phase } : collaborationPreset ? { DSH_LIVE_PRESET_PHASE: phase } : {}) }, encoding: 'utf8', timeout: collaborationPreset ? 45000 : loopScenario ? 210000 : phase === 'inspect' ? 30000 : collaborationControls ? 660000 : collaborationTenRounds ? 660000 : collaboration || collaborationFailure || collaborationBusyOwner || collaborationRecovery ? 300000 : 150000, maxBuffer: (collaborationTenRounds || collaborationControls || collaborationRecovery ? 12 : 4) * 1024 * 1024 })
    writeFileSync(join(home, scenario + '-stdout.log'), stdout)
  } catch (error) {
    processError = error
    if ((collaborationRecovery || collaborationPreset) && existsSync(join(home, scenario + '-report.json'))) copyFileSync(join(home, scenario + '-report.json'), join(output, scenario + '.json'))
    // A read-only reopen intentionally has no new turn; native headless exits 1 for that empty interval.
    if ((phase === 'inspect' || collaborationPreset) && error.status === 1 && !error.signal && JSON.parse(readFileSync(join(home, scenario + '-report.json'), 'utf8')).pass === true) processError = undefined
    if (processError) {
    console.error('验收失败；日志目录：' + home)
    // --json stdout 可能含模型 reasoning；失败只报状态，正文证据由 fixture 单独筛选。
    throw new Error('DSH CLI failed (status ' + error.status + ', signal ' + error.signal + '); inspect the filtered report in ' + home)
    }
  }
  const report = JSON.parse(readFileSync(join(home, scenario + '-report.json'), 'utf8'))
  copyFileSync(join(home, scenario + '-report.json'), join(output, scenario + '.json'))
  if (!naturalSummary) assert.equal(report.pass, true, scenario + ' 未通过：' + JSON.stringify(report.failure ?? report.result))
  assert.equal(report.failure, undefined)
  summary.cases.push({ scenario, pass: report.pass, sessions: report.sessions, assertions: report.assertions, ...(naturalSummary ? { result: report.result } : {}) })
}
assert.deepEqual({ host: hash(join(root, 'lib/index.js')), client: hash(join(root, 'src/client/index.js')) }, artifacts, '验收期间产物不能变化')
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
if (naturalSummary) {
  console.log('LIVE natural summary checks: ' + summary.cases.filter(value => value.pass).length + '/' + summary.cases.length + '；仍需逐样本语义复核；证据 ' + output)
  assert.ok(summary.cases.every(value => value.pass), '自然总结验收有失败样本；原始文字见 ' + output)
} else console.log('LIVE PASS: ' + scenarios.join(' / ') + '；证据 ' + output)
