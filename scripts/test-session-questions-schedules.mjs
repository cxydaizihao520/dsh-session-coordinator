import assert from 'node:assert/strict'
import {test} from 'node:test'
import {tasksFixture} from './fixtures/session-tasks.mjs'

for(const outcome of ['rejected','unknown'])test('question notification '+outcome+' keeps its actual admission and stable retry identity',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,owner=h.agents.get('A')
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'notify-failure-task-'+outcome})
  const input={taskHandle:task.taskHandle,action:'question',questionId:'notify-failure',question:'Which rate?',reason:'business choice'}
  if(outcome==='rejected')h.agents.delete('A');else h.setFlush(async session=>session.id!=='A')
  await assert.rejects(h.run('question',input,'B'))
  h.agents.set('A',owner);h.setFlush(async()=>true)
  const {scopes}=await h.scopeStatus({}),op=Object.values(scopes.find(scope=>scope.tasks[task.id]).operations).find(op=>op.questionId==='notify-failure')
  assert.equal(op.admission,outcome)
  if(outcome==='unknown')assert.equal(op.status,'admitted') // Native consumption is not the durable flush barrier.
  const before=h.effects.filter(row=>row[0]==='send'&&row[1]==='A').length
  if(outcome==='unknown')await assert.rejects(h.run('question',input,'B'),/unknown|inspection|reconcile/i)
  else assert.equal((await h.run('question',input,'B')).question.state,'routed')
  assert.equal(h.effects.filter(row=>row[0]==='send'&&row[1]==='A').length,before+(outcome==='rejected'?1:0))
  if(outcome==='rejected'){await h.run('question',input,'B');assert.equal(h.effects.filter(row=>row[0]==='send'&&row[1]==='A').length,before+1)}
 }finally{h.agents.set('A',owner);await runtime.close()}
})

test('two questions in the same task retain their exact notification reply association',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,get=h.ctx.get
 h.ctx.get=name=>name==='userQuestions'?{async ask(request){return {answers:[{id:request.questions[0].id,selected:[],custom:'standard'}]}}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'question-association-task'})
  const request={taskHandle:task.taskHandle,action:'question',reason:'two business choices'}
  for(const questionId of ['rate-choice','service-choice'])await h.run('question',{...request,questionId,question:questionId},'B')
  const {scopes}=await h.scopeStatus({}),scope=scopes.find(scope=>scope.tasks[task.id])
  for(const questionId of ['rate-choice','service-choice']){
   const notification=Object.values(scope.operations).find(op=>op.questionId===questionId)
   await h.run('question',{...request,questionId})
   const answer=h.effects.filter(row=>row[0]==='send'&&row[1]==='B').at(-1)[2]
   assert.equal(answer.source.replyTo,notification.id)
   assert.equal(JSON.parse(answer.content[0].text).answers[0].id,questionId)
  }
 }finally{await runtime.close()}
})

test('an unanswered provider failure can retry the same question without changing its payload',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,get=h.ctx.get;let asks=0
 h.ctx.get=name=>name==='userQuestions'?{async ask(){if(++asks===1)throw new Error('no provider');return {answers:[{id:'retry-provider',selected:[],custom:'standard'}]}}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'retry-provider-task'})
  const input={taskHandle:task.taskHandle,action:'question',questionId:'retry-provider',question:'Which rate?',reason:'business choice'}
  await assert.rejects(h.run('question',input),/no provider/)
  await assert.rejects(h.run('question',{...input,question:'different choice'}),/content|another/)
  assert.equal((await h.run('question',input)).question.state,'answered');assert.equal(asks,2)
 }finally{await runtime.close()}
})

test('an answer with a definitely rejected relay retries the same answer without asking the user twice',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,get=h.ctx.get,recipient=h.agents.get('B');let asks=0
 h.ctx.get=name=>name==='userQuestions'?{async ask(){asks++;h.agents.delete('B');return {answers:[{id:'rejected-answer',selected:[],custom:'standard'}]}}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'rejected-answer-task'})
  const input={taskHandle:task.taskHandle,action:'question',questionId:'rejected-answer',reason:'business choice'}
  await h.run('question',{...input,question:'Which rate?'},'B')
  await assert.rejects(h.run('question',input));h.agents.set('B',recipient)
  const before=h.effects.filter(row=>row[0]==='send'&&row[1]==='B').length
  assert.equal((await h.run('question',input)).question.state,'answered')
  assert.equal(asks,1);assert.equal(h.effects.filter(row=>row[0]==='send'&&row[1]==='B').length,before+1)
  await h.run('question',input);assert.equal(h.effects.filter(row=>row[0]==='send'&&row[1]==='B').length,before+1)
 }finally{h.agents.set('B',recipient);await runtime.close()}
})

