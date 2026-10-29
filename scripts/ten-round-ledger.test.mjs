import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyTenRoundLedger } from './live/ten-round-ledger.mjs'

function fixture() {
  const scope = { state: 'completed', members: ['owner', 'peer'], tasks: { t: { id: 't', revision: 1, state: 'completed', acceptedResultIds: [] } }, operations: {}, results: {} }
  for (let n = 1; n <= 10; n++) {
    const id = 'op-' + n, resultId = 'result-' + n
    scope.operations[id] = { id, intent: 'task', taskId: 't', taskRevision: 1, target: 'peer', createdAt: n * 10, requestInclusion: { evidence: 'native-llm-stream' } }
    scope.operations[resultId] = { id: resultId, intent: 'result' }
    scope.results[resultId] = { id: resultId, operationId: id, taskId: 't', taskRevision: 1, sender: 'peer', createdAt: n * 10 + 5, text: `ROUND=${n};OPEN=${100 + (n - 1) ** 2};IN=${3 * n};OUT=${n + 1};CLOSE=${100 + n ** 2}` }
    scope.tasks.t.acceptedResultIds.push(resultId)
  }
  return scope
}
test('ten actual sequential ledger exchanges verify final inventory 200', () => assert.equal(verifyTenRoundLedger(fixture()).at(-1).ledger, 'ROUND=10;OPEN=181;IN=30;OUT=11;CLOSE=200'))
for (const [name, mutate] of [
  ['one reply with ten lines is not ten exchanges', s => { delete s.results['result-10'] }],
  ['parallel dispatch cannot count as a sequential round', s => { s.operations['op-2'].createdAt = 12 }],
  ['wrong peer arithmetic cannot pass transport completion', s => { s.results['result-10'].text = s.results['result-10'].text.replace('CLOSE=200', 'CLOSE=201') }],
  ['history admission cannot replace actual model inclusion', s => { delete s.operations['op-7'].requestInclusion }],
  ['unaccepted results cannot count as owner verification', s => { s.tasks.t.acceptedResultIds.pop() }],
]) test(name, () => { const scope = fixture(); mutate(scope); assert.throws(() => verifyTenRoundLedger(scope)) })
