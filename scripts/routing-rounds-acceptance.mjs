#!/usr/bin/env node
/** Read-only verdict for fresh desktop traces; never runs a model or grants approval. */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as zlib from 'node:zlib'

function toolCalls(events) {
  return events.filter(event => event.type === 'tool/call').map(event => {
    const outcome = events.find(row => row.type === 'tool/result' && row.data.message?.toolCallId === event.data.callId)
    let args, value
    try { args = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments } catch {}
    try { value = JSON.parse(outcome.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('')) } catch {}
    return { ...event, args, value, succeeded: Boolean(outcome && !outcome.data.message.isError), resultTime: outcome?.time, resultSeq: outcome?.seq }
  })
}

export function assessDesktopTrace(ownerEvents, memberEvents, fixture, { routingOnly = false, minRounds = 3 } = {}) {
  const failures = [], checks = {}, owner = ownerEvents[0]?.id
  const check = (name, passed, message) => { checks[name] = Boolean(passed); if (!passed) failures.push(message) }
  const allCalls = toolCalls(ownerEvents)
  const start = allCalls.find(call => call.data.name === 'session_coordinator_collaboration_start' && call.succeeded && call.value?.owner === owner)
  const scope = start?.value
  const finished = allCalls.find(call => call.succeeded && call.data.name === 'session_coordinator_collaboration_control' && call.args?.scopeId === scope?.id && call.args.action === 'finish' && !call.args.taskId && call.value?.id === scope?.id && call.value?.state === 'completed')
  const endSeq = finished?.resultSeq ?? Infinity
  const human = ownerEvents.filter(event => event.seq <= endSeq && event.type === 'user/message' && event.data.source?.kind === 'user')
  check('originalUserInput', human[0]?.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') === fixture.userPrompt, 'Original unhinted user input differs from the captured case')
  check('noHumanCorrection', human.length === 1, 'Additional human input cannot rescue the original routing or unlock later rounds')
  const calls = allCalls.filter(call => call.seq <= endSeq)
  check('noTemporarySubstitution', !calls.some(call => ['spawn_teammate', 'subagent'].includes(call.data.name)), 'Explicit independent chats were replaced or supplemented by temporary agents')
  check('approvedScopeCreated', start?.value?.authorization?.kind === 'native-scoped-approval' && start.value.authorization.callId === start.data.callId, 'No successful natively approved persistent scope bound to this call was observed')
  const approval = ownerEvents.find(event => event.type === 'approval/asked' && event.data.callId === start?.data.callId && event.data.toolName === 'session_coordinator_collaboration_start')
  check('nativeScopedApprovalObserved', Boolean(approval && ownerEvents.some(event => event.type === 'approval/decided' && event.data.id === approval.data.id && event.data.outcome === 'allowed-once')), 'No matching native one-scope approval event was observed')
  const created = Object.entries(scope?.creations ?? {})
  const createdIds = new Set(created.map(([id]) => id))
  const endTime = finished?.resultTime ?? Infinity
  const withinCompletion = event => !Number.isFinite(event.time) || event.time <= endTime
  const humanInputCounts = { [owner]: human.length }
  for (const id of scope?.members ?? []) {
    if (id === owner) continue
    humanInputCounts[id] = (memberEvents[id] ?? []).filter(event => event.type === 'user/message' && event.data.source?.kind === 'user'
      && withinCompletion(event)
      && (createdIds.has(id) || !Number.isFinite(event.time) || event.time >= start.time)).length
  }
  check('noPeerHumanAssistance', Object.entries(humanInputCounts).every(([id, count]) => id === owner || count === 0), 'Human input in a participating chat before completion invalidates autonomous collaboration acceptance')
  check('requestedChatCount', created.length === fixture.expected.newIndependentChats && created.every(([, creation]) => creation.status === 'created'), 'Wrong or unconfirmed number of newly created independent chats')
  const expectedMembers = [owner, ...created.map(([id]) => id), ...(fixture.expected.existingMembers ?? [])].sort()
  check('exactApprovedMembers', JSON.stringify(scope?.members?.slice().sort()) === JSON.stringify(expectedMembers), 'The scope includes unexpected or missing participants')
  const identities = created.map(([id]) => {
    const events = memberEvents[id] ?? [], header = events[0]
    const title = events.filter(event => event.type === 'session/title' && withinCompletion(event)).at(-1)?.data.title
    return { id, title, headerId: header?.id, independent: header?.id === id && header.origin !== 'subagent' && header.parentSession === undefined && (header.delegationDepth ?? 0) === 0 }
  })
  check('nativeIndependentIdentities', identities.length > 0 && identities.every(identity => identity.independent), 'Native Session headers do not prove independent main chats')
  check('requestedTitles', JSON.stringify(identities.map(identity => identity.title).sort()) === JSON.stringify([...fixture.expected.requestedTitles].sort()), 'Native chat names do not match the requested identities')
  const roundChains = []
  if (!routingOnly && scope) {
    const exchanges = []
    for (const id of scope.members.filter(id => id !== owner)) {
      const events = (memberEvents[id] ?? []).filter(withinCompletion), results = toolCalls(events)
      for (const event of events) {
        const source = event.data?.source
        if (event.type !== 'user/message' || source?.kind !== 'session-collaboration' || source.scopeId !== scope.id || source.ownerSessionId !== owner || source.intent !== 'task' || event.data.id !== source.operationId) continue
        const result = results.find(call => call.succeeded && call.data.name === 'session_coordinator_collaboration_result' && call.seq > event.seq && call.args?.scopeId === scope.id && call.args?.taskId === source.taskId && call.args?.taskRevision === source.taskRevision && call.args?.operationId === source.operationId && call.value?.operationId === source.operationId && call.value?.taskId === source.taskId && call.value?.taskRevision === source.taskRevision && typeof call.value?.id === 'string' && call.value?.sender === id && !call.value?.stale)
        if (result) exchanges.push({ taskId: source.taskId, taskRevision: source.taskRevision, operationId: source.operationId, target: id, inputSeq: event.seq, inputTime: event.time, resultId: result.value.id, resultTime: result.resultTime })
      }
    }
    const groups = new Map()
    for (const exchange of exchanges) {
      const key = JSON.stringify([exchange.taskId, exchange.taskRevision])
      if (!groups.has(key)) groups.set(key, [])
      if (!groups.get(key).some(prior => prior.operationId === exchange.operationId || prior.resultId === exchange.resultId)) groups.get(key).push(exchange)
    }
    for (const group of groups.values()) {
      let previousResult = -1
      const chain = []
      for (const exchange of group.sort((a, b) => a.inputTime - b.inputTime || a.resultTime - b.resultTime)) {
        if (Number.isFinite(exchange.inputTime) && Number.isFinite(exchange.resultTime) && exchange.resultTime >= exchange.inputTime && exchange.inputTime >= previousResult) {
          chain.push(exchange); previousResult = exchange.resultTime
        }
      }
      roundChains.push({ taskId: group[0].taskId, taskRevision: group[0].taskRevision, rounds: chain.length, exchanges: chain })
    }
    check('orderedSameTaskRounds', roundChains.some(chain => chain.rounds >= minRounds), `No same-task/revision chain with ${minRounds} ordered task/result exchanges; semantic links across separate tasks require additional review`)
    check('noLegacyTaskFallback', !calls.some(call => call.seq > start.seq && ['session_coordinator_send', 'session_coordinator_create'].includes(call.data.name)), 'Persistent task work fell back to the legacy one-exchange tools')
    check('scopeCompleted', Boolean(finished), 'No successful completed-scope receipt was observed')
    check('ownerTurnCompleted', ownerEvents.find(event => event.type === 'turn/end' && event.seq > (finished?.resultSeq ?? Infinity))?.data.reason?.kind === 'completed', 'Owner execution did not complete normally')
  } else if (!routingOnly) check('orderedSameTaskRounds', false, 'Cannot verify automatic rounds without a scope')
  return { layer: routingOnly ? 'unhinted-desktop-routing' : 'unhinted-desktop-routing-and-rounds', pass: failures.length === 0, checks, failures, owner, scopeId: scope?.id, humanInputCounts, identities, roundChains, boundaries: ['Sidebar visibility and reopening require UI verification.', 'Business file contents, tests and feedback consumption require independent verification.', 'Same-task ordered rounds establish transport continuity, not business quality.'] }
}

export function readNativeLog(path) {
  const bytes = readFileSync(path)
  if (path.endsWith('.zstd') && typeof zlib.zstdDecompressSync !== 'function') throw new Error('Compressed desktop logs require Node with zstdDecompressSync (the desktop runtime Node is supported)')
  const source = path.endsWith('.zstd') ? zlib.zstdDecompressSync(bytes).toString() : bytes.toString()
  return source.trim().split('\n').map(line => JSON.parse(line))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'owner-log': { type: 'string' }, fixture: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '../docs/acceptance/evidence/2026-10-28-desktop/independent-chat-routing-failure.json') }, 'routing-only': { type: 'boolean', default: false }, 'min-rounds': { type: 'string', default: '3' }, output: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help || !values['owner-log']) {
    console.log('Read-only acceptance: node scripts/routing-rounds-acceptance.mjs --owner-log /absolute/session.v4.jsonl.zstd [--fixture case.json] [--routing-only] [--min-rounds 3] [--output report.json]')
    process.exit(values.help ? 0 : 2)
  }
  const ownerEvents = readNativeLog(values['owner-log']), fixture = JSON.parse(readFileSync(values.fixture, 'utf8'))
  const scope = toolCalls(ownerEvents).find(call => call.data.name === 'session_coordinator_collaboration_start' && call.succeeded && call.value?.owner === ownerEvents[0]?.id)?.value
  const memberEvents = {}
  for (const id of scope?.members ?? []) {
    if (id === ownerEvents[0]?.id) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('Invalid native member identity')
    try { memberEvents[id] = readNativeLog(resolve(dirname(dirname(values['owner-log'])), id, 'session.v4.jsonl.zstd')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const minRounds = Number(values['min-rounds'])
  if (!Number.isSafeInteger(minRounds) || minRounds < 3) throw new Error('min-rounds must be an integer >= 3')
  const report = assessDesktopTrace(ownerEvents, memberEvents, fixture, { routingOnly: values['routing-only'], minRounds })
  const output = JSON.stringify(report, null, 2) + '\n'
  if (values.output) writeFileSync(values.output, output)
  console.log(output)
  if (!report.pass) process.exitCode = 1
}
