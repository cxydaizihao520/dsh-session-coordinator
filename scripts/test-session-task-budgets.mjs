import assert from 'node:assert/strict'
import {test} from 'node:test'
import {markAgentLoopRequest} from '@deepseek-ai/dsh-llm'
import {tasksFixture} from './fixtures/session-tasks.mjs'

const declare=(h,objective,requestId,budget)=>h.run('task',{communicationHandle:h.communicationHandle,objective,members:['B'],requestId,...(budget?{budget}:{})})
const send=(h,task,requestId,who='A',content='business input',replyTo)=>h.run('send',{targets:[who==='A'?'B':'A'],content,requestId,...(replyTo?{replyTo}:{}),context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}},who)

test('task budget is independently approved, explicit, and frozen with declaration identity',async()=>{
 const h=await tasksFixture(),budget={maxOperations:2,maxNoProgress:3,maxElapsedMs:60000,maxObservedTokens:1000}
 const task=await declare(h,'bounded shipping','budget-declaration',budget)
 assert.deepEqual(task.budget,budget);assert.equal(h.approvals.length,2)
 assert.ok(h.approvals[1].reason.includes('maxOperations'))
 assert.deepEqual(await declare(h,'bounded shipping','budget-declaration',budget),task);assert.equal(h.approvals.length,2)
 await assert.rejects(declare(h,'bounded shipping','budget-declaration',{...budget,maxOperations:200}),/identity|another task|conflict/i)
 assert.equal(h.approvals.length,2)
 h.setAnswer(async()=> 'rejected')
 await assert.rejects(declare(h,'other budget','budget-denied',{maxOperations:3}),/not authorized/)
 assert.equal([...h.records.values()].flatMap(record=>Object.values(record.data.tasks)).length,1)
})

test('one task operation budget stops late dispatch and resume, while the other task continues',async()=>{
 const h=await tasksFixture(),task=await declare(h,'shipping','budget-shipping',{maxOperations:1}),other=await declare(h,'product','budget-product')
 assert.equal((await send(h,task,'budget-first')).results[0].admission,'accepted')
 const late=await send(h,task,'budget-late','B','late shipping result')
 assert.equal(late.results[0].admission,'rejected')
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'budget-exhausted')
 const resumed=await h.run('control',{object:'task',action:'resume',taskHandle:task.taskHandle,expectedRevision:1,reason:'retry without new budget',requestId:'budget-resume'})
 assert.equal(resumed.outcome,'rejected');assert.match(resumed.error.message,/budget/)
 assert.equal((await send(h,other,'budget-other-continues')).results[0].admission,'accepted')
 h.setAnswer(async()=> 'rejected')
 const before=[...h.records.values()].flatMap(record=>Object.values(record.data.tasks)).length
 await assert.rejects(h.run('task',{communicationHandle:h.communicationHandle,objective:'replacement shipping',members:['A'],requestId:'budget-replacement'},'B'),/not authorized|budget|inactive/)
 assert.equal([...h.records.values()].flatMap(record=>Object.values(record.data.tasks)).length,before)
})

test('normal dispatch and waiting do not consume the no-progress guard',async()=>{
 const h=await tasksFixture(),task=await declare(h,'multiple valid calculations','budget-many-valid')
 for(let index=0;index<12;index++)assert.equal((await send(h,task,'valid-dispatch-'+index,'A','different calculation '+index)).results[0].admission,'accepted')
 const status=await h.run('status',{taskHandle:task.taskHandle})
 assert.equal(status.state,'active');assert.equal(status.noProgress,0);assert.equal(status.scheduling,'waiting')
})

