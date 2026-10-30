import fs from 'node:fs'
import assert from 'node:assert/strict'
import { applyNaturalSummary } from './natural-summary.mjs'
import { applyCollaboration } from './collaboration.mjs'
import { applyBusyOwner } from './collaboration-busy.mjs'
import { applyCollaborationControls } from './collaboration-controls.mjs'
import { applyCollaborationRecovery, applyPresetColdProof } from './collaboration-recovery.mjs'
import { applyLoopBoundary } from './collaboration-loop.mjs'
export const inject = ['agents','commands','tools','agentDefaultModel','sessions','agentPresets']
export function apply(ctx) {
  const scenario = process.env.DSH_LIVE_CASE ?? 'idle'
  if (scenario.startsWith('collaboration-preset-')) return applyPresetColdProof(ctx)
  if (scenario.startsWith('collaboration-loop-')) return applyLoopBoundary(ctx, scenario)
  if (scenario.startsWith('collaboration-recovery-')) return applyCollaborationRecovery(ctx)
  if (scenario === 'collaboration-busy-owner') return applyBusyOwner(ctx)
  if (scenario === 'collaboration-controls') return applyCollaborationControls(ctx)
  if (scenario.startsWith('collaboration')) return applyCollaboration(ctx, scenario)
  if (scenario.startsWith('summary-')) return applyNaturalSummary(ctx, scenario)
  const report = { scenario, runtime: process.env.DSH_LIVE_RUNTIME, assertions: [], sessions: {}, events: [] }
  const reportPath = process.env.DSH_HOME + '/' + scenario + '-report.json'
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  let a, b, prepared = false, checked = false, dispatched = false, startHold, releaseHold
  const holding = new Promise(resolve => { startHold = resolve })
  const held = new Promise(resolve => { releaseHold = resolve })
  const events = agent => agent.session.snapshotEvents()
  const message = text => ({ id: 'human-' + crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const fail = error => { report.failure = String(error?.stack ?? error); save(); throw error }
  ctx.tools.register({ name: 'acceptance_hold', description: 'Test only: hold this step until the A task arrives. Call it once when asked.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'A task arrived; process it now.' }] },
    async execute() { startHold(); await held; return { released: true } },
  })
  ctx.on('session/event', (session,event) => {
    if (session.id !== a?.id && session.id !== b?.id) return
    if (event.type === 'user/message' && !['user','session-message'].includes(event.data.source?.kind)) return
    if (['user/message','tool/call','tool/result','turn/start','turn/end','step/start','agent/inbox/spliced','command/run','command/done'].includes(event.type)) {
      report.events.push({ sessionId:session.id,...event }); save()
    }
    if (session.id === b?.id && event.type === 'agent/inbox/spliced' && event.data.inserted?.some(m=>m.source?.kind==='session-message')) releaseHold()
  })
  ctx.on('agent/created', async ({agent}) => {
    if (prepared) return
    prepared = true; a = agent
    try {
      assert.ok(ctx.tools.get('session_coordinator_send', a), 'coordinator plugin must be mounted')
      const selection = ctx.agentDefaultModel.currentSelection()
      b = (await ctx.agents.create({sessionId:'accept-B-' + scenario + '-' + Date.now(),meta:{cwd:process.cwd()},agentOptions:selection,
        setup: child => { child.on('agent/request', async (_p,next) => ({...await next(),...selection})) },
      })).agent
      report.sessions = { A: a.id, B: b.id }
      if (scenario !== 'panel') {
        const grant = await ctx.commands.execute(a,'/coordinate on ' + b.id,[],new AbortController().signal)
        assert.equal(grant.result.kind,'success'); report.assertions.push('only A explicitly authorized to B')
      } else report.assertions.push('manual panel dispatch grants only this message, no target grant')
      const bStatus = await ctx.commands.execute(b,'/coordinate status',[],new AbortController().signal)
      assert.match(bStatus.result.text,/未授权/); report.assertions.push('B has no blanket coordination grant')
      const originalIdle = a.whenIdle.bind(a)
      a.whenIdle = async () => {
        await originalIdle()
        if (!dispatched) return
        // send.waitForReply 可先返回中间文字；等 B 回信、A 消费后才能结束验收。
        await b.whenIdle()
        await originalIdle()
        const terminal = events(a).find(e=>e.type==='user/message' && e.data.source?.kind==='session-message' && e.data.source.hopCount===2)
        if (terminal && !checked) {
          await b.whenIdle()
          const send=ctx.tools.get('session_coordinator_send',a)
          await assert.rejects(()=>send.execute({sessionId:b.id,message:'forbidden third hop',replyTo:terminal.data.id},{agent:a,signal:new AbortController().signal}),/terminal/)
          await assert.rejects(()=>send.execute({sessionId:b.id,message:'forbidden implicit third hop'},{agent:a,signal:new AbortController().signal}),/terminal/)
          const root = events(b).find(e=>e.type==='user/message' && e.data.source?.kind==='session-message')
          await assert.rejects(()=>send.execute({sessionId:a.id,message:'duplicate reply',replyTo:root.data.id},{agent:b,signal:new AbortController().signal}),/already/)
          checked=true
          report.assertions.push('explicit and omitted-replyTo third hops refused by the actual host', 'B duplicate reply refused')
          const receipts=ctx.tools.get('session_coordinator_message_status',a)
          report.receipts={task:await receipts.execute({sessionId:b.id,messageId:root.data.id},{}),reply:await receipts.execute({sessionId:a.id,messageId:terminal.data.id},{})}
          assert.equal(report.receipts.task.status,'acknowledged');assert.equal(report.receipts.reply.status,'acknowledged');assert.equal(report.receipts.reply.terminal,true)
          report.assertions.push('both real log receipts acknowledged')
          const endA=events(a).filter(e=>e.type==='turn/end'),endB=events(b).filter(e=>e.type==='turn/end')
          assert.ok(endA.every(e=>e.data.reason.kind==='completed'));assert.ok(endB.every(e=>e.data.reason.kind==='completed'))
          report.assertions.push('all A/B turns completed without interruption')
          if (scenario === 'busy') {
            const heldCall=events(b).find(e=>e.type==='tool/call' && e.data.name==='acceptance_hold')
            const taskStep=events(b).filter(e=>e.type==='step/start' && e.seq < root.seq).at(-1)
            assert.equal(taskStep.data.turn,heldCall.data.turn)
            assert.ok(taskStep.data.step>heldCall.data.step)
            report.assertions.push('busy B consumed the task at the next step in the same turn')
          }
          save()
        }
      }
      await assert.rejects(()=>ctx.tools.get('session_coordinator_send',a).execute({sessionId:'unauthorized-C',message:'forbidden target'},{agent:a,signal:new AbortController().signal}),/not authorized/)
      report.assertions.push('A sending to an unspecified C is refused')
      if (scenario==='busy') {
        b.followup(message('这是双会话验收。先调用 acceptance_hold，等待A的任务；收到任务后按其要求执行并用 session_coordinator_send 回信，然后仅输出 B_DONE。不要调用其它工具。'))
        const timer = setTimeout(()=>fail(new Error('B did not enter acceptance_hold in 45 seconds')),45000)
        await holding; clearTimeout(timer)
        assert.equal(b.status,'running'); report.assertions.push('B is running inside a real model-issued tool step before A starts')
      }
      const task = `这是会话间闭环验收。请只调用 session_coordinator_send，sessionId=${b.id}，message="验收任务：计算7+8，完成后用 session_coordinator_send 发回来源会话，内容 LIVE_REPLY_15，并带消息中给出的replyTo。完成后只输出B_DONE。"，waitForReply=true，timeoutMs=60000。收到回信后仅输出A_DONE，不再发送消息，不调用其它工具。`
      // The headless task is replaced with a test-only instruction using its actual generated B id.
      const original = agent.followup.bind(agent)
      let first = true
      agent.followup = msg => {
        if (first) {
          first=false
          dispatched=true
          if (scenario === 'panel') {
            const request = {requestId:'panel-' + crypto.randomUUID(),sessionId:b.id,mode:'steer',message:'验收任务：计算7+8，完成后用 session_coordinator_send 回给来源会话，内容 LIVE_REPLY_15，带消息中给出的replyTo，然后仅输出B_DONE。'}
            void ctx.commands.execute(a,'/coordinate send ' + JSON.stringify(request),[],new AbortController().signal).then(outcome=> {
              assert.equal(outcome.result.kind,'success');report.assertions.push('existing human-command transport dispatched the panel request');save()
            }).catch(fail)
            original(message(`请只用 session_coordinator_wait 等待会话 ${b.id} 的执行结果，sinceSeq=-1，requireTurnEnd=true，timeoutMs=60000。收到回信后只输出A_DONE，不发消息，不调用其它工具。`))
          } else original(message(task))
        } else original(msg)
      }
      report.assertions.push('A and B are distinct real top-level Agents'); save()
    } catch(error) { fail(error) }
  })
  process.on('exit', () => {
    if (a && b) {
      const ea=events(a), eb=events(b)
      const inboundA=ea.filter(e=>e.type==='user/message' && e.data.source?.kind==='session-message')
      const inboundB=eb.filter(e=>e.type==='user/message' && e.data.source?.kind==='session-message')
      report.result={aMessages:inboundA.length,bMessages:inboundB.length,aReply:inboundA.map(e=>e.data.content),bRequests:eb.filter(e=>e.type==='step/start').length,thirdHopChecked:checked}
      report.pass = inboundA.length===1 && inboundB.length===1 && checked && inboundA[0].data.content.some(p=>p.text?.includes('LIVE_REPLY_15'))
    }
    save()
  })
}
