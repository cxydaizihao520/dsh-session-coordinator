import assert from 'node:assert/strict'
import {test} from 'node:test'
import {pluginRecordOf} from '@deepseek-ai/dsh-session'
import {markAgentLoopRequest} from '@deepseek-ai/dsh-llm'
import {tasksFixture} from './fixtures/session-tasks.mjs'
import {sessionControlCommand} from '../src/session-control.ts'

test('explicit task controls reuse the first approval without extending actor or action scope',async()=>{
 const h=await tasksFixture(['A','B'],{controllers:['A'],actions:['task.pause','task.resume']})
 const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'approved-controls-task'})
 const input={object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'pause shipping',controlHandle:h.controlHandle,requestId:'approved-controls-pause'}
 const paused=await h.run('control',input)
 assert.equal(paused.state,'paused',JSON.stringify(paused));assert.equal(h.approvals.length,1)
 h.human('B')
 const denied=await h.run('control',{...input,action:'resume',requestId:'approved-controls-wrong-actor'},'B')
 assert.equal(denied.outcome,'rejected');assert.equal(h.approvals.length,1)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'paused')
 const action=await h.run('control',{...input,action:'cancel',requestId:'approved-controls-wrong-action'})
 assert.equal(action.outcome,'rejected');assert.equal(h.approvals.length,1)
 const resumed=await h.run('control',{...input,action:'resume',reason:'resume only remaining shipping',requestId:'approved-controls-resume'})
 assert.equal(resumed.state,'active');assert.equal(h.approvals.length,1)
})

test('task control cannot expand affected members and direct user actions retain lifecycle protections',async()=>{
 const h=await tasksFixture(['A','B','C'],{targets:['A','B'],actions:['task.pause','task.resume']})
 const expanded=await h.run('task',{communicationHandle:h.communicationHandle,objective:'expanded review',members:['B','C'],requestId:'expanded-control-task'})
 const denied=await h.run('control',{object:'task',action:'pause',taskHandle:expanded.taskHandle,expectedRevision:1,reason:'do not cover C',controlHandle:h.controlHandle,requestId:'control-task-outside-targets'})
 assert.equal(denied.error.code,'CONTROL_AUTHORIZATION_DENIED');assert.equal(h.approvals.length,1)
 const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'direct-user-control-task'})
 let command=0
 const run=async input=>{const rawInput=' control '+JSON.stringify(input),commandId='direct-task-command-'+(++command),agent=h.agents.get('A');agent.session.append('command/run',{commandId,name:'coordinate',args:rawInput,source:{kind:'user'}});const result=await sessionControlCommand(h.env,{agent,rawInput,commandId,signal:new AbortController().signal});agent.session.append('command/done',{commandId,kind:result.kind});assert.equal(result.kind,'success',result.text);return JSON.parse(result.text)}
 const paused=await run({object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'direct user pause',requestId:'direct-task-user-pause'})
 assert.equal(paused.state,'paused');assert.equal(h.approvals.length,1)
 const late=await h.run('send',{targets:['B'],content:'late task work must not revive it',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 assert.equal(late.results[0].admission,'rejected')
 await run({object:'communication',action:'revoke',handle:h.communicationHandle,requestId:'direct-task-user-revoke'})
 const resumed=await run({object:'task',action:'resume',taskId:task.id,expectedRevision:1,reason:'explicitly resume selected remaining work',requestId:'direct-task-user-recovery'})
 assert.equal(resumed.state,'active');assert.notEqual(resumed.communicationHandle,h.communicationHandle);assert.equal(h.approvals.length,1,'verified user click covers only this exact task recovery')
 assert.equal(resumed.controlHandle,undefined,'recovery does not revive or create a recurring control grant')
 assert.equal((await h.run('status',{taskId:expanded.id})).recoveryRequired,true,'other task communication remains revoked')
})

