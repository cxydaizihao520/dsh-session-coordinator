import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { reviewLoopNativeTrace } from './review-loop-native-traces.mjs'

// Mutate copies of actual filtered traces; the original model evidence is never rewritten.
const load = mode => JSON.parse(fs.readFileSync(new URL(`../docs/acceptance/collaboration-loop-${mode}-live/collaboration-loop-${mode}.json`, import.meta.url)))
test('three actual saved native cases satisfy independent round/approval/error/quiet checks', () => {
  for (const mode of ['normal', 'boundary', 'varied']) assert.equal(reviewLoopNativeTrace(load(mode)).externalWatchdogUsed, false)
})
for (const [name, mode, mutate] of [
  ['normal errors cannot be hidden behind eventual completion', 'normal', report => report.errors.push({})],
  ['watchdog cancellation cannot claim runtime prevention', 'boundary', report => { report.watchdogStopped = true }],
  ['second scope attempts cannot silently change authorization', 'boundary', report => report.tools.push({ ...report.tools.find(call => call.name === 'session_coordinator_collaboration_start'), callId: 'another-scope' })],
  ['temporary identity cannot replace native independent chat', 'normal', report => { report.headers[report.sessions.B].origin = 'subagent' }],
  ['uncorrelated result cannot count as another model round', 'boundary', report => { Object.values(report.scope.results)[0].operationId = 'other-task-operation' }],
  ['history-only task admission cannot prove model execution', 'boundary', report => { delete Object.values(report.scope.operations).find(op => op.intent === 'task').requestInclusion }],
  ['varied error must belong to the actual refused cap dispatch', 'varied', report => { report.errors[0].data.message.toolCallId = 'different' }],
  ['quiet window cannot begin before a remaining turn ends', 'normal', report => { report.events.find(event => event.type === 'turn/end').time = report.quietEndedAt + 1 }],
]) test(name, () => { const report = load(mode); mutate(report); assert.throws(() => reviewLoopNativeTrace(report)) })

test('the final duplicate-loop trace permits only its exact post-stop no-progress dispatch refusal', () => {
  const path = new URL('../docs/acceptance/journeys-0.2.3/loop-final/collaboration-loop-boundary.json', import.meta.url)
  const original = JSON.parse(fs.readFileSync(path))
  assert.equal(reviewLoopNativeTrace(original).errors, 1)
  for (const mutate of [report => { report.errors[0].data.message.content[0].text = 'Error: invalid evidence' }, report => { report.errors[0].data.message.toolCallId = 'different' }, report => { report.errors.push(structuredClone(report.errors[0])) }]) {
    const report = structuredClone(original); mutate(report); assert.throws(() => reviewLoopNativeTrace(report))
  }
})
