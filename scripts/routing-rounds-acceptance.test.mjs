import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessDesktopTrace } from './routing-rounds-acceptance.mjs'

const fixture = { userPrompt: '派两个独立会话实现与审查，持续推进到完成。', expected: { newIndependentChats: 2, requestedTitles: ['实现', '审查'] } }
function message(type, data, seq, time = seq) { return { type, data, seq, time } }
function tool(name, args, value, seq, time = seq) {
  const callId = 'call-' + seq
  return [message('tool/call', { callId, name: 'session_coordinator_collaboration_' + name, arguments: JSON.stringify(args) }, seq, time),
    message('tool/result', { message: { toolCallId: callId, role: 'tool', isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } }, seq + 1, time + 1)]
}
function sample() {
  const scope = { id: 'scope', owner: 'A', members: ['A', 'B', 'C'], authorization: { kind: 'native-scoped-approval', callId: 'call-2' }, creations: { B: { status: 'created', config: { title: '实现' } }, C: { status: 'created', config: { title: '审查' } } } }
  const started = tool('start', { newSessions: [{ title: '实现' }, { title: '审查' }] }, scope, 2)
  started[1].seq = 5; started[1].time = 5
  const owner = [{ type: 'session', id: 'A' }, message('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: fixture.userPrompt }] }, 1),
    started[0],
    message('approval/asked', { id: 'approval', callId: 'call-2', toolName: 'session_coordinator_collaboration_start' }, 3),
    message('approval/decided', { id: 'approval', outcome: 'allowed-once' }, 4), started[1],
    ...tool('control', { scopeId: 'scope', action: 'finish', resultIds: ['result-2'] }, { id: 'scope', state: 'completed' }, 30),
    message('turn/end', { reason: { kind: 'completed' } }, 32)]
  const members = { B: [{ type: 'session', id: 'B', delegationDepth: 0 }, message('session/title', { title: '实现' }, 1)], C: [{ type: 'session', id: 'C' }, message('session/title', { title: '审查' }, 1)] }
  for (let round = 0; round < 3; round++) {
    const operationId = 'operation-' + round, seq = 2 + round * 3, time = 10 + round * 5
    const source = { kind: 'session-collaboration', scopeId: 'scope', taskId: 'task', taskRevision: 1, operationId, ownerSessionId: 'A', senderSessionId: 'A', intent: 'task' }
    members.B.push(message('user/message', { id: operationId, source }, seq, time), ...tool('result', { scopeId: 'scope', taskId: 'task', taskRevision: 1, operationId }, { id: 'result-' + round, taskId: 'task', taskRevision: 1, operationId, sender: 'B', stale: false }, seq + 1, time + 1))
  }
  return { owner, members }
}
function verdict(data, options) { return assessDesktopTrace(data.owner, data.members, fixture, options) }

test('three ordered exchanges pair exact native task inputs with successful correlated result receipts', () => {
  const result = verdict(sample())
  assert.equal(result.pass, true, JSON.stringify(result.failures))
  assert.equal(result.roundChains[0].rounds, 3)
  assert.equal(result.layer, 'unhinted-desktop-routing-and-rounds')
})

test('temporary teammates and later human correction cannot masquerade as independent routing success', () => {
  const data = sample()
  data.owner.splice(2, 0, message('tool/call', { callId: 'wrong', name: 'spawn_teammate', arguments: '{}' }, 2))
  data.owner.splice(3, 0, message('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '改用会话协调器。' }] }, 3))
  const result = verdict(data)
  assert.equal(result.pass, false)
  assert.equal(result.checks.noTemporarySubstitution, false)
  assert.equal(result.checks.noHumanCorrection, false)
})

test('the recorded approval kind and sidebar-looking name do not replace native approval or independent identity', () => {
  const data = sample()
  data.owner = data.owner.filter(event => event.type !== 'approval/decided')
  data.members.B[0].origin = 'subagent'
  const result = verdict(data)
  assert.equal(result.checks.nativeScopedApprovalObserved, false)
  assert.equal(result.checks.nativeIndependentIdentities, false)
})

test('scope approval and participants must belong to the requested creation, not another call or recipient set', () => {
  const data = sample(), receipt = data.owner.find(event => event.type === 'tool/result')
  const scope = JSON.parse(receipt.data.message.content[0].text)
  scope.authorization.callId = 'another-call'; scope.members.push('unrequested-business-session')
  receipt.data.message.content[0].text = JSON.stringify(scope)
  const result = verdict(data)
  assert.equal(result.checks.approvedScopeCreated, false)
  assert.equal(result.checks.exactApprovedMembers, false)
})

test('parallel deliveries, unrelated tasks, duplicate evidence or stale results do not count as three automatic rounds', () => {
  for (const variant of ['parallel', 'tasks', 'stale', 'duplicate']) {
    const data = sample()
    for (const event of data.members.B) {
      if (variant === 'parallel' && event.type === 'user/message') event.time = 10
      if (variant === 'tasks') {
        if (event.type === 'user/message') event.data.source.taskId = event.data.id
        if (event.type === 'tool/call') { const args = JSON.parse(event.data.arguments); args.taskId = args.operationId; event.data.arguments = JSON.stringify(args) }
        if (event.type === 'tool/result') { const value = JSON.parse(event.data.message.content[0].text); value.taskId = value.operationId; event.data.message.content[0].text = JSON.stringify(value) }
      }
      if (variant === 'stale' && event.type === 'tool/result') { const value = JSON.parse(event.data.message.content[0].text); value.stale = true; event.data.message.content[0].text = JSON.stringify(value) }
      if (variant === 'duplicate' && event.type === 'tool/result') { const value = JSON.parse(event.data.message.content[0].text); value.id = 'same-result'; event.data.message.content[0].text = JSON.stringify(value) }
    }
    assert.equal(verdict(data).checks.orderedSameTaskRounds, false, variant)
  }
})

test('routing-only is explicitly limited and subsequent unrelated human work does not rewrite a completed case', () => {
  const data = sample()
  data.owner.push(message('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '另一个无关任务。' }] }, 40))
  assert.equal(verdict(data).pass, true)
  const result = verdict(data, { routingOnly: true })
  assert.equal(result.pass, true)
  assert.equal(result.layer, 'unhinted-desktop-routing')
  assert.equal(result.checks.orderedSameTaskRounds, undefined)
  assert.match(result.boundaries.join(' '), /Business file contents/)
})

test('one extra human continuation cannot unlock the third automatic exchange', () => {
  const data = sample()
  data.owner.push(message('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '请继续第三次。' }] }, 20))
  assert.equal(verdict(data).checks.noHumanCorrection, false)
})

test('human input in any fresh collaborating chat invalidates autonomy until scope completion', () => {
  const data = sample()
  data.members.C.push(message('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '误入另一个草稿。' }] }, 2, 18))
  const result = verdict(data)
  assert.equal(result.pass, false)
  assert.equal(result.checks.noPeerHumanAssistance, false)
  assert.deepEqual(result.humanInputCounts, { A: 1, B: 0, C: 1 })
  data.members.C.at(-1).time = 40
  assert.equal(verdict(data).pass, true, 'Unrelated human work after scope completion is outside the case')
})

test('both native temporary-agent tools fail independent-chat acceptance within its completion window', () => {
  for (const name of ['spawn_teammate', 'subagent']) {
    const data = sample()
    data.owner.push(message('tool/call', { callId: 'temporary', name, arguments: '{}' }, 20))
    assert.equal(verdict(data).checks.noTemporarySubstitution, false, name)
    data.owner.at(-1).seq = 40
    assert.equal(verdict(data).pass, true, 'Calls after accepted scope completion belong to later work')
  }
})

test('peer result receipts after completed scope cannot fill a missing automatic round', () => {
  const data = sample()
  data.members.B.at(-1).time = 40
  assert.equal(verdict(data).checks.orderedSameTaskRounds, false)
})
