import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyControlsProof } from './live/controls-proof.mjs'

function sample() {
  const timeline = ['parallel-A-start', 'parallel-B-start', 'parallel-A-end', 'task-A-paused', 'paused-task-wait', 'paused-send-refused', 'parallel-B-end', 'parallel-B-result', 'task-A-resumed', 'resumed-A-result', 'cancel-second-active', 'task-A-cancelled', 'late-A-result', 'cancel-B-result'].map((name, index) => ({ name, order: index + 1 }))
  Object.assign(timeline.find(item => item.name === 'paused-task-wait'), { scopeState: 'active', interrupted: true, timedOut: false, taskState: 'paused' })
  Object.assign(timeline.find(item => item.name === 'paused-send-refused'), { deliveriesBefore: 3, deliveriesAfter: 3, taskState: 'paused', error: 'collaboration is not active: paused' })
  Object.assign(timeline.find(item => item.name === 'parallel-B-result'), { text: 'FREIGHT_TOTAL=29' })
  Object.assign(timeline.find(item => item.name === 'resumed-A-result'), { text: 'GOODS_TOTAL=71' })
  Object.assign(timeline.find(item => item.name === 'task-A-cancelled'), { sameWorker: true, nativeExecutionBefore: 'B:2', nativeExecutionAfter: 'B:2', nativeCancels: 0 })
  Object.assign(timeline.find(item => item.name === 'late-A-result'), { text: 'OLD_GOODS_TOTAL=71', taskState: 'cancelled', newNotifications: 0 })
  Object.assign(timeline.find(item => item.name === 'cancel-B-result'), { text: 'UNRELATED_TOTAL=43' })
  const scope = (id, states, values) => ({ id, state: id === 'parallel' ? 'completed' : 'cancelled', members: id === 'parallel' ? ['O', 'B', 'C'] : ['O', 'B'], tasks: Object.fromEntries(states.map(([id, state]) => [id, { state }])), results: Object.fromEntries(values.map((text, index) => ['r' + index, { id: 'r' + index, text, operationId: 'op' + index, taskId: states[0][0], taskRevision: 1, sender: 'B' }])), operations: Object.fromEntries(values.map((_text, index) => ['op' + index, { id: 'op' + index, intent: 'task', resultId: 'r' + index, taskId: states[0][0], taskRevision: 1, target: 'B', requestInclusion: { evidence: 'native-llm-stream' } }])) })
  const approvals = Array.from({ length: 6 }, (_, i) => ({ callId: 'call-' + i, toolName: 'session_coordinator_collaboration_control', outcome: 'allowed-once', syntheticScoped: true, action: i === 2 ? 'resume' : 'pause' }))
  const nativeEvents = approvals.flatMap((item, index) => [{ sessionId: 'O', type: 'approval/asked', data: { id: 'approve-' + index, callId: item.callId, toolName: item.toolName } }, { sessionId: 'O', type: 'approval/decided', data: { id: 'approve-' + index, outcome: 'allowed-once' } }])
  return { timeline, scopes: { parallel: scope('parallel', [['A', 'completed'], ['B', 'completed']], ['GOODS_TOTAL=71', 'FREIGHT_TOTAL=29', 'GOODS_TOTAL=71']), cancel: scope('cancel', [['A', 'cancelled'], ['B', 'completed']], ['OLD_GOODS_TOTAL=71', 'UNRELATED_TOTAL=43']) }, cancelTaskA: 'A', cancelTaskB: 'B', sessions: { owner: 'O', workers: ['B', 'C'] }, headers: { B: { id: 'B' }, C: { id: 'C' } }, humanInputCounts: { O: 1, B: 0, C: 0 }, approvals, nativeEvents, silence: { durationMs: 30000, startedAfterTerminal: true, before: { messages: 5 }, after: { messages: 5 } }, turnEnds: ['O', 'B', 'C'].map(sessionId => ({ sessionId, kind: 'completed' })), tools: [], errors: [], fatalErrors: [] }
}

test('parallel work, pause/resume, exact cancellation and terminal silence have concrete behavior evidence', () => {
  assert.equal(verifyControlsProof(sample()).terminalSilenceMs, 30000)
})

test('serial model work or B progress only after A resumes cannot masquerade as independent parallel work', () => {
  for (const mutate of [r => { r.timeline.find(x => x.name === 'parallel-B-start').order = 4 }, r => { r.timeline.find(x => x.name === 'parallel-B-result').order = 10 }]) {
    const r = sample(); mutate(r); assert.throws(() => verifyControlsProof(r))
  }
})

test('paused dispatch side effects, implicit resume and cross-task cancellation are rejected by the proof', () => {
  for (const mutate of [r => { r.timeline.find(x => x.name === 'paused-send-refused').deliveriesAfter++ }, r => { r.approvals.forEach(x => { x.action = 'pause' }) }, r => { r.timeline.find(x => x.name === 'task-A-cancelled').nativeCancels = 1 }, r => { r.timeline.find(x => x.name === 'task-A-cancelled').nativeExecutionAfter = 'B:3' }]) {
    const r = sample(); mutate(r); assert.throws(() => verifyControlsProof(r))
  }
})

test('late work revival or notifications and hidden worker substitution cannot pass', () => {
  for (const mutate of [r => { r.timeline.find(x => x.name === 'late-A-result').taskState = 'active' }, r => { r.timeline.find(x => x.name === 'late-A-result').newNotifications++ }, r => { r.headers.B.origin = 'subagent' }, r => { r.humanInputCounts.C++ }, r => { delete r.scopes.parallel.operations.op0.requestInclusion }]) {
    const r = sample(); mutate(r); assert.throws(() => verifyControlsProof(r))
  }
})

test('an early sample, changed tool/message/turn counts or abnormal end cannot prove terminal no-pingpong', () => {
  for (const mutate of [r => { r.silence.durationMs = 29999 }, r => { r.silence.after.messages++ }, r => { r.silence.startedAfterTerminal = false }, r => { r.turnEnds[0].kind = 'cancelled' }, r => { r.scopes.cancel.state = 'active' }]) {
    const r = sample(); mutate(r); assert.throws(() => verifyControlsProof(r))
  }
})

test('approval claims without matching native decisions or timeout-only paused waits cannot pass', () => {
  for (const mutate of [r => { r.nativeEvents = [] }, r => { r.nativeEvents[1].data.id = 'another-approval' }, r => { r.timeline.find(x => x.name === 'paused-task-wait').timedOut = true }]) {
    const r = sample(); mutate(r); assert.throws(() => verifyControlsProof(r))
  }
})
