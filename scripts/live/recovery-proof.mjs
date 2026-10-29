import assert from 'node:assert/strict'

const work = scope => Object.values(scope.operations).filter(op => op.intent === 'task')
const controls = report => report.tools.filter(tool => tool.name === 'session_coordinator_collaboration_control')

export function verifyRecoveryFailure(failed) {
  const scope = failed.scope, original = work(scope)[0], task = Object.values(scope.tasks)[0]
  assert.equal(failed.scopeCount, 1)
  assert.equal(failed.errors.length, 0)
  assert.deepEqual(failed.approvals.map(item => item.outcome), ['allowed-once'], 'one actual initial scope approval')
  assert.equal(work(scope).length, 1, 'no automatic redispatch before user recovery')
  assert.equal(task.state, 'recovery-required')
  assert.equal(scope.state, 'active', 'do not terminally fail the scope merely to claim recovery later')
  assert.equal(original.status, 'admitted')
  assert.equal(original.requestInclusion?.evidence, 'native-llm-stream')
  assert.equal(task.attention.code, 'NETWORK')
  assert.ok(task.attention.operationIds.includes(original.id))
  assert.deepEqual(failed.fatalErrors.map(item => [item.sessionId, item.code]), [[failed.sessions.B, 'NETWORK']])
  assert.equal(Object.keys(scope.results).length, 0, 'failed execution is not a business result')
  const wait = failed.waits.find(item => item.needsAttention && item.attention.some(item => item.code === 'NETWORK' && item.operationIds.includes(original.id)))
  assert.ok(wait, 'A must actually receive NETWORK attention from its native wait')
  assert.ok(failed.ownerRequestAttention.includes(task.attention.id), 'the real owner model request must contain the exact attention message')
  assert.deepEqual(failed.ledger.entries.map(item => [item.kind, item.operationId, item.amount]), [['debit', original.id, -12]])
  assert.equal(failed.ledger.balance, 88)
  assert.ok(!controls(failed).some(item => ['resume', 'fail', 'cancel'].includes(item.args.action)))
  assert.deepEqual(failed.humanInputCounts, { [scope.owner]: 1, [failed.sessions.B]: 0 })
  return { originalOperationId: original.id, balance: 88, needsAttention: true }
}

export function verifyRecoveryReopen(failed, reopened) {
  const scope = failed.scope
  assert.notEqual(failed.pid, reopened.pid)
  assert.equal(reopened.scopeCount, 1)
  assert.equal(reopened.scope.id, scope.id)
  assert.equal(reopened.scope.state, 'recovery-required')
  assert.deepEqual(work(reopened.scope), work(scope), 'reopen cannot replay or replace the original work')
  assert.deepEqual(reopened.ledger, failed.ledger, 'reopen cannot apply side effects')
  assert.equal(reopened.modelRequests, 0)
  assert.deepEqual(reopened.tools, [])
  assert.deepEqual(reopened.approvals, [])
  assert.deepEqual(reopened.humanInputCounts, failed.humanInputCounts)
  return { autoReplayed: false, modelRequests: 0, state: reopened.scope.state }
}

