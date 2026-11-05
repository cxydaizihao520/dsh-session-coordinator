// Installed LocalJobRegistry with scratch Sessions and controlled producers; no business process.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context,Service} from 'cordis'
import {markAgentLoopRequest,LlmError,errorChain,createUserMessage} from '@deepseek-ai/dsh-llm'
import {z} from 'zod'
import {ToolCallRecovery,SessionStore} from '@deepseek-ai/dsh-session'
import {tasksFixture} from './fixtures/session-tasks.mjs'
import {exportDiagnostics} from '../src/diagnostics.ts'
const require=createRequire(import.meta.url),urls=new Map()
function nativeUrl(name){if(urls.has(name))return urls.get(name);let source=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/'+name+'/lib/index.js'],{encoding:'utf8'});source=source.replace(/from "([^"]+)"/g,(_,id)=>{let resolved;try{resolved=require.resolve(id==='@deepseek-ai/cordis'?'cordis':id)}catch{resolved=nativeUrl(id)}return 'from '+JSON.stringify(resolved.startsWith('/')?pathToFileURL(resolved).href:resolved)});const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');urls.set(name,url);return url}
const {LocalJobRegistry}=await import(nativeUrl('@deepseek-ai/dsh-jobs-local'))
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function prepared(){
 const h=await tasksFixture(['A','B','C']),root=new Context()
 new(class extends Service{constructor(c){super(c,'agents')}get(id){return h.agents.get(id)}})(root)
 const jobs=new LocalJobRegistry(root,{maxConcurrentJobsPerOwner:8,retainBytes:4096,settledRetainBytes:4096,pumpPollMs:20});jobs.attachController('session-task-test')
 const get=h.ctx.get;h.ctx.get=name=>name==='jobs'?jobs:get(name)
 for(const agent of h.agents.values())agent.ctx=root
 return {...h,root,jobs}
}
async function enter(h,owner,objective,suffix=''){
 const task=await h.run('task',{communicationHandle:h.communicationHandle,objective,members:[owner],requestId:'host-task-'+owner+suffix}),agent=h.agents.get(owner)
 const turn=agent.session.snapshotEvents().filter(e=>e.type==='turn/start').at(-1).data.turn+1
 agent.status='idle';agent.session.append('turn/start',{turn})
 const sent=await h.run('send',{targets:[owner],content:objective,context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 assert.equal(sent.results[0].admission,'accepted',JSON.stringify(sent))
 agent.status='running';agent.cancel=()=>{agent.session.append('turn/end',{turn,reason:{kind:'aborted',cause:{kind:'hook',reason:'approved cancellation'}}});agent.status='idle'}
 const message=h.effects.find(e=>e[0]==='send'&&e[2].id===sent.results[0].messageId)[2]
 const request=markAgentLoopRequest({sessionId:owner,messages:[message],signal:new AbortController().signal})
 let stream=async function*(){};for(const fn of [...h.listeners.get('llm/stream')??[]].reverse()){const next=stream;stream=()=>fn(request,next)}for await(const _ of stream()){}
 agent.session.append('tool/call',{turn,step:0,callId:'host-call-'+owner+suffix,name:'bash',arguments:{command:objective}})
 return {task,agent,messageId:sent.results[0].messageId,toolCall:{callId:'host-call-'+owner+suffix,rootCallId:'host-call-'+owner+suffix}}
}
for(const scenario of ['producer-confirmed','producer-rejected','cancel-throws'])test('native task job stopping preserves producer evidence: '+scenario,async()=>{
 const h=await prepared();let productTimer,shippingTimer
 try{
  const shipping=await enter(h,'B','shipping'),product=await enter(h,'C','product')
  let shippingSamples=0,productSamples=0,resolveShipping,rejectShipping,resolveProduct
  const shippingDone=new Promise((resolve,reject)=>{resolveShipping=resolve;rejectShipping=reject}),productDone=new Promise(resolve=>resolveProduct=resolve)
  const shippingId=h.jobs.start({owner:'B',kind:'probe',label:'shipping',toolCall:shipping.toolCall,run(){shippingTimer=setInterval(()=>shippingSamples++,5);return {done:shippingDone,cancel(){if(scenario==='cancel-throws')throw Error('producer stop failed');clearInterval(shippingTimer);resolveShipping({status:'killed'})}}}})
  const productId=h.jobs.start({owner:'C',kind:'probe',label:'product',toolCall:product.toolCall,run(){productTimer=setInterval(()=>productSamples++,5);return {done:productDone,cancel(){clearInterval(productTimer);resolveProduct({status:'killed'})}}}})
  let collectedBeforeKill=false
  const wait=h.jobs.wait.bind(h.jobs),kill=h.jobs.kill.bind(h.jobs)
  h.jobs.wait=(id,...args)=>{if(id===shippingId)collectedBeforeKill=true;return wait(id,...args)}
  h.jobs.kill=(id,...args)=>{if(id===shippingId)assert.equal(collectedBeforeKill,true,'collect native completion before kill so stopping cannot wake the owner');return kill(id,...args)}
  await delay(20);assert.ok(shippingSamples>=2);assert.ok(productSamples>=2)
  if(scenario==='producer-rejected'){rejectShipping(Error('producer contract broken'));await h.jobs.wait(shippingId,200,'B')}
  const result=await h.run('control',{object:'task',action:'cancel',taskHandle:shipping.task.taskHandle,expectedRevision:1,reason:'cancel shipping only',requestId:'host-cancel-'+scenario})
  assert.equal(result.state,'cancelled',JSON.stringify(result));const row=result.jobOutcomes.find(row=>row.jobId===shippingId);assert.ok(row,JSON.stringify(result))
  const dump=await exportDiagnostics(h.ctx,'A'),records=dump.sessions[0].records.filter(item=>item.requestId===result.requestId)
  const control=records.findLast(item=>item.stage==='returned'),job=records.findLast(item=>item.stage==='control-job'&&item.jobId===shippingId)
  assert.equal(control.object,'task');assert.equal(control.taskHandle,shipping.task.taskHandle);assert.equal(control.workStopped,result.workStopped)
  assert.equal(job.jobState,row.status);assert.equal(job.stopped,row.stopped);assert.equal(job.producerReported,row.producerReported)
  assert.equal(records.findLast(item=>item.stage==='control-execution').executionStopped,result.executionOutcomes[0].executionStopped)
  assert.ok(records.every(item=>!('label' in item)&&!('command' in item)&&!('objective' in item)))
  assert.equal(h.jobs.get(productId,'C').status,'running');const p=productSamples,s=shippingSamples;await delay(15);assert.ok(productSamples>p)
  if(scenario==='producer-confirmed'){assert.equal(row.status,'killed');assert.equal(row.producerReported,true);assert.equal(row.stopped,true);assert.equal(result.workStopped,true);assert.equal(shippingSamples,s)}
  else {assert.notEqual(result.workStopped,true);assert.notEqual(row.stopped,true);if(scenario==='producer-rejected'){assert.equal(row.status,'failed');assert.equal(row.producerReported,false);assert.ok(shippingSamples>s)}}
 }finally{clearInterval(productTimer);clearInterval(shippingTimer);await h.root.fiber.dispose()}
})

test('another previously admitted ready task prevents guessing a new job belongs to the latest input',async()=>{
 const h=await prepared();let doneResolve,kills=0
 try{
  const old=await enter(h,'B','older product task','-old')
  h.agents.get('B').status='idle'
  const reply=await h.run('send',{targets:['A'],content:'product evidence ready for review',replyTo:old.messageId,context:{communicationHandle:h.communicationHandle,taskHandle:old.task.taskHandle}},'B')
  assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply))
  assert.equal((await h.run('status',{taskHandle:old.task.taskHandle})).scheduling,'ready')
  const recent=await enter(h,'B','new shipping input','-new')
  const job=h.jobs.start({owner:'B',kind:'probe',label:'could continue prior ready task',toolCall:recent.toolCall,run(){return {done:new Promise(resolve=>doneResolve=resolve),cancel(){kills++;doneResolve({status:'killed'})}}}})
  const result=await h.run('control',{object:'task',action:'cancel',taskHandle:recent.task.taskHandle,expectedRevision:1,reason:'cancel shipping',requestId:'cancel-latest-input-01'})
  assert.equal(kills,0,'latest native input does not prove the business scope of this tool')
  assert.equal(h.jobs.get(job,'B').status,'running');assert.notEqual(result.workStopped,true)
 }finally{doneResolve?.({status:'completed'});await h.root.fiber.dispose()}
})

