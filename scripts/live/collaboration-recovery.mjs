import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HarnessError, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { verifyRecoveryFailure, verifyRecoveryReopen, verifyRecoveryProof } from './recovery-proof.mjs'

/** Three native processes, one durable scope and one external business ledger. */
export function applyCollaborationRecovery(ctx) {
  const phase = process.env.DSH_LIVE_RECOVERY_PHASE
  assert.ok(['fail', 'inspect', 'recover'].includes(phase))
  const home = process.env.DSH_HOME, path = name => home + '/' + name
  const prior = phase === 'fail' ? undefined : JSON.parse(fs.readFileSync(path('collaboration-recovery-fail-report.json'), 'utf8'))
  const report = { scenario: 'collaboration-recovery', validationLayer: 'explicit-protocol-native-recovery', phase, pid: process.pid, runtime: process.env.DSH_LIVE_RUNTIME, sessions: prior?.sessions ?? {}, headers: {}, tools: [], waits: [], approvals: [], fatalErrors: [], errors: [], reconciliations: [], ownerRequestAttention: [], modelRequests: 0, humanInputs: [], timeline: [] }
  const save = () => fs.writeFileSync(path('collaboration-recovery-' + phase + '-report.json'), JSON.stringify(report, (key, value) => ['provider', 'model', 'reasoningEffort'].includes(key) ? undefined : value, 2))
  const ledgerPath = path('recovery-ledger.json')
  if (phase === 'fail') fs.writeFileSync(ledgerPath, JSON.stringify({ balance: 100, entries: [] }))
  const ledger = () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  let owner, first = true, dispatched = false, checked = false, networkInjected = false, order = 0
  const approvalCalls = new Map()
  const mark = (name, fields = {}) => { const item = { name, order: ++order, ...fields }; report.timeline.push(item); save(); return item }
  const parse = value => typeof value === 'string' ? JSON.parse(value) : value
  const sourceOf = agent => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'session-collaboration' && event.data.source.intent === 'task').at(-1)?.data.source
  const status = async () => ctx.tools.get('session_coordinator_collaboration_status', owner).execute({}, { agent: owner, signal: new AbortController().signal })
  ctx.tools.register({ name: 'acceptance_recovery_ledger', description: 'Test-only actual external ledger. Owner first reconciles exact originalOperationId after failure. Peer applies debit -12 in the original operation; after explicit user recovery it applies only credit +5 referencing that original operation. Duplicate or unauthorized side effects are errors.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['inspect', 'debit', 'credit'] }, originalOperationId: { type: 'string' } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const current = ledger()
      if (args.action === 'inspect') {
        const found = current.entries.some(item => item.operationId === args.originalOperationId)
        if (phase === 'recover' && exec.agent === owner && args.originalOperationId === prior.ledger.entries[0].operationId) {
          const snapshot = await status(), scope = snapshot.scopes.find(item => item.id === prior.scope.id)
          assert.ok(scope.operations[args.originalOperationId], 'reconcile against durable original operation')
          const inspected = mark('reconciled', { operationId: args.originalOperationId, balance: current.balance, entries: current.entries })
          report.reconciliations.push(inspected); save()
          return { ...current, originalOperationId: args.originalOperationId, found, applied: ['debit -12'], remaining: ['credit +5'], originalOperation: scope.operations[args.originalOperationId] }
        }
        return { ...current, ...(args.originalOperationId ? { inspectedOperationId: args.originalOperationId, found } : {}), knownOperationIds: current.entries.map(item => item.operationId), recoveryReconciled: false }
      }
      assert.notEqual(exec.agent, owner)
      const source = sourceOf(exec.agent)
      assert.ok(source, 'business effect must belong to an actual admitted collaboration input')
      assert.ok(!current.entries.some(item => item.kind === args.action), 'duplicate side effect is forbidden')
      if (args.action === 'debit') assert.equal(phase, 'fail', 'already-applied debit cannot be replayed during recovery')
      else {
        assert.equal(phase, 'recover')
        assert.equal(args.originalOperationId, prior.ledger.entries[0].operationId)
        assert.ok(report.reconciliations.some(item => item.operationId === args.originalOperationId), 'reconcile before remaining work')
        assert.ok(report.approvals.filter(item => item.outcome === 'allowed-once' && item.afterHumanRecovery).length >= 2, 'native scope and task resume approvals must precede the remaining effect')
        assert.equal(source.scopeId, prior.scope.id); assert.equal(source.taskId, prior.ledger.entries[0].taskId)
        assert.notEqual(source.operationId, args.originalOperationId, 'remaining work has its own accountable operation')
      }
      const amount = args.action === 'debit' ? -12 : 5
      const entry = { kind: args.action, amount, scopeId: source.scopeId, taskId: source.taskId, taskRevision: source.taskRevision, operationId: source.operationId, ...(args.action === 'credit' ? { originalOperationId: args.originalOperationId } : {}) }
      current.entries.push(entry); current.balance += amount
      fs.writeFileSync(ledgerPath, JSON.stringify(current))
      mark('side-effect', entry)
      return current
    } })
  ctx.on('approval/request', async (request, next) => {
    const tool = report.tools.find(item => item.callId === request.callId && item.sessionId === owner?.id)
    const afterHumanRecovery = phase === 'recover' && report.humanInputs.some(item => item.sessionId === owner?.id)
    const allowed = request.agent === owner && (phase === 'fail' && request.toolName === 'session_coordinator_collaboration_start' || afterHumanRecovery && request.toolName === 'session_coordinator_collaboration_control' && tool?.args.action === 'resume' && tool.args.scopeId === prior.scope.id)
    if (!allowed) return next()
    mark('approval-request-allowed', { callId: request.callId, afterHumanRecovery })
    return 'allowed-once'
  })
  ctx.on('llm/stream', async function* (request, next) {
    if (isAgentLoopRequest(request)) {
      report.modelRequests++
      if (request.sessionId === owner?.id) for (const message of request.messages) if (message.source?.kind === 'session-collaboration' && message.source.intent === 'result') report.ownerRequestAttention.push(message.source.operationId)
      if (phase === 'fail' && request.sessionId !== owner?.id && ledger().entries.some(item => item.kind === 'debit') && !networkInjected) {
        networkInjected = true; mark('native-network', { sessionId: request.sessionId })
        throw new HarnessError('Acceptance recovery: transport failed after debit was actually committed', 'NETWORK')
      }
      save()
    }
    yield* next()
  })
  ctx.on('agent/error', ({ agent, error }) => { report.fatalErrors.push({ sessionId: agent.id, code: error?.code ?? 'UNKNOWN' }); save() })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data.source?.kind === 'user') report.humanInputs.push({ sessionId: session.id, messageId: event.data.id, order: ++order })
    if (event.type === 'tool/call') report.tools.push({ sessionId: session.id, name: event.data.name, callId: event.data.callId, args: parse(event.data.arguments), order: ++order })
    if (event.type === 'approval/asked') approvalCalls.set(event.data.id, event.data.callId)
    if (event.type === 'approval/decided') {
      const callId = approvalCalls.get(event.data.id)
      const request = report.timeline.find(item => item.name === 'approval-request-allowed' && item.callId === callId)
      report.approvals.push({ callId, outcome: event.data.outcome, afterHumanRecovery: Boolean(request?.afterHumanRecovery), order: ++order })
    }
    if (event.type === 'tool/result') {
      const tool = report.tools.find(item => item.callId === event.data.message?.toolCallId && item.sessionId === session.id)
      if (event.data.message?.isError) report.errors.push({ sessionId: session.id, toolName: tool?.name, callId: tool?.callId, content: event.data.message.content })
      else if (tool?.name === 'session_coordinator_collaboration_wait') report.waits.push(parse(event.data.message.content.filter(item => item.type === 'text').map(item => item.text).join('')))
    }
    save()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (owner) return
    owner = agent; report.sessions.A = owner.id
    if (prior) assert.equal(owner.id, prior.sessions.A, 'resume the original independent owner')
    const followup = owner.followup.bind(owner), whenIdle = owner.whenIdle.bind(owner)
    owner.followup = message => {
      if (!first) return followup(message)
      first = false; dispatched = true
      assert.equal(message.source?.kind, 'user', 'recovery must be a genuinely new native human request')
      if (phase === 'inspect') return // No model, approval, human event or replay on process reopen.
      const text = phase === 'fail'
        ? '这是用户授权的隔离失败恢复协议验收。使用collaboration_start创建1个新独立主会话B，继承目录与模型，预算maxOperations=12,maxNoProgress=6,maxElapsedMs=600000，不设token cap。建立1项余额任务：初始100，先扣12，再入5，最终应93。本流程先分派第一段工作：send(intent=task)让B仅调用acceptance_recovery_ledger(action=debit)实际扣12，随后准备读取真实余额并用collaboration_result提交该段结果；B不负责入5，必须等总控另行分派剩余入账。B扣款真实提交后会在下一次模型请求遭遇致命NETWORK，尚未来得及提交该段result；完整task业务目标仍是100扣12再入5得93。你用collaboration_wait实际等待，收到needsAttention后status核对精确task/operation及错误，明确报告已扣12而剩余入5尚未完成，需要用户恢复。保留原scope active和task recovery-required，不fail/cancel/resume、不重新投递任何工作、不换ID、不创建新scope或新聊天；不要把错误伪造成结果。向用户说明等待新的恢复授权，然后正常结束。仅使用协作工具，不运行子代理或无关工具。'
        : `用户现在明确要求恢复上一轮断网的同一余额任务；这是新的人工恢复请求，必须走原生审批。继续scopeId=${prior.scope.id}、taskId=${Object.keys(prior.scope.tasks)[0]}，原失败operationId=${prior.ledger.entries[0].operationId}，原B=${prior.sessions.B}。先调用acceptance_recovery_ledger(action=inspect,originalOperationId=原失败ID)，并status对账原操作和已有副作用，先确定真实已扣12、余额88，只剩入5；不得再扣12，不创建scope/task/chat，不重放原任务。对账后分别collaboration_control resume原scope（无taskId）与原task（有taskId），每次等待本次原生批准。然后用原task和原revision向同一B只发送“剩余入5”的新task操作，正文给出原失败ID，要求B仅调用acceptance_recovery_ledger(action=credit,originalOperationId=原失败ID)，读取实际余额，用collaboration_result提交text恰为BALANCE=93以及精确旧操作和本次剩余操作证据。等真实result，核对余额93及只扣一次只入一次，先finish task再finish scope，两次均提供非空真实resultIds，确认completed后报告恢复完成及副作用对账。仅用协作工具与账本工具，不调用临时代理或无关工具。`
      return followup({ ...message, content: [{ type: 'text', text }] })
    }
    owner.whenIdle = async () => {
      await whenIdle()
      if (!dispatched || checked) return
      checked = true
      try {
        if (phase !== 'inspect') { await Promise.all(ctx.agents.list().filter(item => item !== owner).map(item => item.whenIdle())); await whenIdle() }
        const snapshot = await status(); report.scopeCount = snapshot.scopes.length
        report.scope = snapshot.scopes.find(item => item.owner === owner.id)
        assert.ok(report.scope, 'original durable collaboration must exist')
        report.sessions.B = report.scope.members.find(id => id !== owner.id)
        report.ledger = ledger(); report.humanInputCounts = {}
        for (const id of [owner.id, report.sessions.B]) {
          const observation = await ctx.get('sessionQuery').observeSession(id)
          try {
            const { origin, parentSession, delegationDepth } = observation.header
            report.headers[id] = { id, origin, parentSession, delegationDepth }
            report.humanInputCounts[id] = observation.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length
          } finally { observation[Symbol.dispose]() }
        }
        if (phase === 'fail') {
          report.proof = verifyRecoveryFailure(report)
        } else if (phase === 'inspect') {
          report.proof = verifyRecoveryReopen(prior, report)
        } else report.proof = verifyRecoveryProof(prior, JSON.parse(fs.readFileSync(path('collaboration-recovery-inspect-report.json'), 'utf8')), report)
        report.pass = true
      } catch (error) { report.pass = false; report.failure = String(error?.stack ?? error) }
      save()
    }
  })
  process.on('exit', save)
}

