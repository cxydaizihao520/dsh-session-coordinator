#!/usr/bin/env node
/** Stronger, read-only audit over saved native traces; no model/approval/production side effects. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyLoopBoundary } from './live/loop-proof.mjs'

const argsOf = call => typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
export function reviewLoopNativeTrace(report) {
  const base = verifyLoopBoundary(report), scope = report.scope
  const [task] = Object.values(scope.tasks), peer = scope.members.find(id => id !== scope.owner)
  assert.equal(report.watchdogStopped, undefined, 'external cancellation cannot stand in for the production guard')
  assert.equal(new Set(scope.members).size, 2)
  assert.deepEqual(Object.keys(report.countersBefore).sort(), [...scope.members].sort())
  for (const id of scope.members) {
    assert.equal(report.headers[id].id, id)
    assert.notEqual(report.headers[id].origin, 'subagent')
    assert.equal(report.headers[id].parentSession, undefined)
    assert.equal(report.headers[id].delegationDepth ?? 0, 0)
  }
  const starts = report.tools.filter(call => call.name === 'session_coordinator_collaboration_start')
  assert.equal(starts.length, 1, 'a second scope must fail this acceptance even if its approval was rejected')
  assert.equal(starts[0].sessionId, scope.owner)
  assert.equal(scope.authorization.callId, starts[0].callId)
  assert.equal(report.tools.filter(call => call.name === 'session_coordinator_collaboration_task').length, 1)
  assert.ok(report.tools.every(call => call.name.startsWith('session_coordinator_collaboration_')), 'no temporary, legacy, or unrelated tools')
  const asked = report.events.filter(event => event.type === 'approval/asked')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].sessionId, scope.owner)
  assert.equal(asked[0].data.callId, starts[0].callId)
  assert.equal(asked[0].data.toolName, starts[0].name)
  const decision = report.events.filter(event => event.type === 'approval/decided')
  assert.equal(decision.length, 1)
  assert.equal(decision[0].data.id, asked[0].data.id)
  assert.equal(decision[0].data.outcome, 'allowed-once')
  const operations = Object.values(scope.operations).filter(op => op.intent === 'task').sort((a, b) => a.createdAt - b.createdAt)
  const results = Object.values(scope.results)
  const actualResultCalls = report.tools.filter(call => call.name === 'session_coordinator_collaboration_result')
  assert.equal(operations.length, results.length)
  assert.equal(actualResultCalls.length, results.length)
  let last = -1
  for (const op of operations) {
    assert.equal(op.taskId, task.id); assert.equal(op.taskRevision, task.revision)
    assert.equal(op.sender, scope.owner); assert.equal(op.target, peer)
    assert.equal(op.requestInclusion?.evidence, 'native-llm-stream', 'every round requires actual peer model consumption')
    const result = scope.results[op.resultId]
    assert.ok(result)
    assert.equal(result.operationId, op.id); assert.equal(result.taskId, op.taskId); assert.equal(result.taskRevision, op.taskRevision)
    assert.equal(result.sender, peer); assert.equal(result.stale, false)
    const calls = actualResultCalls.filter(call => call.sessionId === peer && argsOf(call).operationId === op.id)
    assert.equal(calls.length, 1, 'each result must be submitted by one real peer tool call')
    const args = argsOf(calls[0])
    assert.equal(args.scopeId, scope.id); assert.equal(args.taskId, task.id); assert.equal(args.taskRevision, task.revision)
    assert.equal(args.text, result.text); assert.deepEqual(args.evidence ?? [], result.evidence)
    assert.ok(op.createdAt >= last && result.createdAt >= op.createdAt, 'each actual round starts after its preceding result')
    last = result.createdAt
  }
  const controls = report.tools.filter(call => call.name === 'session_coordinator_collaboration_control')
  if (report.mode === 'normal-finish') {
    assert.equal(report.errors.length, 0, 'normal completion cannot hide tool errors')
    assert.equal(controls.length, 2)
    assert.ok(controls.every(call => argsOf(call).action === 'finish' && argsOf(call).scopeId === scope.id))
    assert.deepEqual([...task.acceptedResultIds].sort(), results.map(result => result.id).sort())
  } else {
    assert.equal(controls.length, 0, 'scope cannot be stopped by a model control instead of the runtime budget')
    assert.equal(task.state, 'active', 'budget stop must not fabricate business completion')
    if (report.mode === 'varied-ack') {
      assert.equal(report.errors.length, 1, 'exactly the attempted fifth dispatch must be denied by the cap')
      const error = report.errors[0]
      const call = report.tools.find(call => call.callId === error.data.message.toolCallId && call.sessionId === error.sessionId)
      assert.equal(call.name, 'session_coordinator_collaboration_send')
      assert.equal(call.sessionId, scope.owner); assert.equal(argsOf(call).scopeId, scope.id); assert.equal(argsOf(call).taskId, task.id)
      assert.equal(error.data.message.content.map(part => part.text ?? '').join(''), 'Error: operation budget exhausted')
      assert.equal(report.tools.filter(call => call.name === 'session_coordinator_collaboration_send').length, 5)
    } else {
      assert.ok(report.errors.length <= 1, 'only the optional attempted dispatch after the no-progress stop may be refused')
      if (report.errors.length) {
        assert.equal(operations.length, 4)
        assert.equal(task.noProgress, 3)
        assert.equal(Object.keys(scope.operations).length, 7)
        assert.equal(scope.budget.maxOperations, 16)
        const error = report.errors[0]
        const call = report.tools.find(call => call.callId === error.data.message.toolCallId && call.sessionId === error.sessionId)
        assert.equal(call?.name, 'session_coordinator_collaboration_send')
        assert.equal(call.sessionId, scope.owner); assert.equal(argsOf(call).scopeId, scope.id); assert.equal(argsOf(call).taskId, task.id)
        assert.equal(error.data.message.content.map(part => part.text ?? '').join(''), 'Error: collaboration is not active: no-progress dispatch budget exhausted; review results or revise the approach')
        const sends = report.tools.filter(call => call.name === 'session_coordinator_collaboration_send')
        assert.equal(sends.length, 5)
        assert.equal(sends.at(-1).callId, call.callId, 'only the fifth and final send may carry this expected refusal')
      }
    }
  }
  for (const id of scope.members) {
    const turns = report.events.filter(event => event.type === 'turn/start' && event.sessionId === id)
    const ends = report.events.filter(event => event.type === 'turn/end' && event.sessionId === id)
    assert.equal(turns.length, report.countersBefore[id].turns)
    assert.equal(ends.length, turns.length)
    for (const turn of turns) {
      const matching = ends.filter(end => end.data.turn === turn.data.turn)
      assert.equal(matching.length, 1); assert.equal(matching[0].data.reason.kind, 'completed')
      assert.ok(matching[0].time <= report.quietStartedAt, 'quiet observation must start after every real turn ends')
    }
  }
  return { ...base, independentHeaders: true, nativeApprovalBound: true, actualCorrelatedRounds: operations.length, errors: report.errors.length, externalWatchdogUsed: false, scopeReopened: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.argv[2], output = process.argv[3]
  if (!source || !output || resolve(source) === resolve(output)) throw new Error('Usage: node scripts/review-loop-native-traces.mjs original-report.json new-independent-review.json')
  const bytes = fs.readFileSync(source), report = JSON.parse(bytes)
  const reviewed = { kind: 'independent-saved-trace-review', newModelRun: false, source: resolve(source), sourceSha256: createHash('sha256').update(bytes).digest('hex'), originalPass: report.pass }
  try { reviewed.result = reviewLoopNativeTrace(report); reviewed.pass = true }
  catch (error) { reviewed.pass = false; reviewed.failure = String(error?.stack ?? error) }
  fs.writeFileSync(output, JSON.stringify(reviewed, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(reviewed, null, 2)); if (!reviewed.pass) process.exitCode = 1
}