for(const scenario of ['ownerless','missing-call','stop-timeout','owner-replaced','completed-before-approval'])test('native job safety boundary: '+scenario,async()=>{
 const h=await prepared();let doneResolve,kills=0
 try{
  const work=await enter(h,'B','shipping')
  const id=h.jobs.start({...(scenario==='ownerless'?{}:{owner:'B'}),kind:'probe',label:scenario,...(scenario==='missing-call'?{}:{toolCall:work.toolCall}),run(){return {done:new Promise(resolve=>doneResolve=resolve),cancel(){kills++;if(scenario!=='stop-timeout')doneResolve({status:'killed'})}}}})
  if(scenario==='owner-replaced')h.agents.set('B',{...work.agent})
  if(scenario==='completed-before-approval')h.setAnswer(async()=>{doneResolve({status:'completed'});await h.jobs.wait(id,200,'B');return 'allowed-once'})
  const result=await h.run('control',{object:'task',action:'cancel',taskHandle:work.task.taskHandle,expectedRevision:1,reason:'stop shipping',requestId:'boundary-'+scenario})
  assert.equal(result.state,'cancelled',JSON.stringify(result))
  const row=result.jobOutcomes.find(row=>row.jobId===id);assert.ok(row,JSON.stringify(result))
  if(scenario==='stop-timeout'){assert.equal(kills,1);assert.equal(row.status,'stopping');assert.notEqual(result.workStopped,true)}
  else if(scenario==='completed-before-approval'){assert.equal(kills,0);assert.equal(row.status,'completed');assert.equal(row.outcome,'not_requested');assert.equal(row.producerReported,true)}
  else {assert.equal(kills,0);assert.equal(row.outcome,'unattributed');assert.notEqual(result.workStopped,true)}
 }finally{doneResolve?.({status:'completed'});await h.root.fiber.dispose()}
})