test('task result durability failure retains the observed state while reporting unknown without replay',async()=>{
 const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'unknown-result-task'})
 const input={object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'pause shipping',requestId:'unknown-task-pause-result'}
 h.setFlush(async session=>!session.snapshotEvents().map(pluginRecordOf).some(record=>record?.type==='plugin:dsh-session-coordinator/control'&&record.data.requestId===input.requestId&&record.data.stage==='result'))
 const result=await h.run('control',input),approvals=h.approvals.length
 assert.equal(result.outcome,'unknown');assert.equal(result.state,'paused')
 assert.deepEqual(await h.run('control',input),result);assert.equal(h.approvals.length,approvals)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'paused')
})


test('optional tasks bind existing work permission and persist in the shared task store',async()=>{
  const h=await tasksFixture(),input={communicationHandle:h.communicationHandle,objective:'shipping calculation',members:['B'],requestId:'declare-shipping-01'}
  assert.ok(h.tools.has('session_coordinator_task'),'optional task tool is registered')
  const task=await h.run('task',input)
  assert.equal(task.revision,1);assert.equal(task.state,'active');assert.equal(typeof task.taskHandle,'string')
  assert.deepEqual(await h.run('task',input),task)
  assert.equal(h.approvals.length,1,'declaration narrows an existing permission; it does not expand it')
  assert.equal([...h.records.values()].flatMap(record=>Object.values(record.data.tasks)).length,1)
  await assert.rejects(h.run('task',{...input,objective:'changed objective'}),/request|identity|belongs/)
  await assert.rejects(h.run('task',{...input,requestId:'declare-outside-01',members:['C']}),/member|scope|permission/)
  await assert.rejects(h.run('task',{...input,communicationHandle:'forged-permission',requestId:'declare-forged-01'}),/permission|authorization/)
})

test('unified send binds task revision and pause blocks only that task without revoking work',async()=>{
  const h=await tasksFixture()
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'task-shipping-01'})
  const other=await h.run('task',{communicationHandle:h.communicationHandle,objective:'product',members:['B'],requestId:'task-product-001'})
  const send=(taskHandle,requestId)=>h.run('send',{targets:['B'],content:'  calculate exact input\n',requestId,context:{communicationHandle:h.communicationHandle,taskHandle}})
  const sent=await send(task.taskHandle,'shipping-send-01')
  assert.equal(sent.results[0].admission,'accepted',JSON.stringify(sent))
  const message=h.effects.find(e=>e[0]==='send'&&e[2].id===sent.results[0].messageId)[2]
  assert.equal(message.source.taskId,task.id);assert.equal(message.source.taskRevision,1)
  const paused=await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'user paused shipping',requestId:'pause-shipping-01'})
  assert.equal(paused.state,'paused');assert.notEqual(paused.workStopped,true)
  assert.equal((await send(task.taskHandle,'paused-send-0001')).results[0].admission,'rejected')
  assert.equal((await send(other.taskHandle,'product-send-001')).results[0].admission,'accepted')
  const status=await h.run('status',{taskHandle:task.taskHandle})
  assert.equal(status.state,'paused')
})

