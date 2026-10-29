import assert from 'node:assert/strict'

export function verifyLoopBoundary(report) {
  const { scope, countersBefore, countersAfter } = report
  assert.equal(scope.members.length, 2)
  assert.equal(Object.keys(scope.tasks).length, 1)
  assert.deepEqual(report.humanInputCounts, { [scope.owner]: 1, [scope.members.find(id => id !== scope.owner)]: 0 })
  assert.deepEqual(report.approvals, ['allowed-once'])
  assert.ok(report.quietEndedAt - report.quietStartedAt >= 30000)
  assert.deepEqual(countersAfter, countersBefore, 'no task message, model tool call or new turn during the post-stop observation window')
  assert.equal(report.fatalErrors.length, 0)
  assert.ok(report.nativeEnds.length >= 2)
  assert.ok(report.nativeEnds.every(end => end.reason === 'completed'))
  if (report.mode === 'repeated-ack') {
    assert.equal(scope.state, 'budget-exhausted')
    assert.match(scope.reason, /no-progress/)
    assert.equal(scope.budget.maxNoProgress, 3)
    const results = Object.values(scope.results)
    assert.ok(results.length >= 3 && results.length <= 5)
    assert.ok(results.every(result => result.text === '收到，请继续' && result.evidence.length === 0))
    assert.ok(Object.values(scope.tasks)[0].noProgress >= 3)
    assert.ok(Object.keys(scope.operations).length < scope.budget.maxOperations, 'the no-progress guard must stop before the absolute operation cap')
  } else if (report.mode === 'varied-ack') {
    assert.equal(scope.state, 'budget-exhausted')
    assert.match(scope.reason, /operation budget/)
    assert.equal(scope.budget.maxOperations, 8)
    assert.equal(Object.keys(scope.operations).length, 8)
    const results = Object.values(scope.results)
    assert.equal(results.length, 4)
    assert.equal(new Set(results.map(result => result.text)).size, 4)
    assert.ok(results.every(result => /^ACK=\d+$/.test(result.text) && result.evidence.length === 0))
  } else {
    assert.equal(scope.state, 'completed')
    assert.equal(Object.values(scope.tasks)[0].state, 'completed')
    assert.equal(Object.values(scope.results).length, 1)
    assert.equal(Object.values(scope.results)[0].text, 'TOTAL=43')
  }
  return { scopeState: scope.state, resultCount: Object.keys(scope.results).length, noProgress: Object.values(scope.tasks)[0].noProgress, quietMs: report.quietEndedAt - report.quietStartedAt }
}