test('native self-cancel stops the producer before native turn/end confirms execution completion',async()=>{
 const h=await prepared();let resolveDone
 try{
  const source=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'],{encoding:'utf8'})
  const method=(first,last,keys=[],values=[])=>{const start=source.indexOf(first),end=source.indexOf(last,start);assert.ok(start>=0&&end>start);return new Function(...keys,'return '+source.slice(start,end).trim().replace(/^(async )?\w+\(/,(_m,async='')=>async+'function('))(...values)}
  const nativeCancel=method('\tcancel(cause, options = {}) {','\n\trunMaintenance(')
  const causeStart=source.indexOf('function abortedCancelCause('),causeEnd=source.indexOf('\n/** Drives',causeStart)
  const cause=new Function('assertNever',source.slice(causeStart,causeEnd)+'\nreturn abortedCancelCause')(x=>{throw Error('unexpected cause '+JSON.stringify(x))})
  const turn=method('\tasync turn() {','\n\tasync step(',['ToolCallRecovery','abortedCancelCause','LlmError','errorChain'],[ToolCallRecovery,cause,LlmError,errorChain])
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'self owned result processing',members:['B'],requestId:'native-self-task-001'}),a=h.agents.get('A')
  h.human('B')
  const sent=await h.run('send',{targets:['B'],content:'review',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
  a.followup=message=>a.inbox.nextTurn.push(message)
  const reply=await h.run('send',{targets:['A'],content:'review result',replyTo:sent.results[0].messageId,delivery:'queue',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}},'B')
  assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply))
  const abort=new AbortController();a.phase={kind:'running',turn:0,step:0,abort,wakeRequested:false};a.status='running';a.cancel=nativeCancel;a.throwError=error=>{throw error};a.dispatch={serial:async()=>{}}
  a.preStep=async(_timing,{turn,step})=>{const messages=a.inbox.nextTurn.splice(0);for(const message of messages)for(const fn of h.listeners.get('agent/inbox/claimed')??[])fn({agent:a,message,turn});const payload={agent:a,turn,step,signal:abort.signal,messages};return (h.listeners.get('agent/pre-step')??[]).reduceRight((next,fn)=>()=>fn(payload,next),async()=>({kind:'enter',messages}))()}
  let controlResult,jobId
  a.step=async decision=>{
   for(const message of decision.messages)a.session.append('user/message',message,{surfaceOp:'append'})
   const request=markAgentLoopRequest({sessionId:'A',messages:decision.messages,signal:abort.signal})
   let stream=async function*(){};for(const fn of [...h.listeners.get('llm/stream')??[]].reverse()){const next=stream;stream=()=>fn(request,next)}for await(const _ of stream()){}
   a.session.append('tool/call',{turn:1,step:1,callId:'native-self-job',name:'bash',arguments:{}})
   jobId=h.jobs.start({owner:'A',kind:'probe',label:'self work',toolCall:{callId:'native-self-job'},run(){return {done:new Promise(resolve=>resolveDone=resolve),cancel(){assert.equal(abort.signal.aborted,true);resolveDone({status:'killed'})}}}})
   a.inbox.nextTurn.push({id:'unrelated-next',role:'user',source:{kind:'user'},content:[{type:'text',text:'keep next work'}]})
   controlResult=await h.run('control',{object:'task',action:'cancel',taskHandle:task.taskHandle,expectedRevision:1,reason:'stop current work and its producer',requestId:'native-self-control-01'},'A',{signal:abort.signal})
   assert.equal(h.jobs.get(jobId,'A').status,'killed');assert.notEqual(controlResult.workStopped,true)
   abort.signal.throwIfAborted()
  }
  await assert.rejects(turn.call(a),cause=>cause.kind==='hook')
  assert.equal(a.inbox.nextTurn[0].id,'unrelated-next')
  const ended=a.session.snapshotEvents().findLast(event=>event.type==='turn/end');assert.equal(ended.data.reason.kind,'aborted')
  a.status='idle'
  const status=await h.run('status',{taskHandle:task.taskHandle});assert.equal(status.workStopped,true,JSON.stringify(status))
  assert.equal(status.executionOutcomes[0].executionStopped,true)
 }finally{resolveDone?.({status:'completed'});await h.root.fiber.dispose()}
})