test('task revision, cancellation and late reply cannot escape via ordinary work send',async()=>{
  const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'revision-shipping-01'})
  const send=(taskHandle,requestId,who='A',target='B')=>h.run('send',{targets:[target],content:'task evidence',requestId,context:{communicationHandle:h.communicationHandle,...(taskHandle?{taskHandle}:{})}},who)
  const sent=await send(task.taskHandle,'revision-send-01')
  assert.equal(sent.results[0].admission,'accepted',JSON.stringify(sent))
  const revised=await h.run('control',{object:'task',action:'revise',taskHandle:task.taskHandle,expectedRevision:1,objective:'shipping adjusted',reason:'user corrected shipping',requestId:'revise-shipping-01'})
  assert.equal(revised.revision,2);assert.notEqual(revised.taskHandle,task.taskHandle)
  assert.equal((await send(task.taskHandle,'stale-revision-01')).results[0].admission,'rejected')
  assert.equal((await send(revised.taskHandle,'current-revision-01')).results[0].admission,'accepted')
  const cancelled=await h.run('control',{object:'task',action:'cancel',taskHandle:revised.taskHandle,expectedRevision:2,reason:'stop shipping',requestId:'cancel-shipping-01'})
  assert.equal(cancelled.state,'cancelled')
  assert.equal((await send(revised.taskHandle,'late-result-0001','B','A')).results[0].admission,'rejected')
  assert.equal((await send(undefined,'escape-task-0001','B','A')).results[0].admission,'rejected','dropping task context cannot escape cancellation')
  const refused=await h.run('control',{object:'task',action:'resume',taskHandle:revised.taskHandle,expectedRevision:2,reason:'resume cancelled',requestId:'resume-cancelled-01'})
  assert.equal(refused.outcome,'rejected');assert.match(refused.error.message,/terminal|cancelled/)
})

test('one cancelled task input cannot reply by omitting its task handle',async()=>{
  const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'cancel-one-task-01'})
  h.human('B')
  await h.run('send',{targets:['B'],content:'shipping',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
  await h.run('control',{object:'task',action:'cancel',taskHandle:task.taskHandle,expectedRevision:1,reason:'cancel shipping',requestId:'cancel-one-task-02'})
  const result=await h.run('send',{targets:['A'],content:'late result',context:{communicationHandle:h.communicationHandle}},'B')
  assert.equal(result.results[0].admission,'rejected',JSON.stringify(result))
})

test('task control request identity prevents duplicate approval and objective revision',async()=>{
  const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'idempotent-task-01'})
  const input={object:'task',action:'revise',taskHandle:task.taskHandle,expectedRevision:1,objective:'corrected shipping',reason:'user correction',requestId:'idempotent-revise-01'}
  const result=await h.run('control',input)
  assert.deepEqual(await h.run('control',input),result)
  assert.equal(h.approvals.length,2)
  await assert.rejects(h.run('control',{...input,objective:'another objective'}),/CONFLICT|identity|request/)
})

test('finish accepts a real current task reply without a separate result tool and late work stays rejected',async()=>{
  const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'finish-shipping-01'})
  h.human('B')
  const sent=await h.run('send',{targets:['B'],content:'calculate shipping',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
  const reply=await h.run('send',{targets:['A'],content:'verified shipping: 7',replyTo:sent.results[0].messageId,context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}},'B')
  assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply))
  const forged=await h.run('control',{object:'task',action:'finish',taskHandle:task.taskHandle,expectedRevision:1,reason:'trust my assertion',evidenceRefs:['invented-proof'],requestId:'finish-forged-001'})
  assert.equal(forged.outcome,'rejected')
  const finished=await h.run('control',{object:'task',action:'finish',taskHandle:task.taskHandle,expectedRevision:1,reason:'verified actual reply',evidenceRefs:[reply.results[0].messageId],requestId:'finish-real-0001'})
  assert.equal(finished.state,'completed',JSON.stringify(finished))
  const late=await h.run('send',{targets:['A'],content:'late extra result',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}},'B')
  assert.equal(late.results[0].admission,'rejected')
  assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'completed')
})

test('known pre-submit failure remains a rejected task operation and can be inspected',async()=>{
  const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'failed-task-0001'})
  h.setFlush(async session=>{if(session.id==='A' && session.snapshotEvents().some(event=>pluginRecordOf(event)?.data?.stage==='intent' && pluginRecordOf(event)?.data?.text==='shipping'))throw Error('pre-submit failure');return true})
  h.agents.get('B').status='idle'
  const sent=await h.run('send',{targets:['B'],content:'shipping',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle},requestId:'failed-task-send-01'})
  assert.equal(sent.results[0].admission,'rejected')
  const status=await h.run('status',{taskHandle:task.taskHandle})
  assert.equal(status.operations.filter(op=>op.status==='prepared').length,0)
})

