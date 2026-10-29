import assert from 'node:assert/strict'

/** Explicit protocol contract; all model work and native controls remain inspectable. */
export function verifyControlsProof(report) {
  const marks = name => report.timeline.filter(item => item.name === name)
  const one = name => { assert.equal(marks(name).length, 1, name); return marks(name)[0] }
  const startA = one('parallel-A-start'), startB = one('parallel-B-start')
  const endA = one('parallel-A-end'), endB = one('parallel-B-end')
  assert.ok(Math.max(startA.order, startB.order) < Math.min(endA.order, endB.order), 'both real model tools must overlap before either is released')
  const paused = one('task-A-paused'), rejected = one('paused-send-refused'), continued = one('parallel-B-result'), resumed = one('task-A-resumed'), recovered = one('resumed-A-result')
  assert.ok(paused.order < rejected.order && rejected.order < continued.order && continued.order < resumed.order && resumed.order < recovered.order, 'unrelated B continues during A pause and A resumes only after explicit approval')
  assert.equal(rejected.deliveriesBefore, rejected.deliveriesAfter, 'paused refusal cannot enqueue work')
  assert.equal(rejected.taskState, 'paused')
  assert.match(rejected.error, /not active|paused/)
  const pauseWait = one('paused-task-wait')
  assert.deepEqual({ scopeState: pauseWait.scopeState, interrupted: pauseWait.interrupted, timedOut: pauseWait.timedOut, taskState: pauseWait.taskState }, { scopeState: 'active', interrupted: true, timedOut: false, taskState: 'paused' })
  assert.equal(continued.text, 'FREIGHT_TOTAL=29')
  assert.equal(recovered.text, 'GOODS_TOTAL=71')
  const a = report.scopes.parallel
  assert.equal(a.state, 'completed')
  assert.equal(a.members.length, 3)
  assert.ok(Object.values(a.tasks).every(task => task.state === 'completed'))
  assert.equal(Object.keys(a.results).length, 3)
  const pending = one('cancel-second-active'), cancelled = one('task-A-cancelled'), late = one('late-A-result'), independent = one('cancel-B-result')
  assert.ok(pending.order < cancelled.order && cancelled.order < late.order && late.order < independent.order)
  assert.equal(cancelled.sameWorker, true)
  assert.equal(cancelled.nativeExecutionBefore, cancelled.nativeExecutionAfter, 'cancelling A cannot replace the execution handling B')
  assert.equal(cancelled.nativeCancels, 0, 'same-agent unrelated B must not be cancelled')
  assert.equal(late.taskState, 'cancelled', 'late result cannot revive A')
  assert.equal(late.newNotifications, 0, 'late cancelled work cannot wake the owner')
  assert.equal(late.text, 'OLD_GOODS_TOTAL=71')
  assert.equal(independent.text, 'UNRELATED_TOTAL=43')
  const b = report.scopes.cancel
  assert.equal(b.state, 'cancelled')
  assert.equal(b.tasks[report.cancelTaskA].state, 'cancelled')
  assert.equal(b.tasks[report.cancelTaskB].state, 'completed')
  for (const scope of Object.values(report.scopes)) for (const op of Object.values(scope.operations).filter(op => ['task', 'steer'].includes(op.intent) && op.resultId)) {
    assert.equal(op.requestInclusion?.evidence, 'native-llm-stream', 'worker business result requires actual model request consumption')
    const result = scope.results[op.resultId]
    assert.equal(result.operationId, op.id); assert.equal(result.taskId, op.taskId); assert.equal(result.taskRevision, op.taskRevision); assert.equal(result.sender, op.target)
  }
  assert.equal(report.humanInputCounts[report.sessions.owner], 1)
  for (const id of report.sessions.workers) {
    const header = report.headers[id]
    assert.equal(header.id, id); assert.notEqual(header.origin, 'subagent'); assert.equal(header.parentSession, undefined); assert.equal(header.delegationDepth ?? 0, 0)
    assert.equal(report.humanInputCounts[id], 0)
  }
  assert.equal(report.sessions.workers.length, 2)
  assert.ok(report.approvals.length >= 6)
  assert.ok(report.approvals.every(item => item.outcome === 'allowed-once' && item.syntheticScoped === true))
  for (const approval of report.approvals) {
    const asked = report.nativeEvents.find(event => event.type === 'approval/asked' && event.sessionId === report.sessions.owner && event.data.callId === approval.callId && event.data.toolName === approval.toolName)
    assert.ok(asked, 'the test answerer record must have an actual native request')
    assert.ok(report.nativeEvents.some(event => event.type === 'approval/decided' && event.sessionId === report.sessions.owner && event.data.id === asked.data.id && event.data.outcome === 'allowed-once'))
  }
  assert.ok(report.approvals.some(item => item.action === 'resume'))
  assert.equal(report.silence.durationMs >= 30000, true)
  assert.deepEqual(report.silence.before, report.silence.after, 'terminal work cannot generate new tools, messages or turns during observation')
  assert.equal(report.silence.startedAfterTerminal, true)
  assert.ok(report.turnEnds.length >= 3 && report.turnEnds.every(item => item.kind === 'completed'))
  assert.equal(report.errors.length, 0)
  assert.equal(report.fatalErrors.length, 0)
  assert.ok(!report.tools.some(item => ['spawn_teammate', 'subagent', 'session_coordinator_send', 'session_coordinator_create'].includes(item.name)))
  return { parallelOverlap: true, pauseResume: true, sameAgentCancelIsolation: true, lateResultNoRevival: true, terminalSilenceMs: report.silence.durationMs }
}