/** The three reports come from separate native processes sharing one isolated durable home. */
export function verifyRecoveryProof(failed, reopened, recovered) {
  const scope = failed.scope, original = work(scope)[0], task = Object.values(scope.tasks)[0]
  assert.equal(failed.phase, 'fail'); assert.equal(reopened.phase, 'inspect'); assert.equal(recovered.phase, 'recover')
  assert.equal(new Set([failed.pid, reopened.pid, recovered.pid]).size, 3, 'reopen must use actual distinct processes')
  assert.ok(failed.pid && reopened.pid && recovered.pid)
  for (const report of [failed, reopened, recovered]) {
    assert.equal(report.scope.id, scope.id, 'recovery cannot replace the scope')
    assert.deepEqual(report.scope.members, scope.members)
    assert.equal(report.scope.owner, scope.owner)
    assert.equal(report.scopeCount, 1, 'no replacement scope')
    assert.equal(Object.keys(report.scope.tasks).length, 1, 'reuse the original task')
    assert.equal(report.scope.tasks[task.id].revision, task.revision)
    assert.equal(report.headers[failed.sessions.B].id, failed.sessions.B)
    assert.notEqual(report.headers[failed.sessions.B].origin, 'subagent')
    assert.equal(report.headers[failed.sessions.B].parentSession, undefined)
    assert.equal(report.headers[failed.sessions.B].delegationDepth ?? 0, 0)
    assert.equal(report.errors.length, 0, 'tool errors cannot be hidden by eventual recovery')
    const allowed = new Set(['acceptance_recovery_ledger', ...['start', 'task', 'send', 'result', 'control', 'status', 'wait'].map(name => 'session_coordinator_collaboration_' + name)])
    assert.ok(report.tools.every(tool => allowed.has(tool.name)), 'unrelated tools and legacy routes cannot repair the proof')
  }
  verifyRecoveryFailure(failed)
  verifyRecoveryReopen(failed, reopened)
  assert.notEqual(reopened.scope.authorization.process, recovered.scope.authorization.process, 'recovery must renew process-bound authorization')
  assert.equal(recovered.scope.state, 'completed')
  assert.equal(recovered.scope.tasks[task.id].state, 'completed')
  assert.equal(recovered.fatalErrors.length, 0)
  assert.deepEqual(recovered.humanInputCounts, { [scope.owner]: 2, [failed.sessions.B]: 0 })
  const inspect = recovered.reconciliations[0]
  assert.ok(inspect && inspect.operationId === original.id && inspect.balance === 88)
  const resume = controls(recovered).filter(item => item.args.action === 'resume')
  assert.equal(resume.length, 2, 'resume the original scope and original task explicitly')
  assert.ok(resume.some(item => !item.args.taskId) && resume.some(item => item.args.taskId === task.id))
  for (const tool of resume) {
    assert.ok(inspect.order < tool.order, 'reconcile exact old side effects before resume')
    assert.ok(recovered.approvals.some(item => item.callId === tool.callId && item.outcome === 'allowed-once' && item.afterHumanRecovery), 'each resume needs actual native approval after the new human request')
  }
  const later = work(recovered.scope).filter(op => op.id !== original.id)
  assert.equal(later.length, 1, 'only the explicitly remaining work is dispatched')
  assert.equal(later[0].target, original.target)
  assert.equal(later[0].taskId, original.taskId)
  assert.equal(later[0].taskRevision, original.taskRevision)
  assert.equal(later[0].requestInclusion?.evidence, 'native-llm-stream')
  assert.deepEqual(recovered.scope.operations[original.id], reopened.scope.operations[original.id], 'preserve the original operation and its execution evidence')
  assert.deepEqual(recovered.ledger.entries.map(item => [item.kind, item.operationId, item.amount]), [['debit', original.id, -12], ['credit', later[0].id, 5]])
  assert.equal(recovered.ledger.balance, 93)
  assert.equal(recovered.ledger.entries[1].originalOperationId, original.id)
  const results = Object.values(recovered.scope.results)
  assert.equal(results.length, 1)
  const result = results[0]
  assert.equal(result.operationId, later[0].id); assert.equal(result.sender, original.target)
  assert.equal(result.taskId, task.id); assert.equal(result.taskRevision, task.revision)
  assert.equal(result.stale, false); assert.equal(result.text, 'BALANCE=93')
  assert.ok(result.evidence.length && recovered.scope.tasks[task.id].acceptedResultIds.includes(result.id))
  assert.ok(controls(recovered).some(item => item.args.action === 'finish' && item.args.taskId === task.id))
  assert.ok(controls(recovered).some(item => item.args.action === 'finish' && !item.args.taskId))
  return { originalOperationId: original.id, resumedOperationId: later[0].id, taskId: task.id, scopeId: scope.id, balance: 93, debitApplications: 1, creditApplications: 1, separateProcesses: 3 }
}
