#!/usr/bin/env node
/** Fixed-case, read-only desktop recovery audit. No dispatch, UI, build, or credentials. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { decodeFrames } from './desktop-controls-evidence.mjs'

const dir = 'docs/acceptance/journeys-0.2.3/desktop-recovery-025-026'
const read = name => JSON.parse(fs.readFileSync(`${dir}/${name}.json`))
const owner = 'session-8bab9318-0e78-4c2f-bb96-3d179192601c'
const peer = 'cs-beb7370593d08b21f570af0917f1a2c3724acf2594ff3d7015dc812a705f2fb4'
const scopeId = 'collab-fd881060547180e948991133499e456551cad17febf5528c94a2826f669883d0'
const taskId = 'task-707082cad34a9b487424ad7152d131d559ffb615c2cce2849d3abdf2e6d6aa8c'
const debitOp = 'op-debit-desktop-recovery-20261029-01'
const creditOp = 'op-credit-desktop-recovery-20261029-02'
const path = 'recovery-demo/run-20261029-desktop/ledger_step.py'
const report = read('desktop-native-evidence'), before = read('before-interruption')
const reopened = read('after-restart-before-human'), idle = read('reopened-no-auto-replay')
const ledgerBefore = read('ledger-before-interruption'), ledgerFinal = read('ledger-final'), quiet = read('quiet-observation')
assert.equal(report.owner, owner); assert.equal(report.scopeId, scopeId)
assert.deepEqual([...report.members].sort(), [owner, peer].sort())
const logs = new Map(report.sourceFiles.map(file => {
  assert.ok([owner, peer].includes(file.sessionId))
  const bytes = fs.readFileSync(file.path)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, 'audit a stable exact native trace')
  const events = decodeFrames(bytes)
  assert.equal(events[0].id, file.sessionId); assert.equal(events[0].delegationDepth, 0)
  assert.equal(events[0].parentSession, undefined)
  return [file.sessionId, events]
}))
const text = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
const args = event => typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments
const calls = [...logs].flatMap(([sessionId, events]) => events.filter(event => event.type === 'tool/call').map(event => {
  const result = events.find(e => e.type === 'tool/result' && e.data.message.toolCallId === event.data.callId)
  return { sessionId, event, args: args(event), result, output: result && text(result.data.message) }
}))
const named = name => calls.filter(call => call.event.data.name === name)
const parseResult = call => JSON.parse(call.output)
assert.equal(named('session_coordinator_collaboration_start').length, 1)
assert.equal(named('session_coordinator_collaboration_task').length, 1)
assert.ok(!calls.some(c => ['spawn_teammate', 'subagent'].includes(c.event.data.name)))
for (const sessionId of [owner, peer]) {
  assert.equal(report.counts[sessionId].humanInputs, sessionId === owner ? 2 : 0)
  assert.equal(report.counts[sessionId].turnStarts, 2)
  assert.equal(report.counts[sessionId].turnEnds, 2)
}
assert.equal(before.counts[owner].turnEnds, 0); assert.equal(before.counts[peer].turnEnds, 0)
assert.equal(ledgerBefore.balance, 88); assert.equal(ledgerBefore.entries.length, 1)
assert.deepEqual(idle.ledger, ledgerBefore)
assert.ok(idle.elapsedMs >= 30_000); assert.deepEqual(idle.counts, reopened.counts)
assert.deepEqual(idle.sourceFiles, reopened.sourceFiles)
assert.ok(Date.parse(idle.capturedAt) < report.humanInputs[1].time)
assert.equal(ledgerBefore.entries[0].operationId, debitOp)
assert.equal(ledgerFinal.balance, 93); assert.equal(ledgerFinal.entries.length, 2)
assert.deepEqual(ledgerFinal.entries[0], ledgerBefore.entries[0])
assert.deepEqual(ledgerFinal.entries.map(e => [e.kind, e.amount, e.operationId, e.originalOperationId]), [
  ['debit', -12, debitOp, undefined], ['credit', 5, creditOp, debitOp]
])
const debits = calls.filter(c => c.args?.command === `python3 ${path} debit ${debitOp}`)
const credits = calls.filter(c => c.args?.command === `python3 ${path} credit ${creditOp} ${debitOp}`)
assert.equal(debits.length, 1); assert.equal(credits.length, 1)
const debit = debits[0], credit = credits[0]
assert.equal(debit.sessionId, peer); assert.equal(credit.sessionId, peer)
assert.equal(debit.result.data.message.isError, true)
assert.match(debit.output, /outcome is unknown/)
assert.ok(!credit.result.data.message.isError)
assert.deepEqual(JSON.parse(credit.output.split('\n')[0]), ledgerFinal)
const executionCommands = calls.filter(c => ['bash', 'ops_bash'].includes(c.event.data.name) && /(?:^|[;&]\s*)python3\s+\S*ledger_step\.py\s+(?:debit|credit)\b/.test(c.args?.command ?? ''))
assert.equal(executionCommands.length, 2, 'no alternate identity or replay command')
const ownerInspect = calls.find(c => c.sessionId === owner && c.event.time > report.humanInputs[1].time && c.args?.command?.includes(`${path} inspect`) && c.output?.includes('"balance": 88'))
const peerInspect = calls.find(c => c.sessionId === peer && c.event.time > report.humanInputs[1].time && c.args?.command?.startsWith(`python3 ${path} inspect`) && c.output?.includes('"balance": 88'))
assert.ok(ownerInspect && peerInspect)
assert.ok(ownerInspect.result.time < credit.event.time && peerInspect.result.time < credit.event.time)
const status = named('session_coordinator_collaboration_status')[0]
assert.equal(parseResult(status).state, 'recovery-required')
const resume = named('session_coordinator_collaboration_control').find(c => c.args.action === 'resume')
assert.equal(resume.args.scopeId, scopeId); assert.equal(parseResult(resume).state, 'active')
const ownerEvents = logs.get(owner)
const ask = ownerEvents.find(e => e.type === 'approval/asked' && e.data.callId === resume.event.data.callId)
const allow = ownerEvents.find(e => e.type === 'approval/decided' && e.data.id === ask?.data.id)
assert.equal(allow?.data.outcome, 'allowed-once')
const sends = named('session_coordinator_collaboration_send')
assert.deepEqual(sends.map(c => c.args.operationId), [debitOp, creditOp])
for (const send of sends) {
  assert.deepEqual([send.args.scopeId, send.args.taskId, send.args.taskRevision, send.args.sessionId], [scopeId, taskId, 1, peer])
  assert.ok(!send.result.data.message.isError)
}
assert.ok(resume.result.time < sends[1].event.time && sends[1].result.time < peerInspect.event.time)
const result = named('session_coordinator_collaboration_result')
assert.equal(result.length, 1)
assert.deepEqual([result[0].args.scopeId, result[0].args.taskId, result[0].args.taskRevision, result[0].args.operationId], [scopeId, taskId, 1, creditOp])
assert.ok(credit.result.time < result[0].event.time)
const final = report.scopeSnapshots.at(-1)
assert.equal(final.state, 'completed'); assert.deepEqual(Object.keys(final.tasks), [taskId])
assert.equal(final.tasks[taskId].state, 'completed'); assert.equal(final.tasks[taskId].revision, 1)
assert.equal(final.tasks[taskId].acceptedResultIds.length, 1)
const verification = calls.find(c => c.sessionId === owner && c.event.time > result[0].result.time && c.args?.command?.includes('ledger_step.py inspect') && c.output?.includes('debits 1 credits 1'))
assert.ok(verification && verification.result.time < final.time)
assert.equal(report.errors.length, 4)
assert.equal(report.errors.filter(e => /outcome is unknown/.test(e.content)).length, 2)
assert.equal(report.errors.filter(e => e.name === 'session_coordinator_status' && /is not live/.test(e.content)).length, 1)
assert.equal(report.errors.filter(e => e.name === 'session_coordinator_resume' && /not authorized/.test(e.content)).length, 1)
assert.ok(quiet.elapsedMs >= 30_000 && quiet.pass)
assert.deepEqual(quiet.before.sourceFiles, quiet.after.sourceFiles)
assert.deepEqual(quiet.before.counts, quiet.after.counts)
assert.deepEqual(quiet.after.sourceFiles, report.sourceFiles)
const businessEvents = calls.filter(c => [debit, credit, ownerInspect, peerInspect, verification, status, resume, ...sends, ...result].includes(c)).map(c => ({
  sessionId: c.sessionId, callId: c.event.data.callId, name: c.event.data.name, turn: c.event.data.turn, step: c.event.data.step,
  seq: c.event.seq, time: c.event.time, arguments: c.args.command ? { command: c.args.command } : Object.fromEntries(Object.entries(c.args).filter(([k]) => !['message', 'text', 'evidence'].includes(k))),
  result: { seq: c.result.seq, time: c.result.time, isError: Boolean(c.result.data.message.isError),
    ...(c.args.command ? { output: c.output } : { identity: { id: parseResult(c).id, state: parseResult(c).state, taskId: parseResult(c).taskId } }) }
}))
const proof = { layer: 'independent-read-only-actual-desktop-native-audit', pass: true, protocolClean: false, owner, peer, scopeId, taskId, taskRevision: 1,
  versions: { beforeInterruption: '0.2.5', beforeHostSha256: 'e7ad3194e6a03d2556b4b1443e0eca90feabeaf3bc2bd2deba90a782de6a7066', recovered: '0.2.6', recoveredHostSha256: '60ea0ea24b0d8e7cc05a86772201a9fc503371479f14727139dddc4326fec899' },
  evidence: { debitCommands: 1, creditCommands: 1, originalDebitOp: debitOp, creditOp, balanceBefore: 88, balanceFinal: 93, debitEntries: 1, linkedCreditEntries: 1,
    noReplayObservedMs: idle.elapsedMs, quietAfterCompletedMs: quiet.elapsedMs, humanInputs: { owner: 2, peer: 0 }, toolErrors: 4, sameScopeTaskRevisionAndPeer: true,
    ownerAndPeerInspectBeforeCredit: true, ownerVerifiesAfterResultBeforeFinish: true, nativeTurns: report.counts },
  limits: ['This verifies this two-version desktop recovery journey, not all journeys on one final version.', 'Recovered interrupted-event timestamps are synthetic last-activity times, not actual quit/restart wall clocks. Durable before-interruption ledger and captured snapshots establish commit-before-restart; do not sort synthetic turn/end against debit commit.', 'Four retained tool errors comprise two interrupted unknown outcomes, one cold status not-live error, and one refused legacy resume that the model corrected to scoped send.', 'The fixture implements guarded ledger side effects; this proves observed exactly-once execution in this case, not a universal exactly-once guarantee for arbitrary external tools.'], sourceFiles: report.sourceFiles }
if (!process.argv.includes('--check')) {
  fs.writeFileSync(`${dir}/independent-proof.json`, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  fs.writeFileSync(`${dir}/business-native-events.json`, JSON.stringify(businessEvents, null, 2) + '\n', { flag: 'wx' })
}
console.log(JSON.stringify({ pass: proof.pass, protocolClean: proof.protocolClean, evidence: proof.evidence }))