for(const scenario of ['attributed-job','unattributed-job'])test('cancel inspects both known native jobs worlds: '+scenario,async()=>{
 const h=await prepared(),other=new Context();let finish;
 try {
  new(class extends Service{constructor(c){super(c,'agents')}get(id){return h.agents.get(id)}})(other)
  const alternate=new LocalJobRegistry(other,{maxConcurrentJobsPerOwner:8,retainBytes:4096,settledRetainBytes:4096,pumpPollMs:20});alternate.attachController('alternate-jobs-world')
  const work=await enter(h,'B','shipping isolated world')
  const job=h.jobs.start({owner:'B',kind:'probe',label:'captured registration service',...(scenario==='attributed-job'?{toolCall:work.toolCall}:{}),run(){return {done:new Promise(resolve=>finish=resolve),cancel(){finish({status:'killed'})}}}})
  h.agents.get('B').ctx=other
  await delay(20)
  const result=await h.run('control',{object:'task',action:'cancel',taskHandle:work.task.taskHandle,expectedRevision:1,reason:'stop shipping',requestId:'two-world-'+scenario})
  const actual=h.jobs.get(job,'B').status
  if(scenario==='attributed-job')assert.equal(actual,'killed','known captured registry contains attributable job and supports stop')
  else assert.notEqual(result.workStopped,true,'unknown same-owner job in a known registry prevents full stopping claim')
 } finally {finish?.({status:'completed'});await h.root.fiber.dispose();await other.fiber.dispose()}
})

test('unclassified preexisting job in a captured registry is not proof of all task work stopped',async()=>{
 const h=await prepared(),other=new Context();let finish;
 try {
  new(class extends Service{constructor(c){super(c,'agents')}get(id){return h.agents.get(id)}})(other)
  const alternate=new LocalJobRegistry(other,{maxConcurrentJobsPerOwner:8,retainBytes:4096,settledRetainBytes:4096,pumpPollMs:20});alternate.attachController('alternate-jobs-world')
  const job=h.jobs.start({owner:'B',kind:'probe',label:'unclassified existing shipping work',run(){return {done:new Promise(resolve=>finish=resolve),cancel(){finish({status:'killed'})}}}})
  const work=await enter(h,'B','shipping isolated world')
  h.agents.get('B').ctx=other
  await delay(20)
  const result=await h.run('control',{object:'task',action:'cancel',taskHandle:work.task.taskHandle,expectedRevision:1,reason:'stop shipping',requestId:'two-world-unknown-existing'})
  assert.notEqual(result.workStopped,true)
 } finally {finish?.({status:'completed'});await h.root.fiber.dispose();await other.fiber.dispose()}
})

for(const conflict of [false,true])test('known jobs views deduplicate native identity or refuse conflict: '+conflict,async()=>{
 const h=await prepared();let finish,kills=0
 try {
  const work=await enter(h,'B','shipping proxy identity')
  const originalKill=h.jobs.kill.bind(h.jobs);h.jobs.kill=(...args)=>{kills++;return originalKill(...args)}
  const job=h.jobs.start({owner:'B',kind:'probe',label:'native identity',toolCall:work.toolCall,run(){return {done:new Promise(resolve=>finish=resolve),cancel(){finish({status:'killed'})}}}})
  work.agent.ctx=h.root.extend()
  if(conflict){const native=work.agent.ctx.get('jobs'),get=work.agent.ctx.get.bind(work.agent.ctx);work.agent.ctx.get=name=>name==='jobs'?{list:owner=>native.list(owner).map(view=>({...view,startedAt:view.startedAt+1})),get:native.get.bind(native)}:get(name)}
  await delay(20)
  const result=await h.run('control',{object:'task',action:'cancel',taskHandle:work.task.taskHandle,expectedRevision:1,reason:'stop exact shipping job',requestId:'proxy-identity-'+conflict})
  assert.equal(kills,conflict?0:1,'one native job is never stopped twice through service aliases')
  assert.equal(h.jobs.get(job,'B').status,conflict?'running':'killed')
  if(conflict)assert.notEqual(result.workStopped,true)
 } finally {finish?.({status:'completed'});await h.root.fiber.dispose()}
})

