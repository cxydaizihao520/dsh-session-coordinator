import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { busyOwnerPrompt, verifyBusyOwnerProof } from './busy-owner-proof.mjs'

/** Explicit-protocol native test. Approval is restricted to this isolated A's single scope. */
export function applyBusyOwner(ctx) {
  const scenario = 'collaboration-busy-owner'
  const report = { scenario, validationLayer: 'explicit-protocol-busy-owner', runtime: process.env.DSH_LIVE_RUNTIME, sessions: {}, headers: {}, assertions: [], timeline: [], tools: [], toolReceipts: [], nativeEvents: [], inboundResults: [], requestInclusions: [], errors: [], fatalErrors: [] }
  const save = () => fs.writeFileSync(process.env.DSH_HOME + '/' + scenario + '-report.json', JSON.stringify(report, (key, value) => ['provider', 'model', 'reasoningEffort'].includes(key) ? undefined : value, 2))
  let owner, setup = false, first = true, dispatched = false, verified = false, order = 0, activeBusy, releaseBusy, beginBusy
  const started = new Promise(resolve => { beginBusy = resolve })
  const released = new Promise(resolve => { releaseBusy = resolve })
  const execution = new Map()
  const mark = (name, fields = {}) => { const item = { name, order: ++order, time: Date.now(), ...fields }; report.timeline.push(item); save(); return item }
  const deadline = async (promise, label, signal) => {
    let timer, abort
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' did not complete within 180 seconds')), 180000)
        abort = () => reject(signal.reason ?? new Error(label + ' aborted'))
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      })])
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
  }
  const tool = (name, description, parameters, execute) => ctx.tools.register({ name, description, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute })
  tool('acceptance_peer_gate', 'Test only: obtain the proof that owner A has entered its own long tool before computing your assigned items.', { type: 'object', properties: {}, additionalProperties: false }, async (_args, exec) => {
    assert.notEqual(exec.agent, owner, 'only B may enter its preparation gate')
    mark('peer-gate', { sessionId: exec.agent.id, ...execution.get(exec.agent.id) })
    await deadline(started, 'A busy-tool start', exec.signal)
    return { ownerBusy: true, items: [{ quantity: 3, unitPrice: 19 }, { quantity: 2, unitPrice: 7 }] }
  })
  tool('acceptance_busy_work', 'Test only: reconcile A shipping ledger, then remain inside this actual tool until B has submitted its native result. Call once immediately after sending B its task.', { type: 'object', properties: {}, additionalProperties: false }, async (_args, exec) => {
    assert.equal(exec.agent, owner)
    assert.equal(activeBusy, undefined, 'the long tool executes exactly once')
    const current = { ...execution.get(owner.id) }
    activeBusy = mark('busy-start', { sessionId: owner.id, ...current })
    // A's independent business work is real computation; the barrier, not a sleep, controls overlap.
    const shippingLedger = [{ debit: 12, credit: 0 }, { debit: 0, credit: 3 }]
    const shipping = shippingLedger.reduce((sum, row) => sum + row.debit - row.credit, 0)
    beginBusy()
    const resultId = await deadline(released, 'B native result', exec.signal)
    assert.deepEqual(execution.get(owner.id), current, 'A was not interrupted or moved to a new step while its tool ran')
    mark('busy-end', { sessionId: owner.id, ...current, resultId })
    return { shippingLedger, shipping, releaseCause: 'native-peer-result', resultId }
  })
  tool('acceptance_busy_integrate', 'Test only: record the actual model decision combining the peer items total and A shipping; call after your long tool returns and you read the native peer result.', { type: 'object', properties: { itemsTotal: { type: 'number' }, shipping: { type: 'number' }, combined: { type: 'number' } }, required: ['itemsTotal', 'shipping', 'combined'], additionalProperties: false }, async (args, exec) => {
    assert.equal(exec.agent, owner)
    assert.deepEqual(args, { itemsTotal: 71, shipping: 9, combined: 80 })
    mark('integrate', { sessionId: owner.id, ...execution.get(owner.id), arguments: args })
    return { itemsTotal: args.itemsTotal, shipping: args.shipping, combined: args.combined, verified: true }
  })
  ctx.on('approval/request', async (request, next) => request.agent === owner && request.toolName === 'session_coordinator_collaboration_start' ? 'allowed-once' : next())
  ctx.on('agent/error', ({ agent, error, turn }) => { report.fatalErrors.push({ sessionId: agent.id, turn, code: error?.code ?? 'UNKNOWN' }); save() })
  ctx.on('llm/stream', async function* (request, next) {
    if (isAgentLoopRequest(request) && request.sessionId === owner?.id) for (const message of request.messages) {
      if (message.source?.kind === 'session-collaboration' && message.source.intent === 'result') {
        const checkpoint = mark('owner-request-result', { sessionId: owner.id, ...execution.get(owner.id), messageId: message.id })
        report.requestInclusions.push({ order: checkpoint.order, ...execution.get(owner.id), message: structuredClone(message) }); save()
      }
    }
    yield* next()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') execution.set(session.id, { turn: event.data.turn, step: 0 })
    if (event.type === 'step/start') execution.set(session.id, { turn: event.data.turn, step: event.data.step })
    if (['turn/start', 'turn/end', 'step/start', 'step/end', 'approval/asked', 'approval/decided'].includes(event.type)) report.nativeEvents.push({ sessionId: session.id, ...event,
      ...(event.type === 'approval/asked' ? { data: { id: event.data.id, callId: event.data.callId, toolName: event.data.toolName } } : {}) })
    if (event.type === 'tool/call') report.tools.push({ sessionId: session.id, ...event.data, seq: event.seq, time: event.time })
    if (event.type === 'tool/result') report.toolReceipts.push({ sessionId: session.id, callId: event.data.message?.toolCallId, seq: event.seq, order: ++order, isError: Boolean(event.data.message?.isError) })
    if (event.type === 'tool/result' && event.data.message?.isError) report.errors.push({ sessionId: session.id, ...event })
    if (session.id === owner?.id && event.type === 'user/message' && event.data.source?.kind === 'session-collaboration' && event.data.source.intent === 'result') report.inboundResults.push({ seq: event.seq, time: event.time, message: structuredClone(event.data) })
    if (session.id !== owner?.id && event.type === 'tool/result' && !event.data.message?.isError) {
      const call = report.tools.find(item => item.sessionId === session.id && item.callId === event.data.message?.toolCallId && item.name === 'session_coordinator_collaboration_result')
      if (call) {
        const result = JSON.parse(event.data.message.content.filter(item => item.type === 'text').map(item => item.text).join(''))
        assert.equal(result.sender, session.id)
        assert.equal(result.text, 'ITEMS_TOTAL=71')
        assert.ok(activeBusy, 'B cannot finish before A enters its long tool')
        mark('peer-result', { sessionId: session.id, resultId: result.id, operationId: result.operationId, seq: event.seq })
        mark('busy-release', { cause: 'native-peer-result', resultId: result.id })
        releaseBusy(result.id)
      }
    }
    save()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (setup) {
      agent.ctx.tools.restrict({ deny: ['acceptance_busy_work', 'acceptance_busy_integrate'] })
      return
    }
    setup = true; owner = agent; report.sessions.A = owner.id
    owner.ctx.tools.restrict({ deny: ['acceptance_peer_gate'] })
    const followup = owner.followup.bind(owner), whenIdle = owner.whenIdle.bind(owner)
    owner.followup = message => {
      if (!first) return followup(message)
      first = false; dispatched = true
      return followup({ ...message, content: [{ type: 'text', text: busyOwnerPrompt }] })
    }
    owner.whenIdle = async () => {
      await whenIdle()
      if (!dispatched || verified) return
      verified = true
      try {
        mark('verification-join')
        const peers = ctx.agents.list().filter(item => item !== owner)
        await Promise.all(peers.map(item => item.whenIdle()))
        await whenIdle()
        const snapshot = await ctx.tools.get('session_coordinator_collaboration_status', owner).execute({}, { agent: owner, signal: new AbortController().signal })
        const scope = snapshot.scopes?.find(item => item.owner === owner.id)
        assert.ok(scope, 'the model must create its native collaboration scope')
        assert.equal(peers.length, 1)
        report.sessions.B = peers[0].id
        report.scope = scope
        for (const item of [owner, peers[0]]) {
          const { id, origin, parentSession, delegationDepth } = item.session.header
          report.headers[id] = { id, origin, parentSession, delegationDepth }
        }
        report.humanInputCounts = Object.fromEntries([owner, peers[0]].map(item => [item.id, item.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length]))
        report.approvals = report.nativeEvents.filter(item => item.type === 'approval/decided').map(item => item.data.outcome)
        report.result = verifyBusyOwnerProof(report, scope)
        report.assertions.push('A and B are real independent main chats with one initial approval and no additional human input', 'B native result occurs strictly inside A model-issued shipping tool; no wait or idle event releases it', 'A finishes its current tool normally, then the same turn next model step contains the exact native result', 'A model integrates real item total 71 plus shipping 9 into 80, then finishes task and scope', 'all native turns completed normally with zero tool or fatal errors')
        report.pass = true
      } catch (error) { report.pass = false; report.failure = String(error?.stack ?? error) }
      save()
    }
  })
  process.on('exit', save)
}
