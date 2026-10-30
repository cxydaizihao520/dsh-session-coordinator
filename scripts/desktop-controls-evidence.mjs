#!/usr/bin/env node
/** Read only one explicit desktop owner and the identities created by its approved native scope. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

export function decodeFrames(bytes) {
  const parts = []
  for (let at = 0; at < bytes.length;) {
    const result = zlib.zstdDecompressSync(bytes.subarray(at), { info: true })
    assert.ok(result.engine.bytesWritten > 0)
    at += result.engine.bytesWritten; parts.push(result.buffer)
  }
  return Buffer.concat(parts).toString().trim().split('\n').filter(Boolean).map(JSON.parse)
}
const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
const json = text => { try { return JSON.parse(text) } catch { return undefined } }
const argumentsOf = call => typeof call.arguments === 'string' ? json(call.arguments) : call.arguments
const summaryOfScope = scope => ({ id: scope.id, owner: scope.owner, members: scope.members, state: scope.state, reason: scope.reason,
  tasks: Object.fromEntries(Object.entries(scope.tasks ?? {}).map(([id, task]) => [id, { id, objective: task.objective, revision: task.revision, state: task.state, scheduling: task.scheduling, waitReason: task.waitReason, reason: task.reason, members: task.members, resultIds: task.resultIds, acceptedResultIds: task.acceptedResultIds }])),
  results: scope.results, operations: Object.fromEntries(Object.entries(scope.operations ?? {}).map(([id, operation]) => [id, { id, taskId: operation.taskId, taskRevision: operation.taskRevision, sender: operation.sender, target: operation.target, intent: operation.intent, control: operation.control, status: operation.status, turn: operation.turn, execution: operation.execution, error: operation.error, resultId: operation.resultId, requestInclusion: operation.requestInclusion }])) })

export function collectDesktopEvidence(base, ownerId, expectedCreatedCount = 2) {
  assert.ok([1, 2].includes(expectedCreatedCount), 'only the expected one or two desktop collaborators may be read')
  assert.match(ownerId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  const logs = new Map(), sourceFiles = []
  const read = id => {
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    const path = resolve(base, id, 'session.v4.jsonl.zstd'), bytes = fs.readFileSync(path), events = decodeFrames(bytes)
    assert.equal(events[0].id, id)
    logs.set(id, events); sourceFiles.push({ sessionId: id, path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, lastSeq: events.at(-1)?.seq, lastTime: events.at(-1)?.time })
    return events
  }
  const owner = read(ownerId)
  const start = owner.find(event => event.type === 'tool/call' && event.data.name === 'session_coordinator_collaboration_start')
  const receipt = start && owner.find(event => event.type === 'tool/result' && event.data.message.toolCallId === start.data.callId && !event.data.message.isError)
  assert.ok(receipt, 'the explicit desktop scope must have a successful start receipt before reading members')
  const scope = json(textOf(receipt.data.message))
  assert.equal(scope.owner, ownerId)
  const asked = owner.find(event => event.type === 'approval/asked' && event.data.callId === start.data.callId)
  assert.ok(asked && owner.some(event => event.type === 'approval/decided' && event.data.id === asked.data.id && event.data.outcome === 'allowed-once'))
  const created = Object.keys(scope.creations ?? {})
  assert.equal(created.length, expectedCreatedCount)
  assert.deepEqual([...scope.members].sort(), [ownerId, ...created].sort(), 'do not read any member outside this explicit desktop creation')
  created.forEach(read)
  const report = { layer: 'actual-desktop-native-read-only-evidence', capturedAt: new Date().toISOString(), owner: ownerId, scopeId: scope.id, members: scope.members, sourceFiles,
    headers: {}, humanInputs: [], humanQuestionReplies: [], humanInboxInputs: [], timeline: [], batchStarts: [], batchIntervals: [], errors: [], nativeTurns: [], scopeSnapshots: [{ time: receipt.time, seq: receipt.seq, ...summaryOfScope(scope) }], counts: {}, boundaries: ['No UI actions, approvals, model dispatches or production changes are performed by this extractor.', 'Only this explicit desktop owner and its expected approved newly created members are read.', 'A captured log prefix is progress evidence; terminal silence requires separately observed stable counters for at least 30 seconds.'] }
  for (const [sessionId, events] of logs) {
    const header = events[0]
    report.headers[sessionId] = { id: header.id, origin: header.origin, parentSession: header.parentSession, delegationDepth: header.delegationDepth, title: events.filter(event => event.type === 'session/title').at(-1)?.data.title }
    const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event]))
    report.counts[sessionId] = { humanInputs: 0, userMessages: events.filter(event => event.type === 'user/message').length, inboxMutations: events.filter(event => event.type === 'agent/inbox/spliced').length, tools: calls.size, turnStarts: events.filter(event => event.type === 'turn/start').length, turnEnds: events.filter(event => event.type === 'turn/end').length }
    for (const event of events) {
      const common = { sessionId, type: event.type, seq: event.seq, time: event.time }
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        report.humanInputs.push({ ...common, messageId: event.data.id, text: textOf(event.data) }); report.counts[sessionId].humanInputs++
      }
      if (event.type === 'user/message' && event.data.source?.kind === 'user-question-reply') report.humanQuestionReplies.push({ ...common, messageId: event.data.id, text: textOf(event.data) })
      if (event.type === 'agent/inbox/spliced') for (const message of event.data.inserted ?? []) {
        if (message.source?.kind === 'user') report.humanInboxInputs.push({ ...common, target: event.data.target, messageId: message.id, text: textOf(message) })
      }
      if (event.type === 'user/message' && event.data.source?.kind === 'session-collaboration' && event.data.source.scopeId === scope.id) report.timeline.push({ ...common, source: event.data.source, text: textOf(event.data).split('\n').slice(2).join('\n') })
      if (['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type)) {
        const entry = { ...common, turn: event.data.turn, step: event.data.step, ...(event.type === 'turn/end' ? { reason: event.data.reason?.kind } : {}) }
        report.timeline.push(entry); if (event.type.startsWith('turn/')) report.nativeTurns.push(entry)
      }
      if (event.type === 'approval/asked') report.timeline.push({ ...common, id: event.data.id, toolName: event.data.toolName, callId: event.data.callId })
      if (event.type === 'approval/decided') report.timeline.push({ ...common, id: event.data.id, outcome: event.data.outcome })
      if (event.type === 'tool/call') {
        const args = argumentsOf(event.data)
        if (['bash', 'ops_bash'].includes(event.data.name) && args?.command?.includes('read_batch.py')) report.batchStarts.push({ ...common, callId: event.data.callId, name: event.data.name, turn: event.data.turn, step: event.data.step, command: args.command })
        report.timeline.push({ ...common, callId: event.data.callId, name: event.data.name, turn: event.data.turn, step: event.data.step,
          ...(event.data.name.startsWith('session_coordinator_collaboration_') ? { arguments: Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !['newSessions', 'provider', 'model', 'reasoningEffort'].includes(key))) } : {}),
          ...(event.data.name === 'ask_user_question' ? { arguments: args } : {}),
          ...(['bash', 'ops_bash'].includes(event.data.name) && args?.command?.includes('read_batch.py') ? { command: args.command, timeout: args.timeout ?? args.timeoutMs, runInBackground: args.run_in_background } : {}) })
      }
      if (event.type === 'tool/result') {
        const call = calls.get(event.data.message.toolCallId), name = call?.data.name, args = call && argumentsOf(call.data), content = textOf(event.data.message), value = json(content)
        if (event.data.message.isError) report.errors.push({ ...common, callId: event.data.message.toolCallId, name, content })
        if (name?.startsWith('session_coordinator_collaboration_')) {
          report.timeline.push({ ...common, callId: event.data.message.toolCallId, name, isError: Boolean(event.data.message.isError),
            ...(value ? { receipt: name.endsWith('_result') ? value : { id: value.id, state: value.state, reason: value.reason, taskId: value.taskId, scopeState: value.scopeState, tasks: value.tasks, interrupted: value.interrupted, done: value.done, pendingUserInput: value.pendingUserInput, timedOut: value.timedOut, aborted: value.aborted, needsAttention: value.needsAttention } } : { content }) })
          if (value?.id === scope.id && value.tasks && value.operations && !event.data.message.isError) report.scopeSnapshots.push({ time: event.time, seq: event.seq, ...summaryOfScope(value) })
          for (const item of value?.scopes ?? []) if (item.id === scope.id) report.scopeSnapshots.push({ time: event.time, seq: event.seq, ...summaryOfScope(item) })
        }
        if (name === 'ask_user_question') report.timeline.push({ ...common, callId: call.data.callId, name, isError: Boolean(event.data.message.isError), response: value ?? content })
        if (['bash', 'ops_bash'].includes(name) && args?.command?.includes('read_batch.py')) report.batchIntervals.push({ sessionId, callId: call.data.callId, toolName: name, turn: call.data.turn, step: call.data.step, start: call.time, end: event.time, durationMs: event.time - call.time, command: args.command, isError: Boolean(event.data.message.isError), output: content })
      }
    }
  }
  report.timeline.sort((a, b) => a.time - b.time || a.seq - b.seq)
  report.batchOverlaps = []
  for (let i = 0; i < report.batchIntervals.length; i++) for (const other of report.batchIntervals.slice(i + 1)) {
    const batch = report.batchIntervals[i], overlapMs = Math.min(batch.end, other.end) - Math.max(batch.start, other.start)
    if (batch.sessionId !== other.sessionId && overlapMs > 0) report.batchOverlaps.push({ firstCall: batch.callId, secondCall: other.callId, sessions: [batch.sessionId, other.sessionId], overlapMs })
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, owner: { type: 'string' }, output: { type: 'string' }, members: { type: 'string', default: '2' } } })
  if (!values.base || !values.owner || !values.output) throw new Error('Usage: --base explicit-log-base --owner owner-id --output filtered-evidence.json')
  const report = collectDesktopEvidence(values.base, values.owner, Number(values.members))
  fs.writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ owner: report.owner, scopeId: report.scopeId, members: report.members, batchIntervals: report.batchIntervals, overlaps: report.batchOverlaps, humanInputCounts: Object.fromEntries(Object.entries(report.counts).map(([id, count]) => [id, count.humanInputs])), errors: report.errors, scopeSnapshots: report.scopeSnapshots.map(scope => ({ time: scope.time, state: scope.state, tasks: scope.tasks })) }, null, 2))
}
