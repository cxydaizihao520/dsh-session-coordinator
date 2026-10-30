import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HarnessError, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { tenRoundPrompt, verifyTenRoundLedger } from './ten-round-ledger.mjs'

/** Isolated native profile only; the test answerer approves this one requested scope. */
export function applyCollaboration(ctx, scenario = 'collaboration') {
  const failure = scenario === 'collaboration-failure'
  const tenRounds = scenario === 'collaboration-ten-rounds'
  const report = { scenario, validationLayer: 'explicit-protocol', runtime: process.env.DSH_LIVE_RUNTIME, assertions: [], sessions: {}, tools: [], events: [], errors: [], fatalErrors: [] }
  const save = () => fs.writeFileSync(process.env.DSH_HOME + '/' + scenario + '-report.json', JSON.stringify(report, null, 2))
  let owner, setup = false, first = true, dispatched = false
  ctx.on('approval/request', async (request, next) => {
    if (request.agent === owner && request.toolName === 'session_coordinator_collaboration_start') return 'allowed-once'
    return next()
  })
  if (failure) ctx.on('llm/stream', async function* (request, next) {
    if (isAgentLoopRequest(request) && request.sessionId !== owner?.id) throw new HarnessError('Acceptance probe: collaborator network transport failed', 'NETWORK')
    yield* next()
  })
  ctx.on('agent/error', ({ agent, error, turn }) => {
    report.fatalErrors.push({ sessionId: agent.id, turn, code: error?.code ?? 'UNKNOWN' }); save()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call' && event.data.name.startsWith('session_coordinator_collaboration_')) report.tools.push({ sessionId: session.id, name: event.data.name })
    if (['turn/start', 'turn/end', 'approval/asked', 'approval/decided'].includes(event.type)) report.events.push({ sessionId: session.id, ...event })
    if (event.type === 'tool/result' && event.data.message?.isError) report.errors.push({ sessionId: session.id, ...event })
    if (event.type === 'user/message' && event.data.source?.kind === 'session-collaboration') report.events.push({ sessionId: session.id, ...event })
    save()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (setup) return
    setup = true; owner = agent; report.sessions.A = owner.id
    const original = owner.followup.bind(owner), originalIdle = owner.whenIdle.bind(owner)
    owner.followup = message => {
      if (!first) return original(message)
      first = false; dispatched = true
      return original({ ...message, content: [{ type: 'text', text: failure
        ? '这是已授权的隔离协作失败路径验收。仅用 session_coordinator_collaboration_*：start 创建1个独立会话（newSessions，继承当前目录和模型），预算maxOperations=8,maxNoProgress=4,maxElapsedMs=180000。建立1项任务计算1+1并send(intent=task)，然后wait等待结果或待处理状态。测试会在参与者执行时注入一次致命NETWORK错误。收到失败/needsAttention后，不重派、不换ID重试、不新建会话；将该task及总scope分别control fail并说明NETWORK。最终输出COLLABORATION_FAILED_VISIBLE，向用户说明连接失败需要处理。不要无限等待。'
        : tenRounds ? tenRoundPrompt :
        '这是已获用户授权的隔离多会话协作协议验收。请使用 session_coordinator_collaboration_* 完成整个工作：start 创建3个新的独立会话（newSessions，各继承当前目录和模型），总控是你。预算 maxOperations=24,maxNoProgress=12,maxElapsedMs=240000。任务1由第一个会话计算7+8，任务2由第二个会话计算9+14。先创建两个独立task并分别send(intent=task)，让接收者以任务协议result提交真实结果。每个计算任务都在原taskId和taskRevision内连续进行三轮：第一轮计算；收到result后第二轮发新的task消息要求换方法复核；收到第二轮result后第三轮发新的task消息要求用逆运算验证第二轮结果。每轮使用新的operationId，必须等到上一轮真实result后再派下一轮，不能把三轮并行发出，也不要为复核另建task。然后把两个已三轮复核的结果交给第三个会话，在task3中审查是否分别为15和23。用wait等待关联结果，必要时status查询。根据实际结果完成三个task并finish总scope，最终只输出COLLABORATION_VERIFIED_15_23。不得调用旧send/create，不得把普通文本当作result，不运行其他无关工具。每次协作result工具的evidence提供简短计算依据。' }] })
    }
    owner.whenIdle = async () => {
      await originalIdle()
      if (!dispatched) return
      const deadline = Date.now() + (tenRounds ? 620000 : 260000)
      let snapshot
      while (Date.now() < deadline) {
        const status = ctx.tools.get('session_coordinator_collaboration_status', owner)
        snapshot = await status.execute({}, { agent: owner, signal: new AbortController().signal })
        const scopes = snapshot.scopes ?? []
        if (scopes.some(scope => scope.state === (failure ? 'failed' : 'completed'))) break
        const collaborators = ctx.agents.list().filter(item => item !== owner)
        await Promise.all(collaborators.map(item => item.whenIdle()))
        await originalIdle()
        if (ctx.agents.list().every(item => item.status === 'idle')) break
      }
      try {
        const scope = snapshot?.scopes?.find(item => item.owner === owner.id)
        assert.ok(scope, 'native collaboration scope must exist')
        report.scope = scope
        if (failure) {
          assert.equal(scope.state, 'failed')
          assert.equal(scope.members.length, 2)
          assert.equal(Object.keys(scope.tasks).length, 1)
          assert.ok(Object.values(scope.tasks).every(task => task.state === 'failed'))
          assert.equal(Object.values(scope.operations).filter(operation => operation.intent === 'task').length, 1, 'fatal failure never blindly resends work')
          assert.equal(Object.keys(scope.results).length, 0, 'execution error is not a fabricated business result')
          assert.ok(report.fatalErrors.some(error => error.sessionId !== owner.id && error.code === 'NETWORK'), 'native terminal worker error must actually occur')
          report.assertions.push('real native fatal NETWORK stops worker execution', 'owner receives failure and ends with explicit failed scope', 'no result fabrication or automatic task retry')
          report.pass = true; save(); return
        }
        if (tenRounds) {
          report.rounds = verifyTenRoundLedger(scope)
          const worker = ctx.agents.get(scope.members.find(id => id !== owner.id))
          const header = worker?.session.header
          assert.ok(header && header.origin !== 'subagent' && header.parentSession === undefined && (header.delegationDepth ?? 0) === 0)
          report.sessions.worker = worker.id
          report.humanInputCounts = Object.fromEntries([owner, worker].map(agent => [agent.id, agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length]))
          assert.equal(report.humanInputCounts[owner.id], 1)
          assert.equal(report.humanInputCounts[worker.id], 0)
          report.approvals = report.events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome)
          assert.deepEqual(report.approvals, ['allowed-once'])
          assert.equal(report.fatalErrors.length, 0)
          assert.equal(report.errors.length, 0, 'any native tool error requires inspection; never hide an alert behind eventual completion')
          report.assertions.push('one real independent peer, ten sequential original-task request/result exchanges', 'all ten actual ledger results verified, final inventory 200', 'one initial native approval; owner human=1 and peer human=0', 'scope and task completed, zero tool errors or fatal errors')
          report.pass = true; save(); return
        }
        assert.equal(scope.state, 'completed')
        const tasks = Object.values(scope.tasks)
        assert.ok(tasks.length >= 3 && tasks.every(task => task.state === 'completed'))
        assert.equal(scope.members.length, 4)
        for (const [index, id] of scope.members.filter(id => id !== owner.id).entries()) {
          report.sessions['worker' + (index + 1)] = id
          const header = ctx.agents.get(id)?.session.header
          assert.ok(header, 'created collaborator must have a real native Session')
          assert.notEqual(header.origin, 'subagent', 'independent chat cannot be a child agent')
          assert.equal(header.parentSession, undefined, 'new independent chat cannot inherit a parent Session')
          assert.equal(header.delegationDepth ?? 0, 0)
        }
        assert.ok(Object.values(scope.results).length >= 7, 'three rounds for both computations plus third reviewer')
        const threeRoundTasks = tasks.filter(task => {
          const rounds = Object.values(scope.operations).filter(op => op.taskId === task.id && op.taskRevision === task.revision && op.intent === 'task')
            .map(op => ({ op, result: Object.values(scope.results).find(result => result.operationId === op.id && result.taskId === task.id && result.taskRevision === task.revision && result.sender === op.target && !result.stale) }))
            .filter(round => round.result).sort((a, b) => a.op.createdAt - b.op.createdAt)
          let lastResult = -1, count = 0
          for (const round of rounds) if (round.op.createdAt >= lastResult) { count++; lastResult = round.result.createdAt }
          return count >= 3
        })
        assert.equal(threeRoundTasks.length, 2, 'two original tasks must each complete three causally ordered current-revision exchanges')
        assert.ok(Object.values(scope.operations).filter(operation => operation.intent === 'task').every(operation => operation.requestInclusion?.evidence === 'native-llm-stream'), 'actual host model requests must include each exact task input; history admission alone is insufficient')
        assert.equal(report.events.filter(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once').length, 1)
        assert.ok(report.events.filter(event => event.type === 'user/message' && event.data.source.intent === 'task').length >= 7)
        assert.equal(Object.values(scope.operations).filter(operation => operation.intent === 'result').length, 7, 'one notification reservation per persisted result; owner may consume results through wait before the queued notification')
        assert.equal(owner.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length, 1, 'no additional human message may unlock later automatic rounds')
        report.assertions.push('real owner + 3 newly created top-level sessions', 'two original tasks each complete three ordered rounds plus third-session review', 'one native audited scope approval without human third-hop unlock', 'native admitted inputs, correlated results, Agent evidence-based finish')
        report.pass = true
      } catch (error) { report.pass = false; report.failure = String(error?.stack ?? error) }
      save()
    }
  })
  process.on('exit', save)
}
