import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyRecoveryFailure, verifyRecoveryReopen, verifyRecoveryProof } from './live/recovery-proof.mjs'

function sample() {
  const original = { id: 'original', target: 'B', taskId: 'task', taskRevision: 1, intent: 'task', status: 'admitted', requestInclusion: { evidence: 'native-llm-stream' } }
  const task = { id: 'task', revision: 1, state: 'recovery-required', attention: { id: 'attention', code: 'NETWORK', operationIds: ['original'] } }
  const entry = { kind: 'debit', amount: -12, operationId: 'original' }
  const failed = { phase: 'fail', pid: 11, sessions: { A: 'A', B: 'B' }, scopeCount: 1, headers: { B: { id: 'B' } }, scope: { id: 'scope', owner: 'A', members: ['A', 'B'], state: 'active', authorization: { process: 'old-process' }, tasks: { task }, operations: { original }, results: {} }, errors: [], fatalErrors: [{ sessionId: 'B', code: 'NETWORK' }], tools: [], approvals: [], waits: [{ needsAttention: true, attention: [task.attention] }], ownerRequestAttention: ['attention'], ledger: { balance: 88, entries: [entry] }, humanInputCounts: { A: 1, B: 0 } }
  const reopened = structuredClone(failed)
  failed.approvals = [{ outcome: 'allowed-once' }]
  Object.assign(reopened, { phase: 'inspect', pid: 22, modelRequests: 0 }); reopened.scope.state = 'recovery-required'
  const recovered = structuredClone(reopened)
  Object.assign(recovered, { phase: 'recover', pid: 33, fatalErrors: [], reconciliations: [{ operationId: 'original', balance: 88, order: 1 }], humanInputCounts: { A: 2, B: 0 } })
  recovered.scope.state = 'completed'; recovered.scope.authorization.process = 'new-process'
  recovered.scope.tasks.task.state = 'completed'; recovered.scope.tasks.task.acceptedResultIds = ['result']
  recovered.scope.operations.remaining = { id: 'remaining', target: 'B', taskId: 'task', taskRevision: 1, intent: 'task', requestInclusion: { evidence: 'native-llm-stream' } }
  recovered.scope.results.result = { id: 'result', taskId: 'task', taskRevision: 1, operationId: 'remaining', sender: 'B', text: 'BALANCE=93', stale: false, evidence: ['debit already applied under original; remaining credit +5 applied once'] }
  recovered.ledger = { balance: 93, entries: [structuredClone(entry), { kind: 'credit', amount: 5, operationId: 'remaining', originalOperationId: 'original' }] }
  recovered.tools = [
    { name: 'session_coordinator_collaboration_control', callId: 'scope-resume', order: 2, args: { action: 'resume' } },
    { name: 'session_coordinator_collaboration_control', callId: 'task-resume', order: 3, args: { action: 'resume', taskId: 'task' } },
    { name: 'session_coordinator_collaboration_control', callId: 'task-finish', order: 5, args: { action: 'finish', taskId: 'task' } },
    { name: 'session_coordinator_collaboration_control', callId: 'scope-finish', order: 6, args: { action: 'finish' } },
  ]
  recovered.approvals = ['scope-resume', 'task-resume'].map(callId => ({ callId, outcome: 'allowed-once', afterHumanRecovery: true }))
  return { failed, reopened, recovered }
}
const verify = ({ failed, reopened, recovered }) => verifyRecoveryProof(failed, reopened, recovered)

test('separate failure and read-only process-reopen proofs precede authorized same-scope remaining work', () => {
  const value = sample()
  assert.equal(verifyRecoveryFailure(value.failed).balance, 88)
  assert.equal(verifyRecoveryReopen(value.failed, value.reopened).autoReplayed, false)
  assert.equal(verify(value).balance, 93)
})

test('native NETWORK must reach the actual owner wait and model request, not merely a fixture log', () => {
  for (const mutate of [value => { value.failed.waits = [] }, value => { value.failed.ownerRequestAttention = [] }, value => { value.failed.fatalErrors = [] }, value => { value.failed.scope.tasks.task.attention.operationIds = ['other'] }]) {
    const value = sample(); mutate(value); assert.throws(() => verify(value))
  }
})

test('automatic replacement, fabricated results and terminal fail are not recovery', () => {
  for (const mutate of [value => { value.failed.scope.operations.retry = { intent: 'task' } }, value => { value.failed.scope.results.fake = {} }, value => { value.failed.scope.state = 'failed' }, value => { value.recovered.scope.id = 'new-scope' }, value => { value.recovered.scopeCount = 2 }, value => { value.recovered.scope.tasks.task.revision = 2 }]) {
    const value = sample(); mutate(value); assert.throws(() => verify(value))
  }
})

test('a real process reopen must not model-run, replay, apply effects or renew authority automatically', () => {
  for (const mutate of [value => { value.reopened.pid = value.failed.pid }, value => { value.reopened.modelRequests = 1 }, value => { value.reopened.tools.push({ name: 'send' }) }, value => { value.reopened.scope.operations.original.status = 'submitted' }, value => { value.reopened.ledger.balance = 76 }, value => { value.recovered.scope.authorization.process = 'old-process' }]) {
    const value = sample(); mutate(value); assert.throws(() => verify(value))
  }
})

test('new human input and exact native approval must follow side-effect reconciliation', () => {
  for (const mutate of [value => { value.recovered.humanInputCounts.A = 1 }, value => { value.recovered.approvals = [] }, value => { value.recovered.approvals[0].afterHumanRecovery = false }, value => { value.recovered.reconciliations[0].operationId = 'other' }, value => { value.recovered.reconciliations[0].order = 4 }, value => { value.recovered.tools[1].args.taskId = 'other' }]) {
    const value = sample(); mutate(value); assert.throws(() => verify(value))
  }
})

test('only unfinished credit is applied; original debit and operation evidence remain intact', () => {
  for (const mutate of [value => { value.recovered.ledger.entries.push({ kind: 'debit', amount: -12, operationId: 'remaining' }) }, value => { value.recovered.ledger.entries[1].originalOperationId = 'other' }, value => { value.recovered.scope.operations.original.error = 'rewritten' }, value => { value.recovered.scope.results.result.text = 'BALANCE=81' }, value => { value.recovered.scope.tasks.task.acceptedResultIds = [] }, value => { value.recovered.scope.state = 'active' }]) {
    const value = sample(); mutate(value); assert.throws(() => verify(value))
  }
})