const loopSource=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'],{encoding:'utf8'})
const inboxStart=loopSource.indexOf('//#region lib/types/inbox.js'),inboxEnd=loopSource.indexOf('//#endregion',inboxStart)
const {ReactLoopInbox,inboxProjectionDefinition}=new Function('z$1',loopSource.slice(inboxStart,inboxEnd)+';return {ReactLoopInbox,inboxProjectionDefinition}')(z)
const turnStart=loopSource.indexOf('\tasync turn() {'),turnEnd=loopSource.indexOf('\n\tasync step(',turnStart)
const nativeTurn=new Function('ToolCallRecovery','LlmError','errorChain','abortedCancelCause','return '+loopSource.slice(turnStart,turnEnd).trim().replace('async turn()','async function()'))(ToolCallRecovery,LlmError,errorChain,()=>undefined)
const projectionStart=loopSource.indexOf('\tproject(current, sections) {'),projectionEnd=loopSource.indexOf('\n\t}\n};',projectionStart)+3
const projectContext=new Function('createUserMessage','SOURCE','CLEARED','return '+loopSource.slice(projectionStart,projectionEnd).trim().replace('project(current, sections)','function(current, sections)'))(createUserMessage,'runtime-context','cleared')
for(const scenario of ['normal','cancelled-only','cancelled-with-other','cancelled-existing-step'])test('native turn does not start empty model work after task cancellation: '+scenario,async()=>{
 const h=await prepared(),sessions=new SessionStore(h.root),session=sessions.prepare('B'),leave=sessions.enter(session);sessions.announce(session)
 try {
  const b=h.agents.get('B');b.session=session
  h.root.on('session/event',(s,e)=>{for(const fn of h.listeners.get('session/event')??[])fn(s,e)})
  b.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},session,{emit(name,payload){for(const fn of h.listeners.get(name)??[])fn({agent:b,...payload})}})
  b.followup=m=>b.inbox.append('next-turn',m);b.steer=m=>b.inbox.append('next-step',m)
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'prestep-task-'+scenario})
  const sendTask=()=>h.run('send',{targets:['B'],content:'shipping work',delivery:scenario==='cancelled-existing-step'?'message':'queue',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
  if(scenario!=='cancelled-existing-step'){const sent=await sendTask();assert.equal(sent.results[0].admission,'accepted')}
  if(scenario==='cancelled-with-other'||scenario==='cancelled-existing-step')b.inbox.append('next-step',{id:'other-human',role:'user',source:{kind:'user'},content:[{type:'text',text:'keep independent work'}]})
  const abort=new AbortController();b.phase={kind:'running',turn:0,step:0,abort,wakeRequested:false};b.status='running';b.dispatch={serial:async()=>{}};b.throwError=e=>{throw e}
  b.preStep=async(_timing,{turn,step})=>{
   const messages=b.inbox.claim(_timing,turn)
   if(scenario!=='normal'&&(scenario!=='cancelled-existing-step'||step>1))await h.run('control',{object:'task',action:'cancel',taskHandle:task.taskHandle,expectedRevision:1,reason:'stop shipping now',requestId:'prestep-control-'+scenario})
   const payload={agent:b,turn,step,messages,signal:abort.signal}
   return (h.listeners.get('agent/pre-step')??[]).reduceRight((next,fn)=>()=>fn(payload,next),async()=>({kind:'enter',messages:[...messages,projectContext.call({},'native runtime facts',[])]}))()
  }
  const steps=[];b.step=async decision=>{steps.push(decision.messages);for(const message of decision.messages)session.append('user/message',message,{surfaceOp:'append'});if(scenario==='cancelled-existing-step'&&steps.length===1)assert.equal((await sendTask()).results[0].admission,'accepted');return {kind:'completed'}}
  await nativeTurn.call(b)
  assert.equal(steps.length,scenario==='cancelled-only'?0:scenario==='cancelled-existing-step'?2:1)
  if(scenario==='cancelled-with-other')assert.deepEqual(steps[0].filter(message=>message.source.kind!=='runtime-context').map(message=>message.id),['other-human'])
 } finally {leave();await h.root.fiber.dispose()}
})
