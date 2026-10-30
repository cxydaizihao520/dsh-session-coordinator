#!/usr/bin/env node
/** Preserve the failed 0.2.5 cancellation and independently verify its 0.2.6 counterpart. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { collectDesktopEvidence, decodeFrames } from './desktop-controls-evidence.mjs'

const base = '/Users/daizhihao/.dsh/sessions/--private-tmp-dsh-desktop-journeys-20261028--'
const cases = [
  { version: '025', owner: 'session-c215de44-d5aa-41bb-a483-c3031802c858', effective: false },
  { version: '026', owner: 'session-34fb24f6-8567-4210-901a-f119a11143ee', effective: true },
]
const args = call => JSON.parse(call.data.arguments)
const text = result => result.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
for (const spec of cases) {
  const directory = `docs/acceptance/journeys-0.2.3/desktop-cancel-${spec.version}`
  const report = collectDesktopEvidence(base, spec.owner)
  const logs = new Map(report.sourceFiles.map(file => [file.sessionId, decodeFrames(fs.readFileSync(file.path))]))
  const owner = logs.get(spec.owner), workers = report.members.filter(id => id !== spec.owner)
  const batches = workers.flatMap(id => logs.get(id).filter(event => event.type === 'tool/call' && ['bash', 'ops_bash'].includes(event.data.name) && /^python3 cancel-demo\/run-20261029-desktop\/read_batch\.py (goods|freight) 1(?:;|$)/.test(args(event).command)).map(call => {
    const events = logs.get(id), output = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
    const job = events.find(event => event.type === 'job/registered' && event.data.toolCall?.callId === call.data.callId)
    const settled = job && events.find(event => event.type === 'job/settled' && event.data.jobId === job.data.jobId)
    return { sessionId: id, call, output, job, settled, ledger: args(call).command.includes(' goods ') ? 'goods' : 'freight' }
  }))
  assert.equal(batches.length, 2)
  const goods = batches.find(batch => batch.ledger === 'goods'), freight = batches.find(batch => batch.ledger === 'freight')
  assert.ok(goods && freight)
  const cancel = owner.find(event => event.type === 'tool/call' && event.data.name === 'session_coordinator_collaboration_control' && args(event).action === 'cancel' && args(event).taskId)
  const cancelResult = owner.find(event => event.type === 'tool/result' && event.data.message.toolCallId === cancel.data.callId)
  assert.ok(goods.call.time < cancel.time && freight.call.time < cancel.time)
  assert.ok(cancelResult.time < goods.output.time, 'a real control receipt must precede completion or interruption of the original command')
  assert.ok(cancelResult.time < freight.output.time, 'the independent freight command must still be running at goods cancellation')
  const final = report.scopeSnapshots.filter(snapshot => snapshot.state === 'cancelled').at(-1)
  assert.ok(final)
  const goodsTask = Object.values(final.tasks).find(task => task.members.includes(goods.sessionId)), freightTask = Object.values(final.tasks).find(task => task.members.includes(freight.sessionId))
  assert.equal(goodsTask.state, 'cancelled'); assert.equal(freightTask.state, 'completed')
  assert.equal(freightTask.resultIds.length, 1); assert.deepEqual(freightTask.acceptedResultIds, freightTask.resultIds)
  const freightLines = text(freight.output).split('\n').map(line => { try { return JSON.parse(line) } catch {} }).filter(Boolean)
  const end = freightLines.find(line => line.event === 'batch-end')
  assert.equal(end.rows, 36); assert.equal(end.total_cents, 1584)
  assert.equal(freightLines.filter(line => line.event === 'record').length, 36)
  assert.equal(freight.output.data.message.isError ?? false, false)
  assert.equal(freight.settled.data.status, 'completed'); assert.equal(freight.settled.data.detail, 'exit code: 0')
  if (spec.effective) {
    assert.equal(goods.output.data.message.isError, true); assert.equal(text(goods.output), 'Error: tool call aborted')
    assert.equal(goods.settled.data.status, 'killed'); assert.equal(goods.settled.data.detail, 'signal: SIGTERM; tool call aborted')
    assert.equal(logs.get(goods.sessionId).filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'aborted')
    assert.equal(goodsTask.resultIds.length, 0, 'no guessed partial count is accepted as actual completed work')
    assert.equal(report.errors.length, 2)
    assert.equal(report.errors.filter(error => error.name === 'session_coordinator_cancel').length, 1)
    assert.equal(report.errors.filter(error => error.sessionId === goods.sessionId && error.content === 'Error: tool call aborted').length, 1)
  } else {
    assert.equal(goods.output.data.message.isError ?? false, false)
    assert.ok(text(goods.output).includes('"event": "batch-end"'))
    assert.ok(goods.output.time - cancelResult.time > 60000, 'the old failure is not a sub-second completion race')
  }
  assert.equal(report.humanInputs.length, 2)
  assert.ok(report.humanInputs.every(event => event.sessionId === spec.owner))
  const proof = { layer: 'actual-desktop-native-independent-review', version: spec.version, reviewPassed: true, effectiveCancellation: spec.effective, protocolClean: report.errors.length === 0, owner: spec.owner, scopeId: report.scopeId, sourceFiles: report.sourceFiles,
    facts: { cancelCalledAt: cancel.time, cancelAppliedReceiptAt: cancelResult.time, goods: { sessionId: goods.sessionId, callId: goods.call.data.callId, command: args(goods.call).command, start: goods.call.time, end: goods.output.time, durationMs: goods.output.time - goods.call.time, isError: Boolean(goods.output.data.message.isError), job: goods.settled.data }, freight: { sessionId: freight.sessionId, callId: freight.call.data.callId, start: freight.call.time, end: freight.output.time, durationMs: freight.output.time - freight.call.time, rows: end.rows, totalCents: end.total_cents, exit: freight.settled.data.detail, continuedAfterCancelMs: freight.output.time - cancelResult.time }, finalScopeState: final.state, finalTaskStates: { goods: goodsTask.state, freight: freightTask.state }, humanTextInputs: 2, errors: report.errors },
    boundaries: ['Only the explicit desktop owner and its two approved members were read. No product, UI, model or message action was performed.', '0.2.5 is a preserved effective-stop failure, not a successful cancellation because task.state eventually says cancelled.', '0.2.6 retains one refused legacy cancellation and the expected tool abort; not a zero-error protocol claim.', 'Partial Goods rows/subtotal inferred later by A from elapsed time/CSV are not actual tool stdout or accepted results.'] }
  const business = { sourceFiles: report.sourceFiles, workerBatches: batches.map(batch => ({ sessionId: batch.sessionId, ledger: batch.ledger, toolCall: { seq: batch.call.seq, time: batch.call.time, turn: batch.call.data.turn, step: batch.call.data.step, callId: batch.call.data.callId, name: batch.call.data.name, arguments: args(batch.call) }, toolResult: { seq: batch.output.seq, time: batch.output.time, isError: Boolean(batch.output.data.message.isError), content: text(batch.output) }, jobSettled: batch.settled })), generatedContextSourceMetadata: logs.get(goods.sessionId).filter(event => event.type === 'user/message').map(event => ({ time: event.time, id: event.data.id, sourceKind: event.data.source?.kind })), cancelCall: { time: cancel.time, arguments: args(cancel) }, errors: report.errors }
  if (!process.argv.includes('--check')) {
    fs.writeFileSync(directory + '/independent-proof.json', JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    fs.writeFileSync(directory + '/business-native-events.json', JSON.stringify(business, null, 2) + '\n', { flag: 'wx' })
  }
  console.log(JSON.stringify({ version: spec.version, effectiveCancellation: proof.effectiveCancellation, goodsMs: proof.facts.goods.durationMs, freightAfterCancelMs: proof.facts.freight.continuedAfterCancelMs, errors: report.errors.length }))
}