test('cancel reaches a source-proven job terminal state and retains other pending work',async()=>{
  const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'job-shipping-001'})
  const b=h.agents.get('B');b.session.append('turn/start',{turn:1})
  b.cancel=(_cause,options)=>{assert.equal(options.keepInbox,true);b.session.append('turn/end',{turn:1,reason:{kind:'aborted',cause:{kind:'hook',reason:'cancel task'}}});b.status='idle'}
  const sent=await h.run('send',{targets:['B'],content:'shipping compute',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
  assert.equal(sent.results[0].admission,'accepted',JSON.stringify(sent))
  b.status='running'
  const request=markAgentLoopRequest({sessionId:'B',messages:[h.effects.find(e=>e[0]==='send'&&e[2].id===sent.results[0].messageId)[2]],signal:new AbortController().signal})
  let stream=async function*(){};for(const fn of [...h.listeners.get('llm/stream')??[]].reverse()){const next=stream;stream=()=>fn(request,next)}for await(const _ of stream()){}
  const jobs=new Map([['shipping-job',{id:'shipping-job',owner:'B',startedAt:1,status:'running'}]]),killed=[]
  const service={list:owner=>[...jobs.values()].filter(job=>job.owner===owner),get:(id,owner)=>{assert.equal(jobs.get(id).owner,owner);return {...jobs.get(id)}},kill:(id,owner)=>{assert.equal(owner,'B');killed.push(id);jobs.get(id).status='stopping';return 'requested'},wait:async(id,_timeout,owner)=>{assert.equal(owner,'B');jobs.get(id).status='killed';b.session.append('job/settled',{jobId:id,owner:'B',startedAt:1,status:'killed',producerReported:true,cause:'kill',finishedAt:Date.now()});return {...jobs.get(id)}}}
  const get=h.ctx.get;h.ctx.get=name=>name==='jobs'?service:get(name)
  b.session.append('tool/call',{turn:1,step:0,callId:'shipping-call',name:'bash',arguments:{command:'shipping worker'}})
  b.session.append('job/registered',{jobId:'shipping-job',owner:'B',kind:'bash',label:'shipping',startedAt:1,toolCall:{callId:'shipping-call',rootCallId:'shipping-call'}})
  const cancelled=await h.run('control',{object:'task',action:'cancel',taskHandle:task.taskHandle,expectedRevision:1,reason:'stop shipping',requestId:'job-cancel-shipping-01'})
  assert.equal(cancelled.state,'cancelled',JSON.stringify(cancelled))
  assert.deepEqual(killed,['shipping-job'])
  assert.equal(cancelled.jobOutcomes[0].status,'killed')
  assert.equal(cancelled.jobOutcomes[0].outcome,'requested')
  assert.equal(cancelled.executionOutcomes[0].executionStopped,true)
  assert.equal(cancelled.workStopped,true)
})

