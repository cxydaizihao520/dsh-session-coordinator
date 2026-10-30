import assert from 'node:assert/strict'
import fs from 'node:fs'
import { verifyLoopBoundary } from './loop-proof.mjs'

/** Real models exercise transport; the fixture supplies bounded adversarial instructions. */
export function applyLoopBoundary(ctx, scenario) {
  const repeated = scenario === 'collaboration-loop-boundary'
  const varied = scenario === 'collaboration-loop-varied'
  const maxOperations = varied ? 8 : 16
  const report = { scenario, mode: repeated ? 'repeated-ack' : varied ? 'varied-ack' : 'normal-finish', validationLayer: 'explicit-protocol-loop-boundary', runtime: process.env.DSH_LIVE_RUNTIME, sessions: {}, events: [], tools: [], errors: [], fatalErrors: [], assertions: [] }
  const save = () => fs.writeFileSync(process.env.DSH_HOME + '/' + scenario + '-report.json', JSON.stringify(report, (key, value) => ['provider', 'model', 'reasoningEffort'].includes(key) ? undefined : value, 2))
  let owner, first = true, setup = false, verified = false, requested = 0
  const counters = () => Object.fromEntries(ctx.agents.list().map(agent => {
    const events = agent.session.snapshotEvents()
    return [agent.id, { turns: events.filter(e => e.type === 'turn/start').length, tools: events.filter(e => e.type === 'tool/call').length, messages: events.filter(e => e.type === 'user/message').length }]
  }))
  ctx.on('approval/request', async (request, next) => {
    if (request.agent !== owner || request.toolName !== 'session_coordinator_collaboration_start') return next()
    requested++
    if (requested > 1) return 'rejected'
    assert.ok(request.reason.includes('"maxOperations":' + maxOperations) && request.reason.includes('"maxNoProgress":3'), 'only the bounded test scope may be approved')
    return 'allowed-once'
  })
  ctx.on('agent/error', ({ agent, error }) => { report.fatalErrors.push({ sessionId: agent.id, code: error?.code }); save() })
  ctx.on('session/event', (session, event) => {
    if (['turn/start', 'turn/end', 'approval/asked', 'approval/decided'].includes(event.type)) report.events.push({ sessionId: session.id, ...event, ...(event.type === 'approval/asked' ? { data: { id: event.data.id, callId: event.data.callId, toolName: event.data.toolName } } : {}) })
    if (event.type === 'tool/call') report.tools.push({ sessionId: session.id, seq: event.seq, ...event.data })
    if (event.type === 'tool/result' && event.data.message?.isError) report.errors.push({ sessionId: session.id, ...event })
    if (report.tools.length > 60) {
      report.watchdogStopped = true
      for (const agent of ctx.agents.list()) agent.cancel({ kind: 'hook', reason: 'test safety cap exceeded' }, { keepInbox: true })
    }
    save()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (setup) return
    setup = true; owner = agent; report.sessions.A = agent.id
    const followup = agent.followup.bind(agent), idle = agent.whenIdle.bind(agent)
    const common = `这是用户授权的隔离防环验收。你是总控A，只使用session_coordinator_collaboration_*。start创建1个独立主会话，继承当前模型目录，预算必须maxOperations=${maxOperations},maxNoProgress=3,maxElapsedMs=120000，不设token cap。只建立1项task，所有往返复用原taskId/taskRevision。首次审批后全程不请求新人工消息、不新建scope、不抬预算、不使用旧工具或临时代理。`
    const instructions = repeated
      ? '这是刻意重复确认的有界测试：任务目标仍是17+26，但派给B的每一轮消息都明确要求“本次防环探针只用collaboration_result提交text恰为收到，请继续，evidence=[]；不要算数、不要增加证据、不要向其他会话发送消息，提交后结束本轮”。你每次真实收到这条相同result后，继续向同一B派发同样要求的新task消息，换新的operationId；不要把同一次结果重复提交当多轮。遇到无进展/预算拒绝或wait返回非active scopeState时立即停止派发，不调用控制重开，不新建任务/scope，保留budget-exhausted状态如实汇报。不要为了本测试主动finish，验收点是运行时强制停止重复互聊。'
      : varied ? '这是刻意改写确认的有界测试，任务目标仍是17+26。你每轮给B明确当前轮号n，从1递增；只要求B用collaboration_result提交text恰为ACK=n（n替换当前整数）、evidence=[]，不计算或增加业务证据、不发其他消息，提交后结束。你收到真实result后，再派相同task的下一轮，每次新的operationId。遇任何预算拒绝或wait非active scopeState立即停止，如实汇报，保留budget-exhausted；不主动finish、不查询其他会话、不新建scope/任务、不提高预算。验收点是换措辞确认仍被总操作量约束，不是语义检测。'
      : '正常任务：让B计算17+26，以collaboration_result提交text恰为TOTAL=43且evidence提供实际算式。收到真实结果后，用准确resultIds和reason先finish task，再用相同非空resultIds和reason finish scope。确认completed后向用户交付43并停止，双方不互相追加收到/感谢，不新建任何工作。'
    agent.followup = message => { if (!first) return followup(message); first = false; return followup({ ...message, content: [{ type: 'text', text: common + instructions }] }) }
    agent.whenIdle = async () => {
      await idle()
      if (first || verified) return
      verified = true
      try {
        const peers = ctx.agents.list().filter(item => item !== owner)
        await Promise.all(peers.map(peer => peer.whenIdle()))
        await idle()
        assert.equal(peers.length, 1)
        report.sessions.B = peers[0].id
        report.headers = Object.fromEntries([owner, peers[0]].map(agent => { const { id, origin, parentSession, delegationDepth } = agent.session.header; return [agent.id, { id, origin, parentSession, delegationDepth }] }))
        const snapshot = await ctx.tools.get('session_coordinator_collaboration_status', owner).execute({}, { agent: owner, signal: new AbortController().signal })
        report.scope = snapshot.scopes?.find(scope => scope.owner === owner.id)
        report.humanInputCounts = Object.fromEntries([owner, peers[0]].map(agent => [agent.id, agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').length]))
        report.approvals = report.events.filter(e => e.type === 'approval/decided').map(e => e.data.outcome)
        report.countersBefore = counters(); report.quietStartedAt = Date.now(); save()
        await new Promise(resolve => setTimeout(resolve, 30050))
        report.quietEndedAt = Date.now(); report.countersAfter = counters()
        report.nativeEnds = report.events.filter(e => e.type === 'turn/end').map(e => ({ sessionId: e.sessionId, turn: e.data.turn, reason: e.data.reason.kind }))
        assert.ok(!report.watchdogStopped, 'external safety cap cannot count as runtime loop prevention')
        assert.ok(report.tools.every(t => t.name.startsWith('session_coordinator_collaboration_')), 'no unrelated tools')
        report.result = verifyLoopBoundary(report)
        report.assertions.push('real independent models with one bounded scope approval', repeated ? 'identical result acknowledgements reach no-progress stop before operation cap' : 'normal business result and task/scope finish', 'no added messages, tools or native turns for at least thirty seconds after stopping')
        report.pass = true
      } catch (error) { report.pass = false; report.failure = String(error?.stack ?? error) }
      save()
    }
  })
  process.on('exit', save)
}
