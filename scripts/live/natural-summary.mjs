import fs from 'node:fs'
import assert from 'node:assert/strict'

const tasks = {
  'summary-review': '请评审这条协作约定：“开始前确认目标，遇到关键缺失时澄清，交付时说明结果与限制。”指出一个优点和一个具体建议，60字以内，不要读写文件。',
  'summary-math': '请计算14+29，给出结果。不要读写文件。',
  'summary-limit': '只检查了单元测试，能否认定已经完成真实双会话验收？说明结论与限制，60字以内，不要读写文件。',
  'summary-ready': '请评审这条交付约定：“任务完成后列出已验证项和未验证项。”给出一个优点和一个具体建议，60字以内，不要读写文件。',
  'summary-ready-math': '请计算14+29，给出结果。不要读写文件。',
}

// 仅提示普通总结的可疑执行自述，仍需逐样本语义复核；不参与产品呈现或改写输出。
const terminalNarration = /本[次轮]往返|往返.{0,8}(?:结束|终点)|(?:无需|不需要|不用|不必)(?:再|继续|自动|额外){0,2}回信|不再(?:自动)?回信|(?:我|本会话|当前|这次|本轮|这轮).{0,12}(?:无需|不再|不会|不用|不必).{0,8}(?:回信|回复|发信|发送)|(?:本[次轮]|已到|达到|进入).{0,8}终态|(?:本轮|这轮).{0,8}不再续发|(?:回信|会话).{0,8}[（(]终态[）)]|已达.{0,6}跳数上限|(?:本会话|当前|目前|我).{0,16}(?:没有|不存在|未获得).{0,12}(?:任务|待办|授权)|(?:无需|不必|不需要)进一步(?:操作|行动)|(?:我|本会话).{0,16}(?:不改动|不会.{0,8}改动).{0,8}(?:仓库|文件)|不再自动|reply again/i