test('an already answered question whose relay is unknown is not asked or submitted again',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,get=h.ctx.get;let asks=0
 h.ctx.get=name=>name==='userQuestions'?{async ask(){asks++;return {answers:[{id:'unknown-answer',selected:[],custom:'standard'}]}}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'unknown-answer-task'})
  const input={taskHandle:task.taskHandle,action:'question',questionId:'unknown-answer',reason:'business choice'}
  await h.run('question',{...input,question:'Which rate?'},'B')
  h.setFlush(async session=>session.id!=='B')
  await assert.rejects(h.run('question',input),/unknown|durability|checkpoint/i)
  const waiting=await h.run('status',{taskHandle:task.taskHandle})
  assert.equal(waiting.scheduling,'waiting');assert.equal(waiting.waitReason,'recovery-required')
  const count=h.effects.filter(row=>row[0]==='send').length
  h.setFlush(async()=>true)
  const result=await h.run('question',input)
  assert.equal(result.question.state,'recovery-required');assert.ok(result.question.answer)
  assert.equal(asks,1);assert.equal(h.effects.filter(row=>row[0]==='send').length,count)
 }finally{await runtime.close()}
})

test('concurrent calls for one question open only one native wait and preserve its answer',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration;let answer,entered,asks=0
 const reply=new Promise(resolve=>answer=resolve),waiting=new Promise(resolve=>entered=resolve),get=h.ctx.get
 h.ctx.get=name=>name==='userQuestions'?{async ask(){asks++;entered();return reply}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'question-concurrent-task'})
  const input={taskHandle:task.taskHandle,action:'question',questionId:'one-user-choice',question:'Which rate?',reason:'one decision'}
  const pending=[h.run('question',input),h.run('question',input)]
  await waiting;await new Promise(resolve=>setImmediate(resolve));assert.equal(asks,1)
  answer({answers:[{id:'one-user-choice',selected:[],custom:'standard'}]});await Promise.all(pending)
  assert.equal((await h.run('question',input)).question.state,'answered')
 }finally{answer?.({answers:[]});await runtime.close()}
})

test('editing deferred work keeps its original operation unwired until the deadline',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const h=await tasksFixture(),runtime=await h.env.collaboration;let pulse
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'scheduled-edit-task'})
  const operationId='scheduled-edit-operation'
  await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'old rate',notBefore:Date.now()+1000,operationId})
  const {scopes}=await h.scopeStatus({}),scope=scopes.find(scope=>scope.tasks[task.id])
  const input={taskHandle:task.taskHandle,operationId,action:'edit',message:'  revised rate  ',reason:'correct future business input'}
  const edited=await h.run('schedule',input)
  assert.equal(edited.wire,undefined)
  t.mock.timers.tick(1000);await pulse()
  const sent=h.effects.filter(row=>row[0]==='send'&&row[2].id===operationId)
  assert.equal(sent.length,1);assert.deepEqual(sent[0][2].content,[{type:'text',text:'  revised rate  '}])
  const approvals=h.approvals.length
  await assert.rejects(h.run('schedule',{...input,message:'too late'}),/session_coordinator_control.*message/)
  assert.equal(h.approvals.length,approvals)
 }finally{await runtime.close()}
})

for(const scenario of ['manual-withdraw','cancel','revise','already-submitted'])test('explicit resume does not resurrect '+scenario+' scheduled work',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const h=await tasksFixture(),runtime=await h.env.collaboration;let pulse
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'no-revive-task-'+scenario})
  await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'calculate later',notBefore:Date.now()+1000,operationId:'no-revive-operation-'+scenario})
  const control={object:'task',taskHandle:task.taskHandle,expectedRevision:1,reason:'explicit user decision'}
  let current=task
  if(scenario==='manual-withdraw'){
   const {scopes}=await h.scopeStatus({})
   await h.run('schedule',{taskHandle:task.taskHandle,operationId:'no-revive-operation-'+scenario,action:'withdraw',reason:'remove this future operation'})
  }
  if(scenario==='already-submitted'){t.mock.timers.tick(1000);await pulse()}
  await h.run('control',{...control,action:'pause',requestId:'no-revive-pause-'+scenario})
  if(scenario==='revise')current=await h.run('control',{...control,action:'revise',objective:'new shipping',requestId:'no-revive-revise'})
  if(scenario==='cancel')await h.run('control',{...control,action:'cancel',requestId:'no-revive-cancel'})
  const count=h.effects.filter(row=>row[0]==='send').length
  t.mock.timers.tick(2000)
  const result=await h.run('control',{...control,taskHandle:current.taskHandle,expectedRevision:current.revision,action:'resume',requestId:'no-revive-resume-'+scenario})
  assert.equal(result.outcome,scenario==='cancel'?'rejected':'applied')
  await pulse();assert.equal(h.effects.filter(row=>row[0]==='send').length,count)
 }finally{await runtime.close()}
})

