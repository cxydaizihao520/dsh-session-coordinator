#!/usr/bin/env node
/** Read-only, bounded review of two explicitly authorized completed desktop cases. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { decodeFrames, collectDesktopEvidence } from './desktop-controls-evidence.mjs'

const base = '/Users/daizhihao/.dsh/sessions/--private-tmp-dsh-desktop-journeys-20261028--'
const prefix = 'docs/acceptance/journeys-0.2.3/'
const cases = [
  { kind: 'busy', owner: 'session-90f39e8f-342b-4490-9031-6a20324ee2e1', directory: 'desktop-busy-025' },
  { kind: 'loop', owner: 'session-383791f1-a4de-4abd-b95f-01a1a18bd93d', directory: 'desktop-loop-025' },
]
const textOf = event => event.data.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
const argsOf = call => typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments
const receipt = (events, call) => events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
const valueOf = (events, call) => JSON.parse(textOf(receipt(events, call)))
const metadata = event => ({ time: event.time, seq: event.seq, type: event.type, turn: event.data.turn, step: event.data.step, callId: event.data.callId ?? event.data.message?.toolCallId })
const callsNamed = (events, name) => events.filter(event => event.type === 'tool/call' && event.data.name === name)

function common(report, logs, quiet) {
  assert.equal(report.errors.length, 0)
  assert.equal(report.humanInputs.length, 1)
  assert.equal(report.humanInputs[0].sessionId, report.owner)
  assert.equal(report.humanQuestionReplies.length, 0)
  assert.equal(quiet.pass, true); assert.ok(quiet.elapsedMs >= 30000)
  assert.deepEqual(quiet.before.counts, quiet.after.counts)
  assert.deepEqual(quiet.before.sourceFiles.map(file => file.sha256), quiet.after.sourceFiles.map(file => file.sha256))
  assert.deepEqual(report.sourceFiles.map(file => file.sha256), quiet.after.sourceFiles.map(file => file.sha256), 'reviewed native records must be exactly the quiet-window source files')
  for (const id of report.members) {
    assert.equal(report.headers[id].id, id); assert.notEqual(report.headers[id].origin, 'subagent')
    assert.equal(report.headers[id].parentSession, undefined); assert.equal(report.headers[id].delegationDepth ?? 0, 0)
    const events = logs.get(id), starts = events.filter(event => event.type === 'turn/start'), ends = events.filter(event => event.type === 'turn/end')
    assert.equal(starts.length, ends.length)
    assert.ok(ends.every(event => event.data.reason.kind === 'completed' && event.time <= Date.parse(quiet.before.capturedAt)))
    for (const start of starts) assert.equal(ends.filter(end => end.data.turn === start.data.turn).length, 1)
  }
  const owner = logs.get(report.owner), start = callsNamed(owner, 'session_coordinator_collaboration_start')
  assert.equal(start.length, 1)
  const approval = owner.filter(event => event.type === 'approval/asked')
  assert.equal(approval.length, 1); assert.equal(approval[0].data.callId, start[0].data.callId)
  const decision = owner.filter(event => event.type === 'approval/decided')
  assert.equal(decision.length, 1); assert.equal(decision[0].data.id, approval[0].data.id); assert.equal(decision[0].data.outcome, 'allowed-once')
  assert.ok(report.timeline.filter(event => event.type === 'tool/call').every(event => !['spawn_teammate', 'subagent', 'session_coordinator_send', 'session_coordinator_create'].includes(event.name)))
}

function peerResults(owner, peer, report) {
  return callsNamed(peer, 'session_coordinator_collaboration_result').map(call => {
    const args = argsOf(call), output = receipt(peer, call), value = valueOf(peer, call)
    assert.equal(output.data.message.isError ?? false, false)
    const input = peer.find(event => event.type === 'user/message' && event.data.source?.kind === 'session-collaboration' && event.data.id === args.operationId)
    assert.ok(input && input.seq < call.seq)
    assert.equal(input.data.source.intent, 'task'); assert.equal(input.data.source.scopeId, report.scopeId)
    assert.equal(args.scopeId, report.scopeId); assert.equal(args.taskId, input.data.source.taskId); assert.equal(args.taskRevision, input.data.source.taskRevision)
    assert.equal(value.operationId, args.operationId); assert.equal(value.taskId, args.taskId); assert.equal(value.taskRevision, args.taskRevision)
    assert.equal(value.sender, peer[0].id); assert.equal(value.text, args.text); assert.equal(value.stale, false)
    return { call, output, value, input }
  })
}

function busy(report, logs) {
  const owner = logs.get(report.owner), peerId = report.members.find(id => id !== report.owner), peer = logs.get(peerId)
  const results = peerResults(owner, peer, report)
  assert.equal(results.length, 2)
  const first = results[0], review = results[1]
  const scan = callsNamed(owner, 'ops_bash').find(call => argsOf(call).command.includes('/scan_sales.py'))
  assert.ok(scan)
  const scanEnd = receipt(owner, scan)
  assert.equal(scanEnd.data.message.isError ?? false, false)
  assert.ok(scan.time < first.output.time && first.output.time < scanEnd.time, 'the real peer result receipt, not helper checked_at, must occur during the owner tool')
  const inbound = owner.find(event => event.type === 'user/message' && event.data.source?.scopeId === report.scopeId && event.data.source?.intent === 'result' && event.data.source.taskId === first.value.taskId)
  assert.ok(inbound && inbound.time > scanEnd.time)
  assert.ok(inbound.data.content[0].text.endsWith('\n' + first.value.text), 'actual admitted notification must contain the exact real result')
  const nextStep = owner.filter(event => event.type === 'step/start' && event.seq < inbound.seq).at(-1)
  assert.equal(nextStep.data.turn, scan.data.turn); assert.ok(nextStep.data.step > scan.data.step)
  const combinedWrite = callsNamed(owner, 'write').find(call => argsOf(call).file_path.endsWith('/combined.json'))
  assert.ok(combinedWrite && combinedWrite.seq > inbound.seq && combinedWrite.data.turn === scan.data.turn)
  assert.equal(receipt(owner, combinedWrite).data.message.isError ?? false, false)
  const combined = JSON.parse(argsOf(combinedWrite).content)
  assert.equal(combined.sales.paid, '101000.00'); assert.equal(combined.sales.rows, 200000)
  assert.equal(combined.adjustments.adjustment, '13.15'); assert.equal(combined.net_total, '101013.15')
  const scanLines = textOf(scanEnd).split('\n').map(line => { try { return JSON.parse(line) } catch {} }).filter(Boolean)
  const sales = scanLines.at(-1)
  assert.equal(sales.rows, 200000); assert.equal(sales.paid, '101000.00')
  const helper = callsNamed(peer, 'bash').find(call => argsOf(call).command.includes('check_adjustments.py'))
  const helperResult = JSON.parse(textOf(receipt(peer, helper)).split('\n').find(line => line.startsWith('{')))
  assert.equal(helperResult.adjustment, '13.15'); assert.equal(helperResult.rows, 2)
  const replyBusinessJson = first.value.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(value => value.adjustment !== undefined)
  assert.deepEqual(replyBusinessJson, helperResult, 'the real result must carry the exact helper business data, separately from its submission time')
  assert.ok(helperResult.checked_at * 1000 < first.output.time, 'helper completion is recorded separately and must not replace the real reply time')
  // Verify visible access operations; this is not an operating-system syscall audit.
  const ownerReads = callsNamed(owner, 'read').map(argsOf)
  assert.ok(ownerReads.every(args => !args.file_path.endsWith('/adjustments.csv')))
  const ownerCommands = owner.filter(event => event.type === 'tool/call' && ['bash', 'ops_bash'].includes(event.data.name)).map(call => ({ ...metadata(call), name: call.data.name, arguments: argsOf(call) }))
  assert.ok(ownerCommands.every(item => !/(?:cat|open|read_csv|read_text|loadtxt)\s*\(?\s*['"]?(?:[^\s'"\n]*\/)?adjustments\.csv/.test(item.arguments.command)))
  assert.ok(ownerCommands.every(item => !/python3\s+\S*check_adjustments\.py/.test(item.arguments.command)))
  const reviewSend = callsNamed(owner, 'session_coordinator_collaboration_send').find(call => argsOf(call).taskId === review.value.taskId)
  assert.ok(reviewSend.time > receipt(owner, combinedWrite).time && review.input.time > reviewSend.time)
  const peerRead = callsNamed(peer, 'read').find(call => argsOf(call).file_path.endsWith('/combined.json'))
  assert.ok(peerRead && peerRead.time > review.input.time && peerRead.time < review.call.time)
  assert.match(review.value.text, /^PASS/); assert.ok(review.value.text.includes('101013.15'))
  const finishes = callsNamed(owner, 'session_coordinator_collaboration_control').filter(call => argsOf(call).action === 'finish')
  assert.equal(finishes.length, 3)
  assert.ok(finishes.every(call => call.time > review.output.time))
  const scopeFinish = finishes.find(call => !argsOf(call).taskId)
  assert.equal(valueOf(owner, scopeFinish).state, 'completed')
  const facts = { scan: { ...metadata(scan), endTime: scanEnd.time, endSeq: scanEnd.seq, durationMs: scanEnd.time - scan.time, command: argsOf(scan).command, sales }, firstPeerResult: { time: first.output.time, seq: first.output.seq, resultId: first.value.id, taskId: first.value.taskId, operationId: first.value.operationId, adjustment: helperResult.adjustment, rows: helperResult.rows }, helperCheckedAt: helperResult.checked_at, replyBeforeToolEndMs: scanEnd.time - first.output.time, admitted: { time: inbound.time, seq: inbound.seq, source: inbound.data.source, turn: nextStep.data.turn, step: nextStep.data.step }, combinedWrite: { ...metadata(combinedWrite), resultTime: receipt(owner, combinedWrite).time, content: combined }, review: { sendTime: reviewSend.time, admittedTime: review.input.time, combinedReadTime: peerRead.time, resultTime: review.output.time, resultId: review.value.id, text: review.value.text }, scopeCompletedAt: receipt(owner, scopeFinish).time }
  const businessEvents = { scanCall: { ...metadata(scan), arguments: argsOf(scan) }, scanResult: { ...metadata(scanEnd), finalBusinessJson: sales, batchProgressEvents: scanLines.filter(line => line.batch).length }, peerHelper: { ...metadata(helper), arguments: argsOf(helper), result: helperResult }, realPeerResult: { ...metadata(first.output), result: first.value }, ownerAdmission: { time: inbound.time, seq: inbound.seq, message: inbound.data }, ownerCommands, ownerReads, combinedWrite: { ...metadata(combinedWrite), arguments: argsOf(combinedWrite) }, reviewResult: { ...metadata(review.output), result: review.value } }
  return { facts, businessEvents }
}

function loop(report, logs) {
  const owner = logs.get(report.owner), peer = logs.get(report.members.find(id => id !== report.owner)), results = peerResults(owner, peer, report)
  const sends = callsNamed(owner, 'session_coordinator_collaboration_send')
  assert.equal(sends.length, 4); assert.equal(results.length, 4)
  const ids = new Set(), operations = new Map()
  for (const [index, result] of results.entries()) {
    const args = argsOf(sends[index]), sent = valueOf(owner, sends[index])
    assert.equal(args.operationId, result.value.operationId); assert.equal(sent.id, args.operationId)
    assert.equal(result.value.text, 'ACK'); assert.deepEqual(result.value.evidence, [])
    assert.equal(result.value.taskId, results[0].value.taskId); assert.equal(result.value.taskRevision, 1)
    assert.ok(!ids.has(result.value.operationId)); ids.add(result.value.operationId)
    if (index) assert.ok(sends[index].time > results[index - 1].output.time)
  }
  for (const events of logs.values()) for (const event of events) {
    const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : []
    for (const message of messages) if (message.source?.kind === 'session-collaboration' && message.source.scopeId === report.scopeId) operations.set(message.id, message.source.intent)
  }
  assert.equal([...operations.values()].filter(intent => intent === 'task').length, 4)
  assert.equal([...operations.values()].filter(intent => intent === 'result').length, 3)
  assert.equal(operations.size, 7)
  const lastWaitCall = callsNamed(owner, 'session_coordinator_collaboration_wait').at(-1), lastWait = valueOf(owner, lastWaitCall)
  assert.equal(lastWait.scopeState, 'budget-exhausted'); assert.equal(lastWait.interrupted, true); assert.equal(lastWait.timedOut, false)
  assert.equal(lastWait.reason, 'no-progress dispatch budget exhausted; review results or revise the approach')
  assert.equal(lastWait.tasks.length, 1); assert.equal(lastWait.tasks[0].noProgress, 3); assert.equal(lastWait.tasks[0].state, 'active')
  assert.deepEqual([...lastWait.tasks[0].resultIds].sort(), results.map(result => result.value.id).sort())
  assert.equal(callsNamed(owner, 'session_coordinator_collaboration_control').length, 0)
  return { facts: { scopeState: lastWait.scopeState, reason: lastWait.reason, noProgress: lastWait.tasks[0].noProgress, taskState: lastWait.tasks[0].state, observedNativeOperations: [...operations].map(([id, intent]) => ({ id, intent })), rounds: results.map((result, index) => ({ sendTime: sends[index].time, admittedTime: result.input.time, resultTime: result.output.time, operationId: result.value.operationId, resultId: result.value.id, text: result.value.text, evidence: result.value.evidence })), finalWaitTime: receipt(owner, lastWaitCall).time }, businessEvents: { lastWait: { ...metadata(receipt(owner, lastWaitCall)), value: lastWait }, results: results.map(result => ({ ...metadata(result.output), result: result.value })), sends: sends.map(call => ({ ...metadata(call), arguments: argsOf(call) })) } }
}

for (const spec of cases) {
  const directory = resolve(prefix, spec.directory), report = collectDesktopEvidence(base, spec.owner, 1), quiet = JSON.parse(fs.readFileSync(resolve(directory, 'quiet-observation.json')))
  const logs = new Map(report.sourceFiles.map(file => [file.sessionId, decodeFrames(fs.readFileSync(file.path))]))
  common(report, logs, quiet)
  const reviewed = spec.kind === 'busy' ? busy(report, logs) : loop(report, logs)
  const proof = { layer: 'actual-desktop-native-independent-review', pass: true, owner: report.owner, scopeId: report.scopeId, sourceFiles: report.sourceFiles, facts: reviewed.facts, quietMs: quiet.elapsedMs, errors: report.errors.length, boundaries: ['No new model, UI action, approval or product modification was performed by this proof.', 'Historical desktop 0.2.5 e7ad3194e6a03d2556b4b1443e0eca90feabeaf3bc2bd2deba90a782de6a7066 per parent installation confirmation; not a claim about later builds.', 'Desktop actual admission and subsequent model-issued business tools are checked; no separate llm/stream hook was installed in the user desktop.'] }
  if (!process.argv.includes('--check')) {
    fs.writeFileSync(resolve(directory, 'independent-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    fs.writeFileSync(resolve(directory, 'business-native-events.json'), JSON.stringify({ sourceFiles: report.sourceFiles, ...reviewed.businessEvents }, null, 2) + '\n', { flag: 'wx' })
  }
  console.log(JSON.stringify({ kind: spec.kind, pass: proof.pass, facts: proof.facts, quietMs: proof.quietMs, errors: proof.errors }, null, 2))
}