test('self cancellation completes already-authorized job cleanup after aborting its own execution signal',async()=>{
 const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'self-task-0001'})
 h.human('B')
 const sent=await h.run('send',{targets:['B'],content:'review shipping',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 const a=h.agents.get('A');a.session.append('turn/start',{turn:1})
 const reply=await h.run('send',{targets:['A'],content:'calculate final shipping',replyTo:sent.results[0].messageId,context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}},'B')
 assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply))
 const message=h.effects.find(e=>e[0]==='send'&&e[2].id===reply.results[0].messageId)[2],abort=new AbortController()
 const request=markAgentLoopRequest({sessionId:'A',messages:[message],signal:abort.signal})
 let stream=async function*(){};for(const fn of [...h.listeners.get('llm/stream')??[]].reverse()){const next=stream;stream=()=>fn(request,next)}for await(const _ of stream()){}
 a.status='running';a.cancel=()=>{abort.abort(new Error('own task stopped'));a.session.append('turn/end',{turn:1,reason:{kind:'aborted',cause:{kind:'hook',reason:'own stop'}}});a.status='idle'}
 a.session.append('tool/call',{turn:1,step:0,callId:'self-job-call',name:'bash',arguments:{}})
 a.session.append('job/registered',{jobId:'self-job',owner:'A',toolCall:{callId:'self-job-call'},kind:'bash',label:'self job',startedAt:1})
 let state='running',kills=0;const get=h.ctx.get
 h.ctx.get=name=>name==='jobs'?{list:owner=>owner==='A'?[{id:'self-job',owner:'A',startedAt:1,status:state}]:[],get:()=>({id:'self-job',owner:'A',startedAt:1,status:state}),kill(){assert.equal(abort.signal.aborted,true);kills++;state='stopping';return 'requested'},async wait(_id,_timeout,_owner,signal){assert.equal(signal.aborted,false);state='killed';a.session.append('job/settled',{jobId:'self-job',owner:'A',startedAt:1,status:state,producerReported:true});return {id:'self-job',owner:'A',startedAt:1,status:state}}}:get(name)
 const result=await h.run('control',{object:'task',action:'cancel',taskHandle:task.taskHandle,expectedRevision:1,reason:'cancel this work including my own job',requestId:'self-control-cancel-01'},'A',{signal:abort.signal})
 assert.equal(abort.signal.aborted,true);assert.equal(kills,1);assert.equal(result.workStopped,true,JSON.stringify(result))
})

test('editing a queued task message preserves its task identity at the real pre-step consumer',async()=>{
 const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'edit-task-00001'}),b=h.agents.get('B')
 b.followup=message=>b.inbox.nextTurn.push(message)
 b.inbox.replace=(id,message)=>{const index=b.inbox.nextTurn.findIndex(x=>x.id===id);if(index<0)return false;b.inbox.nextTurn[index]=message;return true}
 const sent=await h.run('send',{targets:['B'],content:'old shipping',delivery:'queue',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 const edited=await h.run('control',{object:'message',action:'edit',messageId:sent.results[0].messageId,expectedRevision:1,content:'corrected shipping',requestId:'edit-task-control-01'})
 assert.equal(edited.outcome,'edited')
 const message=b.inbox.nextTurn.shift();b.session.append('turn/start',{turn:1})
 for(const fn of h.listeners.get('agent/inbox/claimed')??[])fn({agent:b,message,turn:1})
 const payload={agent:b,turn:1,step:0,signal:new AbortController().signal,messages:[message]}
 const decision=await (h.listeners.get('agent/pre-step')??[]).reduceRight((next,fn)=>()=>fn(payload,next),async()=>({kind:'enter',messages:[message]}))()
 assert.deepEqual(decision.messages,[message])
})

