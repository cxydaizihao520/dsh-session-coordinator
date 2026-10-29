import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyLoopBoundary } from './live/loop-proof.mjs'

function sample() {
  return { mode: 'repeated-ack', scope: { owner: 'A', members: ['A', 'B'], state: 'budget-exhausted', reason: 'no-progress dispatch budget exhausted', budget: { maxNoProgress: 3, maxOperations: 16 }, tasks: { t: { noProgress: 3 } }, results: Object.fromEntries([1, 2, 3, 4].map(i => [i, { text: '收到，请继续', evidence: [] }])), operations: { a: {}, b: {} } }, humanInputCounts: { A: 1, B: 0 }, approvals: ['allowed-once'], countersBefore: { A: { turns: 1, tools: 12, messages: 3 }, B: { turns: 4, tools: 4, messages: 4 } }, countersAfter: { A: { turns: 1, tools: 12, messages: 3 }, B: { turns: 4, tools: 4, messages: 4 } }, quietStartedAt: 1, quietEndedAt: 30002, fatalErrors: [], nativeEnds: [{ reason: 'completed' }, { reason: 'completed' }] }
}
test('bounded duplicate acknowledgements stop and remain quiet', () => assert.equal(verifyLoopBoundary(sample()).resultCount, 4))
for (const [name, mutate] of [
  ['new turn after stop fails', r => r.countersAfter.B.turns++],
  ['new message after stop fails', r => r.countersAfter.A.messages++],
  ['operation cap cannot stand in for no-progress detection', r => r.scope.reason = 'operation budget exhausted'],
  ['short observation cannot prove the agreed quiet window', r => r.quietEndedAt = 100],
  ['new human message cannot rescue or stop the test', r => r.humanInputCounts.A++],
]) test(name, () => { const r = sample(); mutate(r); assert.throws(() => verifyLoopBoundary(r)) })