/** Local native lifecycle proof only: no model, no business dispatch, real registered create/resume consumers. */
export function applyPresetColdProof(ctx) {
  const phase = process.env.DSH_LIVE_PRESET_PHASE, home = process.env.DSH_HOME
  assert.ok(['create', 'reopen'].includes(phase))
  const prior = phase === 'reopen' ? JSON.parse(fs.readFileSync(home + '/collaboration-preset-create-report.json', 'utf8')) : undefined
  const report = { scenario: 'collaboration-preset-' + phase, validationLayer: 'native-no-llm-lifecycle', phase, pid: process.pid, runtime: process.env.DSH_LIVE_RUNTIME, sessions: prior?.sessions ?? {}, modelRequests: 0, approvals: [], errors: [], operations: [] }
  const save = () => fs.writeFileSync(home + '/' + report.scenario + '-report.json', JSON.stringify(report, null, 2))
  const presetId = 'acceptance-recovery-retained-preset'
  let owner, caller, dispatched = false, checked = false, work
  ctx.on('llm/stream', async function* () { report.modelRequests++; save(); throw new Error('No model request is permitted in the preset lifecycle proof') })
  ctx.on('agent/error', ({ agent, error }) => { report.errors.push({ sessionId: agent.id, code: error?.code ?? 'UNKNOWN' }); save() })
  ctx.on('approval/request', async (request, next) => request.agent === caller && request.callId === 'preset-proof-create' && request.toolName === 'session_coordinator_collaboration_start' ? 'allowed-once' : next())
  ctx.on('session/event', (_session, event) => { if (event.type === 'approval/decided') { report.approvals.push(event.data.outcome); save() } })
  ctx.on('agent/created', ({ agent }) => {
    if (owner) return
    owner = agent; report.sessions.A = owner.id
    const idle = owner.whenIdle.bind(owner)
    owner.followup = message => {
      assert.equal(message.source?.kind, 'user'); assert.equal(dispatched, false)
      dispatched = true
      work = (async () => {
        await ctx.agentPresets.register({ id: presetId, name: 'Isolated native lifecycle preset', plugins: [] })
        const signal = new AbortController().signal
        let target
        if (phase === 'create') {
          caller = (await ctx.agents.create({ sessionId: 'preset-caller-' + crypto.randomUUID(), meta: { cwd: process.cwd(), agentPreset: presetId }, agentOptions: ctx.agentDefaultModel.currentSelection(), setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, presetId) } })).agent
          report.sessions.caller = caller.id
          assert.equal(ctx.agentPresets.composedPreset(caller.ctx), presetId)
          // Only the registered production tool decides the child's inherited durable identity and setup.
          let created
          caller.ctx.on('agent/pre-step', async ({ signal }) => {
            // The real loop opens the turn; approval audit events may never be forged between turns.
            created = await ctx.tools.get('session_coordinator_collaboration_start', caller).execute({ objective: 'Local lifecycle proof only; retain one idle independent peer with inherited preset', newSessions: [{ title: 'Native inherited-preset cold proof' }], budget: { maxOperations: 4, maxNoProgress: 2, maxElapsedMs: 60000 } }, { agent: caller, callId: 'preset-proof-create', signal })
            return { kind: 'reject' }
          })
          caller.followup({ id: 'preset-native-local-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Local no-model lifecycle proof; native pre-step performs the one approved creation.' }] })
          await caller.whenIdle(); assert.ok(created, 'native pre-step must create the idle independent target')
          report.sessions.target = created.members.find(id => id !== caller.id); target = ctx.agents.get(report.sessions.target)
          report.operations.push({ tool: 'session_coordinator_collaboration_start', scopeId: created.id, implicitPreset: true, tasks: Object.keys(created.tasks).length, workDispatched: false })
          assert.deepEqual(created.tasks, {}); assert.deepEqual(created.operations, {})
        } else {
          assert.equal(owner.id, prior.sessions.A); assert.notEqual(report.pid, prior.pid)
          assert.equal(ctx.agents.get(prior.sessions.target), undefined, 'target must actually be cold in the new process')
          // Use the real public human-command transport; never inject or mutate a grant object.
          const grant = await ctx.commands.execute(owner, '/coordinate on ' + prior.sessions.target, [], signal)
          assert.equal(grant.result.kind, 'success')
          await ctx.tools.get('session_coordinator_resume', owner).execute({ sessionId: prior.sessions.target }, { agent: owner, callId: 'preset-proof-resume', signal })
          target = ctx.agents.get(prior.sessions.target)
          report.operations.push({ command: '/coordinate on', target: prior.sessions.target, fixturePrerequisiteOnly: true }, { tool: 'session_coordinator_resume', target: prior.sessions.target })
        }
        assert.ok(target)
        const { id, agentPreset, origin, parentSession, delegationDepth } = target.session.header
        report.target = { id, agentPreset, origin, parentSession, delegationDepth, composedPreset: ctx.agentPresets.composedPreset(target.ctx) }
        assert.equal(agentPreset, presetId); assert.equal(report.target.composedPreset, presetId)
        assert.notEqual(origin, 'subagent'); assert.equal(parentSession, undefined); assert.equal(delegationDepth ?? 0, 0)
        assert.equal(target.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0, 'create/resume never dispatches a hidden task')
        await ctx.sessions.flush(target.session); await ctx.sessions.flush(owner.session)
        assert.equal(report.modelRequests, 0); assert.deepEqual(report.errors, [])
        assert.deepEqual(report.approvals, phase === 'create' ? ['allowed-once'] : [])
        report.pass = true; save()
      })().catch(error => { report.pass = false; report.failure = String(error?.stack ?? error); save() })
    }
    owner.whenIdle = async () => { await idle(); if (dispatched && !checked) { checked = true; await work } }
  })
  process.on('exit', save)
}