test('task wait keeps completed and cancelled states distinct and wait cancellation does not stop work',async()=>{
 const h=await tasksFixture(),product=await h.run('task',{communicationHandle:h.communicationHandle,objective:'product',members:['B'],requestId:'wait-product-001'}),shipping=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'wait-shipping-01'})
 h.human('B')
 const sent=await h.run('send',{targets:['B'],content:'product check',context:{communicationHandle:h.communicationHandle,taskHandle:product.taskHandle}})
 const reply=await h.run('send',{targets:['A'],content:'product verified',replyTo:sent.results[0].messageId,context:{communicationHandle:h.communicationHandle,taskHandle:product.taskHandle}},'B')
 await h.run('control',{object:'task',action:'finish',taskHandle:product.taskHandle,expectedRevision:1,reason:'verified product',evidenceRefs:[reply.results[0].messageId],requestId:'wait-finish-product'})
 await h.run('control',{object:'task',action:'cancel',taskHandle:shipping.taskHandle,expectedRevision:1,reason:'cancel shipping',requestId:'wait-cancel-shipping'})
 const waited=await h.run('wait',{taskHandles:[product.taskHandle,shipping.taskHandle],mode:'all',timeoutMs:0})
 assert.equal(waited.done,true);assert.equal(waited.allSucceeded,false);assert.deepEqual(waited.tasks.map(task=>task.state).sort(),['cancelled','completed'])
 const active=await h.run('task',{communicationHandle:h.communicationHandle,objective:'new independent work',members:['B'],requestId:'wait-active-0001'}),stop=new AbortController()
 const waiting=h.run('wait',{taskHandles:[active.taskHandle],mode:'all',timeoutMs:1000},'A',{signal:stop.signal});queueMicrotask(()=>stop.abort(new Error('cancel wait only')))
 assert.equal((await waiting).aborted,true)
 assert.equal((await h.run('status',{taskHandle:active.taskHandle})).state,'active')
 await assert.rejects(h.run('wait',{taskHandles:[active.taskHandle],targets:[],mode:'all',timeoutMs:0}),/mix|exclusive/)
})

test('communication revocation also closes compatibility sends for the same bound task scope',async()=>{
 const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'revoke-task-0001'})
 const scope=[...h.records.values()].find(record=>record.data.tasks[task.id]).data
 await h.run('control',{object:'communication',action:'revoke',handle:h.communicationHandle,requestId:'revoke-task-scope-01'})
 await assert.rejects(h.run('collaboration_send',{scopeId:scope.id,taskId:task.id,taskRevision:1,sessionId:'B',message:'do not bypass revoked permission',intent:'task'}),/Legacy compatibility is unavailable/)
})

test('another member needs an explicit independent task-control approval',async()=>{
 const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'member-task-0001'})
 h.human('B');h.setAnswer(async()=> 'rejected')
 const before=h.approvals.length,input={object:'task',action:'cancel',taskHandle:task.taskHandle,expectedRevision:1,reason:'user requested cancellation from this chat',requestId:'member-task-control-01'}
 const refused=await h.run('control',input,'B');assert.equal(refused.outcome,'rejected');assert.equal(h.approvals.length,before+1)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'active')
 h.human('B');h.setAnswer(async()=> 'allowed-once')
 const granted=await h.run('control',input,'B');assert.equal(granted.state,'cancelled',JSON.stringify(granted))
})

test('send request identity freezes the declared task and exact revision',async()=>{
 const h=await tasksFixture(),declare=(objective,requestId)=>h.run('task',{communicationHandle:h.communicationHandle,objective,members:['B'],requestId})
 const first=await declare('shipping','fingerprint-task-one'),other=await declare('product','fingerprint-task-two')
 const args={requestId:'fingerprint-send-task',targets:['B'],content:'same business message',context:{communicationHandle:h.communicationHandle,taskHandle:first.taskHandle}}
 const accepted=await h.run('send',args);assert.equal(accepted.results[0].admission,'accepted')
 await assert.rejects(h.run('send',{...args,context:{...args.context,taskHandle:other.taskHandle}}),/REQUEST_CONFLICT/)
 const revised=await h.run('control',{object:'task',action:'revise',taskHandle:first.taskHandle,expectedRevision:1,objective:'revised shipping',reason:'user changed scope',requestId:'fingerprint-revise-task'})
 await assert.rejects(h.run('send',{...args,context:{...args.context,taskHandle:revised.taskHandle}}),/REQUEST_CONFLICT/)
 assert.deepEqual(await h.run('send',args),accepted,'original retry preserves its actual historical admission')
 assert.equal(h.effects.filter(row=>row[0]==='send'&&row[2].id===accepted.results[0].messageId).length,1)
})