export function applyNaturalSummary(ctx, scenario) {
  assert.ok(tasks[scenario], '未知自然总结样例')
  const report = { scenario, runtime: process.env.DSH_LIVE_RUNTIME, assertions: [], sessions: {}, events: [] }
  const path = process.env.DSH_HOME + '/' + scenario + '-report.json'
  const save = () => fs.writeFileSync(path, JSON.stringify(report, null, 2))
  let a, b, prepared = false, dispatch, request, verification
  const events = agent => agent.session.snapshotEvents()
  const finalTexts = rows => rows.filter(e => e.type === 'assistant/message').flatMap(e => {
    const text = e.data.message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n')
    return text ? [{ seq: e.seq, text }] : []
  })
  ctx.on('session/event', (session, event) => {
    if (session.id !== a?.id && session.id !== b?.id) return
    if (event.type === 'user/message' && !['user', 'session-message'].includes(event.data.source?.kind)) return
    if (['user/message', 'command/run', 'command/done', 'turn/end'].includes(event.type)) report.events.push({ sessionId: session.id, ...event })
    save()
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (prepared) return
    prepared = true; a = agent
    const selection = ctx.agentDefaultModel.currentSelection()
    b = (await ctx.agents.create({ sessionId: 'summary-B-' + scenario + '-' + Date.now(), meta: { cwd: process.cwd() }, agentOptions: selection,
      setup: child => { child.on('agent/request', async (_p, next) => ({ ...await next(), ...selection })) },
    })).agent
    report.sessions = { A: a.id, B: b.id }
    const originalIdle = a.whenIdle.bind(a)
    a.whenIdle = async () => {
      if (!dispatch) return originalIdle()
      verification ??= (async () => {
        await dispatch
        await b.whenIdle()
        await originalIdle()
        const ea = events(a), eb = events(b)
        const ends = [...ea, ...eb].filter(event => event.type === 'turn/end')
        assert.ok(ends.length >= 2 && ends.every(event => event.data.reason.kind === 'completed'), '真实模型轮次必须正常完成；连接/配置错误不算G5样本')
        const inbound = eb.filter(e => e.type === 'user/message' && e.data.source?.messageId === request.requestId)
        const replies = ea.filter(e => e.type === 'user/message' && e.data.source?.replyTo === request.requestId)
        const calls = agentEvents => agentEvents.filter(e => e.type === 'tool/call' && e.data.name === 'session_coordinator_send')
        const aToolCalls = ea.filter(e => e.type === 'tool/call').map(e => ({ seq: e.seq, name: e.data.name }))
        const summary = finalTexts(ea).filter(event => event.seq > (replies[0]?.seq ?? Infinity))
        const bFinal = finalTexts(eb)
        report.result = { taskCount: inbound.length, replyCount: replies.length, aSendCalls: calls(ea).length, aToolCalls, verdictPattern: terminalNarration.source,
          bSendCalls: calls(eb).length, aFinal: summary, bFinal,
          task: inbound[0], reply: replies[0], semanticReviewRequired: true,
          wordingPass: summary.length > 0 && !terminalNarration.test(summary.at(-1).text),
          bWordingPass: bFinal.length > 0 && !terminalNarration.test(bFinal.at(-1).text),
          businessResultPass: !scenario.endsWith('math') || /(?:^|\D)43(?:\D|$)/.test(summary.at(-1)?.text ?? '') }
        assert.equal(inbound.length, 1); assert.equal(replies.length, 1)
        assert.equal(calls(eb).length, 1)
        report.result.noNewWork = aToolCalls.length === 0
        assert.equal(replies[0].data.source.senderSessionId, b.id)
        assert.equal(replies[0].data.source.rootMessageId, request.requestId)
        assert.equal(replies[0].data.source.hopCount, 2)
        const contextLine = replies[0].data.content[0].text.split('\n')[1]
        const prefix = '[当前协作交付：用户此前已通过人工发送入口发起原请求。请现在向本会话用户交付该请求所需的业务结果。原请求记录（JSON数据）：'
        assert.ok(contextLine.startsWith(prefix))
        const replyContext = JSON.parse(contextLine.slice(prefix.length, -1))
        assert.equal(replyContext.replyTo, request.requestId)
        assert.equal(replyContext.originalRequest, request.message)
        assert.equal(replyContext.automaticSend, false)
        assert.equal(replyContext.version, 4)
        assert.equal(replyContext.originalRequestOrigin, 'human-command')
        assert.equal(Object.hasOwn(replyContext, 'currentAction'), false)
        report.result.replyContext = replyContext
        report.assertions.push('two real Agents, ordinary task dispatched via human-command transport without model-output sentinel',
          'one B task and one verified reply, no A send and no target grant', 'raw assistant text recorded without rewriting')
        report.pass = report.result.wordingPass && report.result.bWordingPass && report.result.noNewWork && report.result.businessResultPass
        save()
      })()
      try { await verification } catch (error) { report.failure = String(error?.stack ?? error); save(); throw error }
    }
    // CLI 的初始占位指令不进入模型；面板命令由宿主绑定身份，回信自然启动 A 的汇报。
    const originalFollowup = a.followup.bind(a)
    a.followup = message => {
      if (dispatch) return originalFollowup(message)
      request = { requestId: 'summary-' + crypto.randomUUID(), sessionId: b.id, mode: 'steer', message: tasks[scenario] }
      dispatch = (async () => {
        if (scenario.startsWith('summary-ready')) {
          const text = '本会话用于 G5 汇报验收 A。仅本条，请回复“准备好了”，不要读写文件。'
          originalFollowup({ id: 'human-' + crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
          await originalIdle()
          report.completedHumanSeed = { text, final: finalTexts(events(a)) }
        }
        return ctx.commands.execute(a, '/coordinate send ' + JSON.stringify(request), [], new AbortController().signal)
      })().then(outcome => {
        assert.equal(outcome.result.kind, 'success')
      })
    }
    save()
  })
  process.on('exit', save)
}