for(const oldImplicitBudget of [false,true])test('default text-only collaboration has no hidden round limit: old implicit budget '+oldImplicitBudget,async()=>{
 const h=await tasksFixture(),task=await declare(h,'review evolving architecture text','unbounded-text-review')
 assert.equal(task.budget,undefined)
 if(oldImplicitBudget)await (await h.env.collaboration).withTask([...h.records.keys()][0],task.id,{agent:h.agents.get('A'),callId:'seed-previous-format',signal:new AbortController().signal},stored=>{stored.budget={maxNoProgress:8}})
 for(let index=1;index<=12;index++){
  const request=await send(h,task,'text-review-request-'+index,'A','review revision '+index)
  assert.equal(request.results[0].admission,'accepted')
  assert.equal((await send(h,task,'text-review-reply-'+index,'B','analysis revision '+index,request.results[0].messageId)).results[0].admission,'accepted')
 }
 const status=await h.run('status',{taskHandle:task.taskHandle})
 assert.equal(status.state,'active');assert.equal(status.noProgress,0)
 assert.equal(h.approvals.length,1,'ordinary collaboration needs no added budget approval')
})

for(const fingerprint of ['not-json','{}','[]','{"2":null}','["work",["B"],{"maxNoProgress":0}]'])test('unknown stored declaration retains its budget: '+fingerprint,async()=>{
 const h=await tasksFixture(),task=await declare(h,'bounded legacy review','legacy-budget-review',{maxNoProgress:1})
 await (await h.env.collaboration).withTask([...h.records.keys()][0],task.id,{agent:h.agents.get('A'),callId:'seed-unknown-format',signal:new AbortController().signal},stored=>{stored.declarationFingerprint=fingerprint})
 const request=await send(h,task,'legacy-initial-input')
 await send(h,task,'legacy-initial-reply','B','review result',request.results[0].messageId)
 assert.equal((await send(h,task,'legacy-first-redispatch')).results[0].admission,'accepted')
 const limited=await send(h,task,'legacy-next-redispatch')
 assert.equal(limited.results[0].admission,'rejected');assert.match(limited.results[0].error.message,/no-progress/)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'budget-exhausted')
})

test('scheduled actual dispatch shares the explicit guard and retries do not charge twice',async()=>{
 const h=await tasksFixture(),task=await declare(h,'bounded review','scheduled-explicit-budget',{maxNoProgress:1})
 const request=await send(h,task,'scheduled-original-input')
 assert.equal((await send(h,task,'scheduled-original-reply','B','review result',request.results[0].messageId)).results[0].admission,'accepted')
 const input={taskHandle:task.taskHandle,sessionId:'B',message:'review again',notBefore:0,operationId:'scheduled-guard-first'}
 await h.run('schedule',input)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).noProgress,1)
 const count=h.effects.length;await h.run('schedule',input)
 assert.equal(h.effects.length,count);assert.equal((await h.run('status',{taskHandle:task.taskHandle})).noProgress,1)
 await assert.rejects(h.run('schedule',{...input,operationId:'scheduled-guard-next'}),/no-progress/)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'budget-exhausted')
})

async function stopBoundary(h,step){
 const a=h.agents.get('A');a.status='running'
 if(step===1)a.session.append('turn/start',{turn:1})
 h.ownerSignal??=new AbortController().signal
 a.send=(message,target)=>target==='next-step'?a.steer(message):a.followup(message)
 const payload={agent:a,turn:1,step,messages:[],signal:h.ownerSignal}
 await (h.listeners.get('agent/pre-step')??[]).reduceRight((next,fn)=>()=>fn(payload,next),async()=>({kind:'enter',messages:[]}))()
 a.session.append('step/start',{turn:1,step})
 for(const fn of h.listeners.get('agent/turn-stopping')??[])await fn({agent:a,turn:1,signal:new AbortController().signal})
}