test('once-reply conclusion consults the actual shared task runtime and its lifecycle',async()=>{
 for(const scenario of ['clear','ready-other','waiting-other','paused-other','finished-other','runtime-closed']) {
  const h=await tasksFixture(),b=h.agents.get('B'),runtime=await h.env.collaboration
  if(scenario.endsWith('-other')) {
   const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'another independent calculation',members:['B'],requestId:'g5-other-task'})
   if(scenario==='waiting-other'||scenario==='finished-other') {
    const sent=await h.run('send',{targets:['B'],content:'calculate other task',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
    if(scenario==='finished-other') {
     const reply=await h.run('send',{targets:['A'],content:'other result',replyTo:sent.results[0].messageId,context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}},'B')
     const finish=await h.run('control',{object:'task',action:'finish',taskHandle:task.taskHandle,expectedRevision:1,reason:'accepted actual other evidence',evidenceRefs:[reply.results[0].messageId],requestId:'g5-finish-other'})
     assert.equal(finish.state,'completed')
    }
   }
   if(scenario==='paused-other')await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'wait for user review',requestId:'g5-pause-other'})
  }
  if(scenario==='runtime-closed'){const closing=runtime.close();assert.equal(h.env.delivery.taskActivity(b).unknown,true,'closing revokes task activity proof before async cleanup settles');await closing}
  b.session.append('turn/start',{turn:1});b.ctx.get=name=>name==='jobs'?{list:()=>[]}:undefined
  const first=await h.run('send',{targets:['B'],content:'one independent report',authorizationRequest:{extent:'message',participants:['A','B'],purpose:'one report',reply:'once'}})
  b.session.append('step/start',{turn:1,step:1})
  b.session.append('assistant/message',{turn:1,step:1,message:{id:'task-g5-plan',role:'assistant',content:[{type:'tool-call',id:'task-g5-reply',name:'session_coordinator_send',arguments:'{}'}]}},{surfaceOp:'append'})
  b.session.append('tool/call',{turn:1,step:1,callId:'task-g5-reply',name:'session_coordinator_send',arguments:'{}'})
  const reply=await h.run('send',{targets:['A'],content:'one report result',replyTo:first.results[0].messageId},'B',{callId:'task-g5-reply'})
  assert.equal(reply.results[0].admission,'accepted',scenario+JSON.stringify(reply))
  assert.equal(h.effects.filter(effect=>effect[0]==='conclude').length,['clear','finished-other'].includes(scenario)?1:0,scenario)
  if(scenario!=='runtime-closed')await runtime.close()
 }
})

test('exact reply authority cannot fall back to ambient work on conflict, consumption or revocation',async()=>{
 const h=await tasksFixture(['A','B','C']),oldParent=h.effects.find(row=>row[0]==='send'&&row[1]==='B')[2].id
 const once=await h.run('send',{targets:['B'],content:'one separate report',authorizationRequest:{extent:'message',participants:['A','B'],purpose:'separate report',reply:'once'}})
 const reply={targets:['A'],content:'one report',replyTo:once.results[0].messageId}
 const conflict=await h.run('send',{...reply,context:{communicationHandle:h.communicationHandle}},'B')
 assert.equal(conflict.results[0].admission,'rejected')
 assert.equal((await h.run('send',reply,'B')).results[0].admission,'accepted','exact once is narrower than ambient work')
 assert.equal((await h.run('send',{...reply,content:'second reply'},'B')).results[0].admission,'rejected')
 h.human('A')
 const otherParent=await h.run('send',{targets:['C'],content:'for C only',authorizationRequest:{extent:'message',participants:['A','C'],purpose:'C report',reply:'once'}})
 const mismatch=await h.run('send',{...reply,replyTo:otherParent.results[0].messageId},'B')
 assert.equal(mismatch.results[0].admission,'rejected')
 const second=await h.run('send',{targets:['B'],content:'independent new work',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'other business'}})
 assert.equal(second.results[0].admission,'accepted')
 const revoke=await h.run('control',{object:'communication',action:'revoke',handle:h.communicationHandle,requestId:'reply-old-work-revoke'})
 assert.equal(revoke.outcome,'revoked')
 const count=h.effects.filter(row=>row[0]==='send').length,approvals=h.approvals.length
 const refused=await h.run('send',{...reply,replyTo:oldParent},'B')
 assert.equal(refused.results[0].admission,'rejected')
 assert.match(refused.results[0].error.message,/revoked|unavailable/)
 assert.equal(h.effects.filter(row=>row[0]==='send').length,count)
 assert.equal(h.approvals.length,approvals,'invalid parent does not trigger a broader permission request')
})