test('cancelling one pending question does not abort another scope with the same question id',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,requests=[],settle=[];let entered
 const ready=new Promise(resolve=>entered=resolve),get=h.ctx.get
 h.ctx.get=name=>name==='userQuestions'?{ask(request){requests.push(request);if(requests.length===2)entered();return new Promise(resolve=>settle.push(resolve))}}:get(name)
 try{
  const first=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'question-controller-first'})
  const permission=await h.run('send',{targets:['B'],content:'other work',requestId:'question-controller-permit',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'product calculation'}})
  const second=await h.run('task',{communicationHandle:permission.communicationHandle,objective:'product',members:['B'],requestId:'question-controller-second'})
  const pending=[first,second].map(task=>h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'local-choice',question:'Choose a rate',reason:'business choice'}))
  await ready
  await h.run('control',{object:'task',action:'pause',taskHandle:first.taskHandle,expectedRevision:1,reason:'pause shipping only',requestId:'pause-one-question-scope'})
  assert.equal(requests[0].signal.aborted,true);assert.equal(requests[1].signal.aborted,false)
  settle.forEach(resolve=>resolve({answers:[{id:'local-choice',selected:[],custom:'standard'}]}))
  const [cancelled,answered]=await Promise.all(pending)
  assert.equal(cancelled.question.state,'cancelled');assert.equal(answered.question.state,'answered')
 }finally{settle.forEach(resolve=>resolve({answers:[]}));await runtime.close()}
})

test('the same local question id in independent work scopes has distinct delivery identities',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration
 try{
  const first=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'question-scope-first'})
  const permission=await h.run('send',{targets:['B'],content:'another independent work',requestId:'question-scope-permit',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'product calculation'}})
  const second=await h.run('task',{communicationHandle:permission.communicationHandle,objective:'product',members:['B'],requestId:'question-scope-second'})
  for(const [task,question] of [[first,'shipping choice'],[second,'product choice']])await h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'local-choice',question,reason:'independent business decision'},'B')
  const messages=h.effects.filter(row=>row[0]==='send'&&row[1]==='A').map(row=>row[2])
  assert.equal(messages.length,2);assert.notEqual(messages[0].id,messages[1].id)
  assert.deepEqual(messages.map(message=>message.content[0].text),['shipping choice','product choice'])
 }finally{await runtime.close()}
})

test('pausing a not-yet-submitted schedule preserves only its explicit same-revision resume eligibility',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const h=await tasksFixture(),runtime=await h.env.collaboration;let pulse
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'pause-clock-task'})
  await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'calculate later',notBefore:Date.now()+1000,operationId:'pause-clock-operation'})
  const count=h.effects.filter(row=>row[0]==='send').length
  await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'pause before deadline',requestId:'pause-clock-control'})
  t.mock.timers.tick(2000);await pulse();assert.equal(h.effects.filter(row=>row[0]==='send').length,count)
  await h.run('control',{object:'task',action:'resume',taskHandle:task.taskHandle,expectedRevision:1,reason:'explicitly continue missing work',requestId:'resume-clock-control'})
  await pulse();await pulse()
  assert.equal(h.effects.filter(row=>row[0]==='send').length,count+1)
  assert.equal(h.effects.filter(row=>row[0]==='send').at(-1)[2].id,'pause-clock-operation')
 }finally{await runtime.close()}
})