test('idle boundaries spend no budget; only actual repeated dispatch reaches its task limit',async()=>{
 const h=await tasksFixture(),task=await declare(h,'unfinished shipping','budget-ready-shipping',{maxNoProgress:2}),other=await declare(h,'ready product','budget-ready-product')
 await stopBoundary(h,1);await stopBoundary(h,2);await stopBoundary(h,3)
 let status=await h.run('status',{taskHandle:task.taskHandle})
 assert.equal(status.state,'active');assert.equal(status.noProgress,0)
 assert.equal(h.effects.filter(row=>row[0]==='send'&&row[1]==='A').length,0)
 for(let index=1;index<=3;index++){
  const request=await send(h,task,'bounded-dispatch-'+index);assert.equal(request.results[0].admission,'accepted')
  const before=await h.run('status',{taskHandle:task.taskHandle})
  assert.equal((await send(h,task,'bounded-dispatch-'+index)).results[0].admission,'accepted')
  assert.equal((await h.run('status',{taskHandle:task.taskHandle})).noProgress,before.noProgress,'same request retry never spends another attempt')
  assert.equal((await send(h,task,'bounded-reply-'+index,'B','same evidence',request.results[0].messageId)).results[0].admission,'accepted')
  await stopBoundary(h,index+3)
 }
 const limited=await send(h,task,'bounded-next-dispatch')
 assert.equal(limited.results[0].admission,'rejected')
 status=await h.run('status',{taskHandle:task.taskHandle})
 assert.equal(status.state,'budget-exhausted');assert.equal(status.noProgress,2)
 assert.equal((await send(h,other,'other-real-dispatch')).results[0].admission,'accepted')
 assert.equal([...h.records.values()][0].data.state,'active','a single task limit does not revoke communication')
})

test('new reply IDs and changing ACK wording do not prove progress or reset the guard',async()=>{
 const h=await tasksFixture(),task=await declare(h,'bounded review','budget-ack-review',{maxNoProgress:2})
 for(let index=1;index<=3;index++){
  const request=await send(h,task,'ack-request-'+index);assert.equal(request.results[0].admission,'accepted')
  const reply=await send(h,task,'ack-reply-'+index,'B','ACK different wording '+index,request.results[0].messageId);assert.equal(reply.results[0].admission,'accepted',JSON.stringify({index,reply}))
  await stopBoundary(h,index)
 }
 await stopBoundary(h,4)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'active')
 assert.equal((await send(h,task,'ack-next-request')).results[0].admission,'rejected')
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'budget-exhausted')
})

for(const unique of [true,false])test('actual redispatch progress uses native business evidence, not call IDs: '+unique,async()=>{
 const h=await tasksFixture(),task=await declare(h,'calculation evidence','budget-native-evidence',{maxNoProgress:2}),b=h.agents.get('B')
 for(let index=1;index<=(unique?12:3);index++){
  b.status='idle';b.session.append('turn/start',{turn:index})
  const sent=await send(h,task,'native-evidence-request-'+index);assert.equal(sent.results[0].admission,'accepted')
  b.status='running';b.session.append('step/start',{turn:index,step:1})
  const message=h.effects.find(row=>row[0]==='send'&&row[2].id===sent.results[0].messageId)[2]
  const request=markAgentLoopRequest({sessionId:'B',messages:[message],signal:new AbortController().signal})
  let stream=async function*(){};for(const fn of [...h.listeners.get('llm/stream')??[]].reverse()){const next=stream;stream=()=>fn(request,next)}for await(const _ of stream()){}
  const callId='calculation-'+index
  b.session.append('tool/call',{turn:index,step:1,callId,name:'calculate',arguments:{input:index}})
  const calculated=unique?index*index:1
  b.session.append('tool/result',{turn:index,step:1,callId,name:'calculate',result:{isError:false,content:[{type:'text',text:String(calculated)}]}},{surfaceOp:'append'})
  const reply=await send(h,task,'native-evidence-reply-'+index,'B','result is ready',sent.results[0].messageId)
  assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply))
  b.session.append('turn/end',{turn:index,reason:{kind:'completed'}});b.status='idle'
  await stopBoundary(h,index)
 }
 if(!unique){const limited=await send(h,task,'duplicate-evidence-next');assert.equal(limited.results[0].admission,'rejected');assert.match(limited.results[0].error.message,/no-progress/,JSON.stringify(limited))}
 const status=await h.run('status',{taskHandle:task.taskHandle})
 assert.equal(status.state,unique?'active':'budget-exhausted')
 assert.equal(status.progressEvidence.length,unique?12:1)
 assert.ok(status.progressEvidence.every(item=>item.kind==='tool-result'&&typeof item.seq==='number'&&item.sessionId==='B'))
})