test('paused task cannot block a verified independent ordinary reply or permit dropping task context',async()=>{
 const h=await tasksFixture(['A','B','C']),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'separate-shipping-task'})
 const first=await h.run('send',{targets:['B'],content:'calculate shipping',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'pause shipping',requestId:'separate-shipping-pause'})
 const other=await h.run('send',{targets:['B'],content:'separate product validation',context:{communicationHandle:h.communicationHandle}},'C')
 assert.equal(other.results[0].admission,'accepted')
 const reply={targets:['C'],content:'product confirmed',context:{communicationHandle:h.communicationHandle}}
 for(const input of [reply,{...reply,replyTo:'forged-parent'},{...reply,targets:['A'],replyTo:first.results[0].messageId}])assert.equal((await h.run('send',input,'B')).results[0].admission,'rejected')
 assert.equal((await h.run('send',{...reply,replyTo:other.results[0].messageId},'B')).results[0].admission,'accepted')
 await (await h.env.collaboration).close()
})

test('owner task control retains expected revision across a queued concurrent revision',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'race-shipping-task'})
 let release,entered
 const gate=new Promise(resolve=>release=resolve),start=new Promise(resolve=>entered=resolve),update=runtime.store.update.bind(runtime.store)
 let first=true
 runtime.store.update=async(...args)=>{if(first){first=false;entered();await gate}return update(...args)}
 const revised=h.run('control',{object:'task',action:'revise',taskHandle:task.taskHandle,expectedRevision:1,objective:'new shipping',reason:'new objective',requestId:'race-shipping-revise'})
 await start
 const stale=h.run('control',{object:'task',action:'block',taskHandle:task.taskHandle,expectedRevision:1,reason:'old blocker',requestId:'race-shipping-block'})
 await new Promise(resolve=>setImmediate(resolve));release()
 const [current,result]=await Promise.all([revised,stale])
 assert.equal(current.revision,2);assert.notEqual(result.outcome,'applied')
 assert.equal((await h.run('status',{taskHandle:current.taskHandle})).state,'active')
 await runtime.close()
})


test('paused reply rejected before submission may retry the same identity after explicit resume',async()=>{
 const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'paused-retry-task'})
 const original=await h.run('send',{targets:['B'],content:'calculate shipping',requestId:'paused-retry-first',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 const control={object:'task',taskHandle:task.taskHandle,expectedRevision:1,reason:'user control'}
 await h.run('control',{...control,action:'pause',requestId:'paused-retry-pause'})
 const reply={targets:['A'],content:'shipping result',replyTo:original.results[0].messageId,requestId:'paused-retry-reply',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}}
 const count=h.effects.filter(row=>row[0]==='send').length
 assert.equal((await h.run('send',reply,'B')).results[0].admission,'rejected')
 assert.equal(h.effects.filter(row=>row[0]==='send').length,count)
 assert.equal((await h.run('control',{...control,action:'resume',requestId:'paused-retry-resume'})).state,'active')
 const result=await h.run('send',reply,'B');assert.equal(result.results[0].admission,'accepted')
 assert.deepEqual(await h.run('send',reply,'B'),result)
 assert.equal(h.effects.filter(row=>row[0]==='send').length,count+1)
 await (await h.env.collaboration).close()
})