test('deferred task work waits for the specified clock time, then submits its original identity once',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const h=await tasksFixture(),runtime=await h.env.collaboration;let pulse
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'deferred-shipping-task',budget:{maxOperations:1}})
  const input={taskHandle:task.taskHandle,sessionId:'B',message:'  run shipping later\n',notBefore:Date.now()+1000,operationId:'deferred-shipping-operation'}
  const count=h.effects.filter(row=>row[0]==='send').length
  const scheduled=await h.run('schedule',input)
  assert.equal(scheduled.status,'scheduled');assert.equal(h.effects.filter(row=>row[0]==='send').length,count)
  assert.equal((await h.run('status',{taskHandle:task.taskHandle})).operations[0].wire,undefined)
  t.mock.timers.tick(999);await pulse();assert.equal(h.effects.filter(row=>row[0]==='send').length,count)
  t.mock.timers.tick(1);await pulse()
  const sent=h.effects.filter(row=>row[0]==='send').at(-1)[2]
  assert.equal(sent.id,input.operationId);assert.equal(sent.source.protocolVersion,2);assert.equal(sent.content[0].text,input.message)
  await pulse();await h.run('schedule',input)
  assert.equal(h.effects.filter(row=>row[0]==='send').length,count+1)
 }finally{await runtime.close()}
})

test('B routes the exact question through A and receives the native answer through the shared sender',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration
 const get=h.ctx.get,nativeAnswer={answers:[{id:'route-rate',selected:[],custom:'express'}]}
 h.ctx.get=name=>name==='userQuestions'?{async ask(request){assert.equal(request.agent.id,'A');return nativeAnswer}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'question-route-task',budget:{maxOperations:2}})
  const question='  Which shipping rate?\n'
  const routed=await h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'route-rate',question,reason:'missing business decision'},'B')
  assert.equal(routed.question.state,'routed');assert.equal(routed.question.requestedBy,'B')
  const first=h.effects.filter(row=>row[0]==='send').at(-1)[2]
  assert.equal(first.source.protocolVersion,2);assert.equal(first.content[0].text,question)
  assert.match(h.env.delivery.modelContext(h.agents.get('A')),/"question":\{"id":"route-rate"/)
  const answered=await h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'route-rate',reason:'ask the actual user'})
  assert.deepEqual(answered.question.answer,nativeAnswer)
  const reply=h.effects.filter(row=>row[0]==='send').at(-1)
  assert.equal(reply[1],'B');assert.equal(reply[2].source.protocolVersion,2)
  assert.equal(reply[2].content[0].text,JSON.stringify(nativeAnswer))
  assert.equal(reply[2].source.taskRevision,1)
 }finally{await runtime.close()}
})

test('the existing question extension accepts a current task handle without requesting communication approval',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration,asks=[]
 const get=h.ctx.get
 h.ctx.get=name=>name==='userQuestions'?{async ask(request){asks.push(request);return {answers:[{id:'rate-selection',selected:[],custom:'standard'}]}}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'question-handle-task'})
  const result=await h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'rate-selection',question:'Which rate?',reason:'user decision'})
  assert.equal(result.question.state,'answered');assert.equal(result.question.taskRevision,1)
  assert.equal(result.taskHandle,task.taskHandle);assert.equal(asks[0].agent.id,'A')
  assert.equal(h.approvals.length,1,'business answers grant no new communication permission')
 }finally{await runtime.close()}
})

test('a native answer arriving after task revision cannot overwrite the invalidated question',async()=>{
 const h=await tasksFixture(),runtime=await h.env.collaboration
 let answer,asked
 const waiting=new Promise(resolve=>asked=resolve),reply=new Promise(resolve=>answer=resolve)
 const get=h.ctx.get
 h.ctx.get=name=>name==='userQuestions'?{async ask(){asked();return reply}}:get(name)
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'question-revision-task'})
  const {scopes}=await h.scopeStatus({})
  const scope=scopes.find(scope=>scope.tasks[task.id])
  const pending=h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'shipping-rate-question',question:'Which shipping rate?',reason:'Need the user decision'})
  await waiting
  const revised=await h.run('control',{object:'task',action:'revise',taskHandle:task.taskHandle,expectedRevision:1,objective:'new shipping rule',reason:'user changed the objective',requestId:'question-revision-change'})
  assert.equal(revised.revision,2)
  assert.equal((await h.scopeStatus({scopeId:scope.id})).questions['shipping-rate-question'].state,'cancelled','the question is invalid immediately, before the provider settles')
  answer({answers:[{id:'shipping-rate-question',selected:[],custom:'obsolete rate'}]});await pending
  const status=await h.scopeStatus({scopeId:scope.id})
  assert.equal(status.questions['shipping-rate-question'].state,'cancelled')
  assert.equal(status.questions['shipping-rate-question'].answer,undefined)
  assert.equal(status.tasks[task.id].revision,2)
 }finally{answer?.({});await runtime.close()}
})