for(const scenario of ['exclusive','shared','ready-other','missing'])test('task token accounting preserves ownership and unknown usage: '+scenario,async()=>{
 const h=await tasksFixture(['A','B','C']),task=await declare(h,'shipping tokens','budget-token-shipping',{maxObservedTokens:5})
 const other=await h.run('task',{communicationHandle:h.communicationHandle,objective:'other calculation',members:[['shared','ready-other'].includes(scenario)?'B':'C'],requestId:'budget-token-other'})
 const b=h.agents.get('B');b.session.append('turn/start',{turn:1})
 assert.equal((await send(h,task,'token-input-one')).results[0].admission,'accepted')
 if(scenario==='shared')assert.equal((await send(h,other,'token-input-two')).results[0].admission,'accepted')
 b.status='running';b.session.append('step/start',{turn:1,step:1})
 const request=markAgentLoopRequest({sessionId:'B',messages:h.effects.filter(row=>row[0]==='send'&&row[1]==='B'&&row[2].source.taskId).map(row=>row[2]),signal:new AbortController().signal})
 let stream=async function*(){};for(const fn of [...h.listeners.get('llm/stream')??[]].reverse()){const next=stream;stream=()=>fn(request,next)}for await(const _ of stream()){}
 b.session.append('assistant/message',{turn:1,step:1,...(scenario==='missing'?{}:{usage:{inputTokens:3,outputTokens:3}}),message:{id:'token-observation',role:'assistant',content:[{type:'text',text:'calculation'}]}},{surfaceOp:'append'})
 const shipping=await h.run('status',{taskHandle:task.taskHandle}),product=await h.run('status',{taskHandle:other.taskHandle})
 assert.equal(shipping.budgetUsage.observedTokens,scenario==='exclusive'?6:0)
 assert.equal(shipping.budgetUsage.usageIncomplete,scenario!=='exclusive')
 assert.equal(shipping.state,scenario==='exclusive'?'budget-exhausted':'active')
 assert.equal(product.budgetUsage.observedTokens,0);assert.equal(product.state,'active')
 if(['shared','ready-other'].includes(scenario))assert.equal(product.budgetUsage.usageIncomplete,true)
})

test('elapsed task budget is enforced at the actual pre-step consumer without starting work',async()=>{
 const h=await tasksFixture(),task=await declare(h,'deadline-bound work','budget-elapsed-task',{maxElapsedMs:1000}),b=h.agents.get('B')
 b.followup=message=>b.inbox.nextTurn.push(message)
 const sent=await h.run('send',{targets:['B'],delivery:'queue',content:'work before deadline',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 assert.equal(sent.results[0].admission,'accepted')
 const message=b.inbox.nextTurn.shift(),now=Date.now
 try {
  Date.now=()=>task.createdAt+2000
  const payload={agent:b,turn:1,step:1,messages:[message],signal:new AbortController().signal}
  const decision=await (h.listeners.get('agent/pre-step')??[]).reduceRight((next,fn)=>()=>fn(payload,next),async()=>({kind:'enter',messages:[message]}))()
  assert.equal(decision.kind,'reject')
  assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'budget-exhausted')
 } finally {Date.now=now}
})


test('owner cannot omit task context to bypass its exhausted budget in the same human input',async()=>{
 const h=await tasksFixture(),task=await declare(h,'bounded shipping','owner-budget-task',{maxOperations:1})
 assert.equal((await send(h,task,'owner-budget-first')).results[0].admission,'accepted')
 assert.equal((await send(h,task,'owner-budget-limit')).results[0].admission,'rejected')
 const plain={targets:['B'],content:'another dispatch with different wording',context:{communicationHandle:h.communicationHandle}}
 assert.equal((await h.run('send',plain)).results[0].admission,'rejected')
 h.human('A')
 assert.equal((await h.run('send',plain)).results[0].admission,'accepted','fresh human context can use still-live ordinary communication permission')
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'budget-exhausted','new human input never revives old task')
 await (await h.env.collaboration).close()
})
