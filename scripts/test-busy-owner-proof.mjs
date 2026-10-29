import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyBusyOwnerProof } from './live/busy-owner-proof.mjs'

function sample() {
  const source = { kind: 'session-collaboration', scopeId: 'scope', taskId: 'task', taskRevision: 1, operationId: 'notification', senderSessionId: 'B', ownerSessionId: 'A', intent: 'result' }
  const text = `来自会话 B · 协作结果\n[协作 ${JSON.stringify(source)}；结果已记录。根据当前任务及证据决定下一步、返工或调用 collaboration_control finish；不要仅为确认收信回复。]\n协作目标：订单对账\n当前任务：商品核算\nITEMS_TOTAL=71`
  const message = { id: 'notification', role: 'user', source, content: [{ type: 'text', text }] }
  const task = { id: 'task', objective: '商品核算', revision: 1, state: 'completed', acceptedResultIds: ['result'] }
  const result = { id: 'result', taskId: 'task', taskRevision: 1, operationId: 'op', sender: 'B', text: 'ITEMS_TOTAL=71', evidence: ['3*19+2*7=71'], stale: false }
  const scope = { id: 'scope', objective: '订单对账', state: 'completed', members: ['A', 'B'], tasks: { task }, results: { result }, operations: {
    op: { id: 'op', taskId: 'task', taskRevision: 1, intent: 'task', target: 'B', resultId: 'result', requestInclusion: { evidence: 'native-llm-stream' } },
    notification: { id: 'notification', intent: 'result', resultId: 'result', requestInclusion: { evidence: 'native-llm-stream' } },
  } }
  const report = { sessions: { A: 'A', B: 'B' }, headers: { A: { id: 'A' }, B: { id: 'B' } }, humanInputCounts: { A: 1, B: 0 }, approvals: ['allowed-once'], errors: [], fatalErrors: [],
    tools: [{ sessionId: 'A', name: 'session_coordinator_collaboration_send', callId: 'send' }, { sessionId: 'A', name: 'acceptance_busy_work' }, { sessionId: 'B', name: 'acceptance_peer_gate' }, { sessionId: 'A', name: 'acceptance_busy_integrate' }],
    toolReceipts: [{ sessionId: 'A', callId: 'send', order: 1, isError: false }],
    timeline: [{ name: 'peer-gate', sessionId: 'B', order: 2 }, { name: 'busy-start', order: 3, turn: 1, step: 3 }, { name: 'peer-result', order: 4, resultId: 'result' }, { name: 'busy-release', order: 5, cause: 'native-peer-result', resultId: 'result' }, { name: 'busy-end', order: 6, turn: 1, step: 3 }, { name: 'integrate', order: 8, turn: 1, step: 4, arguments: { itemsTotal: 71, shipping: 9, combined: 80 } }, { name: 'verification-join', order: 9 }],
    inboundResults: [{ message: structuredClone(message) }], requestInclusions: [{ order: 7, turn: 1, step: 4, message: structuredClone(message) }],
    nativeEvents: ['A', 'B'].flatMap(sessionId => [{ sessionId, type: 'turn/start', data: { turn: 1 } }, { sessionId, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]),
  }
  return { report, scope }
}
const verify = value => verifyBusyOwnerProof(value.report, value.scope)

test('a native peer result inside A tool reaches the same-turn next model step and actual integration', () => {
  assert.equal(verify(sample()).combined, 80)
})

test('reply before A starts or after A ends cannot stand in for a reply during its running tool', () => {
  for (const order of [2, 9]) {
    const value = sample(); value.report.timeline.find(item => item.name === 'peer-result').order = order
    assert.throws(() => verify(value), /strictly inside/)
  }
})

test('a history receipt is insufficient without exact result inclusion in a later model request of the same turn', () => {
  for (const change of [value => { value.report.requestInclusions = [] }, value => { value.report.requestInclusions[0].turn = 2 }, value => { value.report.requestInclusions[0].message.source.operationId = 'another' }, value => { value.report.timeline.find(item => item.name === 'integrate').turn = 2 }]) {
    const value = sample(); change(value); assert.throws(() => verify(value))
  }
})

test('waiting, early idle joins, interrupting the busy tool or third-party human help invalidates the proof', () => {
  for (const change of [value => { value.report.tools.push({ name: 'session_coordinator_collaboration_wait' }) }, value => { value.report.timeline.find(item => item.name === 'verification-join').order = 4 }, value => { value.report.timeline.find(item => item.name === 'busy-end').turn = 2 }, value => { value.report.humanInputCounts.B = 1 }, value => { value.report.headers.B.origin = 'subagent' }]) {
    const value = sample(); change(value); assert.throws(() => verify(value))
  }
})

test('business totals, exact task evidence and successful task/scope completion are mandatory', () => {
  for (const change of [value => { value.scope.results.result.text = 'ITEMS_TOTAL=72' }, value => { value.scope.tasks.task.acceptedResultIds = [] }, value => { value.report.timeline.find(item => item.name === 'integrate').arguments.combined = 81 }, value => { value.scope.state = 'active' }, value => { value.report.nativeEvents.at(-1).data.reason.kind = 'aborted' }, value => { value.report.toolReceipts[0].order = 4 }]) {
    const value = sample(); change(value); assert.throws(() => verify(value))
  }
})

test('independent native request evidence remains decisive when the optional runtime annotation is absent', () => {
  const value = sample(); delete value.scope.operations.notification.requestInclusion
  assert.equal(verify(value).requestInclusionAnnotation, null)
  value.report.inboundResults[0].message.content[0].text = value.report.inboundResults[0].message.content[0].text.replace('订单对账', 'another objective')
  value.report.requestInclusions[0].message = structuredClone(value.report.inboundResults[0].message)
  assert.throws(() => verify(value), /canonical business result/)
})
