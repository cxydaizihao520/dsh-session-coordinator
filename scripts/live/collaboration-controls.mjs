import assert from 'node:assert/strict'
import fs from 'node:fs'
import { verifyControlsProof } from './controls-proof.mjs'

/** Fixture-driven native control contract, with real models doing all peer business work. */
export function applyCollaborationControls(ctx) {
  const scenario = 'collaboration-controls'
  const report = { scenario, validationLayer: 'fixture-controlled-native-contract', runtime: process.env.DSH_LIVE_RUNTIME, sessions: { workers: [] }, headers: {}, timeline: [], nativeEvents: [], tools: [], approvals: [], errors: [], fatalErrors: [], scopes: {} }
  const save = () => fs.writeFileSync(process.env.DSH_HOME + '/' + scenario + '-report.json', JSON.stringify(report, (key, value) => ['provider', 'model', 'reasoningEffort'].includes(key) ? undefined : value, 2))
  let owner, setup = false, first = true, dispatched = false, checked = false, order = 0, call = 0
  const approved = new Map(), gates = new Map(), results = new Map(), resultWaiters = new Map(), executions = new Map(), counts = { userMessages: 0, tools: 0, turnStarts: 0, turnEnds: 0 }
  const mark = (name, fields = {}) => { const item = { name, order: ++order, time: Date.now(), ...fields }; report.timeline.push(item); save(); return item }
  const latch = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
  const gate = label => { if (!gates.has(label)) gates.set(label, { entered: latch(), release: latch() }); return gates.get(label) }
  const bounded = async (promise, signal, label) => {
    let timer, abort
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' exceeded 120 seconds')), 120000)
      abort = () => reject(signal?.reason ?? new Error(label + ' cancelled'))
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    })]) } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
  }
  const waitResult = (operationId, signal) => results.has(operationId) ? Promise.resolve(results.get(operationId)) : bounded((() => { const value = latch(); resultWaiters.set(operationId, value); return value.promise })(), signal, 'peer result ' + operationId)
  ctx.tools.register({ name: 'acceptance_controls_gate', description: 'Test-only synchronized business work. Call exactly the gate label specified by your assigned task, then use the returned inputs to compute and submit your real collaboration_result. Do not acknowledge other messages.', parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      assert.notEqual(exec.agent, owner)
      const entry = gate(args.label)
      mark(args.label + '-start', { sessionId: exec.agent.id, ...executions.get(exec.agent.id) }); entry.entered.resolve(exec.agent.id)
      const inputs = await bounded(entry.release.promise, exec.signal, args.label)
      mark(args.label + '-end', { sessionId: exec.agent.id, ...executions.get(exec.agent.id) })
      return inputs
    } })
  ctx.on('approval/request', async (request, next) => {
    const allowed = approved.get(request.callId)
    if (request.agent !== owner || !allowed || request.toolName !== allowed.toolName) return next()
    report.approvals.push({ callId: request.callId, toolName: request.toolName, action: allowed.action, outcome: 'allowed-once', syntheticScoped: true }); save()
    return 'allowed-once'
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') { counts.turnStarts++; executions.set(session.id, { turn: event.data.turn, step: 0 }) }
    if (event.type === 'step/start') executions.set(session.id, { turn: event.data.turn, step: event.data.step })
    if (event.type === 'turn/end') counts.turnEnds++
    if (event.type === 'user/message') counts.userMessages++
    if (['turn/start', 'turn/end', 'approval/asked', 'approval/decided'].includes(event.type)) report.nativeEvents.push({ sessionId: session.id, ...event,
      ...(event.type === 'approval/asked' ? { data: { id: event.data.id, callId: event.data.callId, toolName: event.data.toolName } } : {}) })
    if (event.type === 'tool/call') { counts.tools++; report.tools.push({ sessionId: session.id, ...event.data }) }
    if (event.type === 'tool/result' && event.data.message?.isError) report.errors.push({ sessionId: session.id, callId: event.data.message.toolCallId, content: event.data.message.content })
    if (event.type === 'tool/result' && !event.data.message?.isError && report.tools.some(item => item.sessionId === session.id && item.callId === event.data.message?.toolCallId && item.name === 'session_coordinator_collaboration_result')) {
      const result = JSON.parse(event.data.message.content.filter(item => item.type === 'text').map(item => item.text).join(''))
      results.set(result.operationId, result); resultWaiters.get(result.operationId)?.resolve(result)
    }
    save()
  })
  ctx.on('agent/error', ({ agent, error }) => { report.fatalErrors.push({ sessionId: agent.id, code: error?.code }); save() })
  ctx.tools.register({ name: 'acceptance_controls_scenario', description: 'Run the user-authorized isolated native parallel/pause/resume/cancel contract once. Real peers compute all business outputs; this test fixture executes the explicit native controls and records expected refusals. Call once, then present only the returned verified results.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      assert.equal(exec.agent, owner)
      const run = async (name, args, agent = owner) => {
        const callId = exec.callId + '-control-' + ++call, toolName = 'session_coordinator_collaboration_' + name
        if (agent === owner && (name === 'start' || name === 'control')) approved.set(callId, { toolName, action: args.action })
        return ctx.tools.get(toolName, agent).execute(args, { agent, callId, signal: exec.signal })
      }
      const status = scopeId => run('status', { scopeId })
      const finish = (scopeId, taskId, resultIds) => run('control', { scopeId, ...(taskId ? { taskId } : {}), action: 'finish', resultIds, reason: 'Native fixture independently checked the actual peer business result.' })
      const send = (scope, task, target, label, prefix) => run('send', { scopeId: scope.id, taskId: task.id, taskRevision: 1, sessionId: target, intent: 'task', message: `只调用acceptance_controls_gate(label="${label}")取得实际业务输入，然后自己计算，使用session_coordinator_collaboration_result提交text恰为${prefix}=实际整数，evidence写计算依据，正常结束。不要调用其他工具，不给其他会话额外发确认。` })
      const scope = await run('start', { objective: 'Isolated actual parallel business work and pause/resume', newSessions: [{ title: '控制验收·商品' }, { title: '控制验收·运费' }], budget: { maxOperations: 30, maxNoProgress: 8, maxElapsedMs: 480000 } })
      const [worker, other] = scope.members.filter(id => id !== owner.id); report.sessions.workers = [worker, other]
      const taskA = await run('task', { scopeId: scope.id, objective: 'Goods 3*19+2*7', members: [worker] }), taskB = await run('task', { scopeId: scope.id, objective: 'Freight 12+17', members: [other] })
      const opA = await send(scope, taskA, worker, 'parallel-A', 'GOODS_TOTAL'), opB = await send(scope, taskB, other, 'parallel-B', 'FREIGHT_TOTAL')
      await bounded(Promise.all([gate('parallel-A').entered.promise, gate('parallel-B').entered.promise]), exec.signal, 'parallel workers')
      gate('parallel-A').release.resolve({ calculation: '3*19+2*7', outputPrefix: 'GOODS_TOTAL' })
      const resultA = await waitResult(opA.id, exec.signal); assert.equal(resultA.text, 'GOODS_TOTAL=71')
      await run('control', { scopeId: scope.id, taskId: taskA.id, action: 'pause', reason: 'Synthetic user-approved pause after initial evidence; unrelated freight remains active.' })
      mark('task-A-paused')
      const pauseWait = await run('wait', { scopeId: scope.id, taskIds: [taskA.id], afterResultIds: [resultA.id], timeoutMs: 60000 })
      mark('paused-task-wait', { scopeState: pauseWait.scopeState, interrupted: pauseWait.interrupted, timedOut: pauseWait.timedOut, taskState: pauseWait.tasks[0].state })
      const before = (await status(scope.id)), deliveriesBefore = Object.keys(before.operations).length
      let refusal
      try { await send(scope, taskA, worker, 'must-not-run', 'GOODS_TOTAL') } catch (error) { refusal = error.message }
      assert.ok(refusal, 'paused task dispatch must refuse')
      const after = await status(scope.id)
      mark('paused-send-refused', { error: refusal, deliveriesBefore, deliveriesAfter: Object.keys(after.operations).length, taskState: after.tasks[taskA.id].state })
      gate('parallel-B').release.resolve({ calculation: '12+17', outputPrefix: 'FREIGHT_TOTAL' })
      const resultB = await waitResult(opB.id, exec.signal); mark('parallel-B-result', { text: resultB.text, resultId: resultB.id })
      await run('control', { scopeId: scope.id, taskId: taskA.id, action: 'resume', reason: 'Synthetic explicit user-approved resume of the same task.' }); mark('task-A-resumed')
      const again = await send(scope, taskA, worker, 'resumed-A', 'GOODS_TOTAL')
      await bounded(gate('resumed-A').entered.promise, exec.signal, 'resumed worker')
      gate('resumed-A').release.resolve({ calculation: '71-14+14', outputPrefix: 'GOODS_TOTAL', note: 'verify using inverse operations' })
      const resumedResult = await waitResult(again.id, exec.signal); mark('resumed-A-result', { text: resumedResult.text, resultId: resumedResult.id })
      await finish(scope.id, taskA.id, [resultA.id, resumedResult.id]); await finish(scope.id, taskB.id, [resultB.id]); await finish(scope.id, undefined, [resultA.id, resumedResult.id, resultB.id])
      report.scopes.parallel = await status(scope.id)
      const cancellation = await run('start', { objective: 'Cancel only task A while same-agent unrelated B continues', members: [worker], budget: { maxOperations: 20, maxNoProgress: 8, maxElapsedMs: 360000 } })
      const old = await run('task', { scopeId: cancellation.id, objective: 'Old goods 3*19+2*7', members: [worker] }), independent = await run('task', { scopeId: cancellation.id, objective: 'Unrelated 29+14', members: [worker] })
      report.cancelTaskA = old.id; report.cancelTaskB = independent.id
      const oldOp = await send(cancellation, old, worker, 'cancel-first', 'OLD_GOODS_TOTAL')
      await bounded(gate('cancel-first').entered.promise, exec.signal, 'old task gate')
      const active = await status(cancellation.id)
      const newOp = await run('send', { scopeId: cancellation.id, taskId: independent.id, taskRevision: 1, sessionId: worker, intent: 'steer', expectedExecution: active.executions[worker], message: `本会话现在同时处理两个独立任务。请先调用acceptance_controls_gate(label="cancel-second")等待精确取消检查。gate返回后先为原任务operationId=${oldOp.id},taskId=${old.id},taskRevision=1,scopeId=${cancellation.id}提交迟到result，text恰为OLD_GOODS_TOTAL=71，evidence写3*19+2*7。旧任务会被取消，不能重启它。然后为本入站新任务operationId（使用本消息source）计算29+14并result提交UNRELATED_TOTAL=实际整数，evidence写依据，正常结束。不要调用其他工具或额外回确认。` })
      gate('cancel-first').release.resolve({ note: 'A second exact task has arrived at the next step. Read it first and call its cancel-second gate; preserve the old task identifiers for its later result.' })
      await bounded(gate('cancel-second').entered.promise, exec.signal, 'same-agent unrelated task')
      mark('cancel-second-active')
      const live = ctx.agents.get(worker), originalCancel = live.cancel.bind(live); let nativeCancels = 0
      live.cancel = (...args) => { nativeCancels++; return originalCancel(...args) }
      const beforeCancel = await status(cancellation.id)
      try {
        await run('control', { scopeId: cancellation.id, taskId: old.id, action: 'cancel', reason: 'Synthetic user-approved cancellation of A only; same-agent unrelated B must continue.' })
        const afterCancel = await status(cancellation.id)
        mark('task-A-cancelled', { sameWorker: true, nativeExecutionBefore: beforeCancel.executions[worker], nativeExecutionAfter: afterCancel.executions[worker], nativeCancels })
        const noticesBefore = Object.values(afterCancel.operations).filter(op => op.intent === 'result' && op.taskId === old.id).length
        gate('cancel-second').release.resolve({ calculation: '29+14', oldCalculation: '3*19+2*7', note: 'A is now cancelled. Submit its late result first, then submit the unrelated B result.' })
        const late = await waitResult(oldOp.id, exec.signal), lateStatus = await status(cancellation.id)
        mark('late-A-result', { text: late.text, taskState: lateStatus.tasks[old.id].state, newNotifications: Object.values(lateStatus.operations).filter(op => op.intent === 'result' && op.taskId === old.id).length - noticesBefore })
        const good = await waitResult(newOp.id, exec.signal); mark('cancel-B-result', { text: good.text, resultId: good.id })
        await finish(cancellation.id, independent.id, [good.id])
        await run('control', { scopeId: cancellation.id, action: 'cancel', reason: 'Synthetic user-approved closure: cancelled A and completed independent B, no remaining work.' })
        report.scopes.cancel = await status(cancellation.id)
      } finally { live.cancel = originalCancel }
      save()
      return { parallelGoods: resultA.text, parallelFreight: resultB.text, resumedGoods: resumedResult.text, cancellation: 'A cancelled, unrelated B completed; late A evidence retained without revival', verificationPending: 'post-turn 30-second terminal silence check' }
    } })
  ctx.on('agent/created', ({ agent }) => {
    if (setup) { agent.ctx.tools.restrict({ deny: ['acceptance_controls_scenario'] }); return }
    setup = true; owner = agent; report.sessions.owner = owner.id
    owner.ctx.tools.restrict({ deny: ['acceptance_controls_gate'] })
    const followup = owner.followup.bind(owner), whenIdle = owner.whenIdle.bind(owner)
    owner.followup = message => {
      if (!first) return followup(message)
      first = false; dispatched = true
      return followup({ ...message, content: [{ type: 'text', text: '用户授权运行隔离原生并行/暂停恢复/取消验收。请仅调用一次acceptance_controls_scenario，等待它完成，然后汇报它返回的实际业务结果。不要调用其他工具，不启动临时代理，不发确认或索要额外人工消息。工具会按明确测试协议代表本会话发出原生控制；这不是自然语言路由验收。' }] })
    }
    owner.whenIdle = async () => {
      await whenIdle()
      if (!dispatched || checked) return
      checked = true
      try {
        const peers = report.sessions.workers.map(id => ctx.agents.get(id))
        await Promise.all(peers.map(item => item.whenIdle())); await whenIdle()
        for (const agent of [owner, ...peers]) { const { id, origin, parentSession, delegationDepth } = agent.session.header; report.headers[id] = { id, origin, parentSession, delegationDepth } }
        report.humanInputCounts = Object.fromEntries([owner, ...peers].map(agent => [agent.id, agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length]))
        const start = Date.now(), before = { ...counts }
        report.silence = { durationMs: 0, before, startedAfterTerminal: report.scopes.parallel?.state === 'completed' && report.scopes.cancel?.state === 'cancelled' }
        mark('terminal-observation-start')
        await new Promise(resolve => setTimeout(resolve, 30000))
        report.silence.durationMs = Date.now() - start; report.silence.after = { ...counts }
        report.turnEnds = report.nativeEvents.filter(event => event.type === 'turn/end').map(event => ({ sessionId: event.sessionId, turn: event.data.turn, kind: event.data.reason.kind }))
        report.result = verifyControlsProof(report); report.pass = true
      } catch (error) { report.pass = false; report.failure = String(error?.stack ?? error) }
      save()
    }
  })
  process.on('exit', save)
}
