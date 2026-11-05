// Installed rc.5 services and Inbox on scratch sessions; provider answers are controlled, not desktop input.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {Context,Service} from 'cordis'
import {HarnessError} from '@deepseek-ai/dsh-llm'
import {scopeTarget} from '@deepseek-ai/dsh-scope'
import {SessionStore} from '@deepseek-ai/dsh-session'
import {z} from 'zod'
import {tasksFixture} from './fixtures/session-tasks.mjs'
const host=name=>execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/'+name+'/lib/index.js'],{encoding:'utf8'})
let approvalSource=host('@deepseek-ai/dsh-user-approval')
for(const name of ['@deepseek-ai/cordis','@deepseek-ai/schemastery','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-scope','@deepseek-ai/dsh-session'])approvalSource=approvalSource.replaceAll('"'+name+'"',JSON.stringify(import.meta.resolve(name==='@deepseek-ai/cordis'?'cordis':name)))
const {ApprovalService}=await import('data:text/javascript;base64,'+Buffer.from(approvalSource).toString('base64'))
const questionSource=host('@deepseek-ai/dsh-user-questions')
const slice=(source,first,last)=>{const start=source.indexOf(first),end=source.indexOf(last,start);assert.ok(start>=0&&end>start);return source.slice(start,end)}
const questionMethods=new Function('HarnessError','scopeTarget',slice(questionSource,'var UserQuestionError =','let UserQuestionService =')+'\nreturn {'+slice(questionSource,'\t\tassertLiveRoot(agent) {','\n\t\tcontinued(')+','+slice(questionSource,'\t\tasync ask(request) {','\n\t};')+'}')(HarnessError,scopeTarget)
const loop=host('@deepseek-ai/dsh-agent-loop')
const {ReactLoopInbox,inboxProjectionDefinition}=new Function('z$1',slice(loop,'//#region lib/types/inbox.js','//#endregion')+'\nreturn {ReactLoopInbox,inboxProjectionDefinition}')(z)

async function mounted(){
 const h=await tasksFixture(),root=new Context(),runtime=await h.env.collaboration
 new(class extends Service{constructor(c){super(c,'agents')}get(id){return h.agents.get(id)}roots(){return [...h.agents.values()]}})(root)
 const approval=new ApprovalService(root,{policy:'ask'}),questions={ctx:root,...questionMethods},get=h.ctx.get
 h.ctx.get=name=>name==='approval'?approval:name==='userQuestions'?questions:get(name)
 const sessions=new SessionStore(root),b=h.agents.get('B'),session=sessions.prepare('B'),leave=sessions.enter(session);sessions.announce(session);b.session=session
 root.on('session/event',(session,event)=>{for(const fn of h.listeners.get('session/event')??[])fn(session,event)})
 b.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},session,{emit(name,payload){for(const fn of h.listeners.get(name)??[])fn({agent:b,...payload})}})
 b.steer=message=>b.inbox.append('next-step',message);b.followup=message=>b.inbox.append('next-turn',message)
 return {...h,root,b,runtime,async close(){await runtime.close();leave();await root.fiber.dispose()}}
}

test('scheduled edit approval cannot replace a message dispatched meanwhile by the native sender',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const h=await mounted();let pulse,editing=false,release,entered
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
 h.root.on('approval/request',async()=>{if(editing){entered();await gate}return 'allowed-once'})
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'native-scheduled-edit-race-task'})
  const operationId='native-scheduled-edit-race'
  await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'old input',notBefore:Date.now()+1000,operationId})
  const {scopes}=await h.scopeStatus({}),scope=scopes.find(scope=>scope.tasks[task.id]);editing=true
  const edit=h.run('schedule',{taskHandle:task.taskHandle,operationId,action:'edit',message:'new input',reason:'correct deferred business input'})
  await waiting;t.mock.timers.tick(1000);await pulse()
  const wire=structuredClone(h.b.inbox.nextStep[0]);assert.equal(wire.source.protocolVersion,2)
  release();await assert.rejects(edit,/session_coordinator_control.*message/)
  assert.deepEqual(h.b.inbox.nextStep,[wire]);assert.deepEqual(wire.content,[{type:'text',text:'old input'}])
 }finally{release?.();await h.close()}
})

test('pausing a delivery with unknown durability withdraws its exact native pending input without restoring it',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const h=await mounted();let pulse,submissions=0
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 h.root.on('approval/request',async()=> 'allowed-once')
 const steer=h.b.steer;h.b.steer=message=>{submissions++;steer(message)}
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'native-unknown-schedule-task'})
  await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'run later',notBefore:Date.now()+1000,operationId:'native-unknown-schedule'})
  h.setFlush(async session=>session.id!=='B')
  t.mock.timers.tick(1000);await pulse()
  assert.equal(submissions,1);assert.equal(h.b.inbox.nextStep.length,1)
  assert.equal((await h.run('status',{taskHandle:task.taskHandle})).operations[0].status,'unknown')
  await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'pause uncertain delivery',requestId:'native-unknown-pause'})
  assert.equal(h.b.inbox.nextStep.length,0,'exact native pending identity permits withdrawal without guessing delivery durability')
  await h.run('control',{object:'task',action:'resume',taskHandle:task.taskHandle,expectedRevision:1,reason:'continue only known missing work',requestId:'native-unknown-resume'})
  await pulse();assert.equal(submissions,1)
 }finally{await h.close()}
})

test('native question ask may settle after cancellation, but the task consumer preserves invalidation',async()=>{
 const h=await mounted();let answer,entered
 const reply=new Promise(resolve=>answer=resolve),waiting=new Promise(resolve=>entered=resolve)
 h.root.on('approval/request',async()=> 'allowed-once')
 h.root.on('user-questions/request',async request=>{entered(request);return reply})
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'native-question-revise'})
  const pending=h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'native-late-question',question:'Which rate?',reason:'business choice'})
  const request=await waiting
  const changed=await h.run('control',{object:'task',action:'revise',taskHandle:task.taskHandle,expectedRevision:1,objective:'new shipping',reason:'changed business scope',requestId:'native-question-change'})
  assert.equal(changed.revision,2);assert.equal(request.signal.aborted,true)
  answer({answers:[{id:'native-late-question',selected:[],custom:'old rate'}]})
  const result=await pending
  assert.equal(result.question.state,'cancelled');assert.equal(result.question.answer,undefined)
 }finally{answer?.({answers:[]});await h.close()}
})

for(const action of ['cancel','revise'])test('native pending answer is withdrawn on '+action+' without removing unrelated input',async()=>{
 const h=await mounted()
 h.root.on('approval/request',async()=> 'allowed-once')
 h.root.on('user-questions/request',async()=>({answers:[{id:'native-pending-answer',selected:[],custom:'express'}]}))
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'native-answer-task-'+action})
  await h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'native-pending-answer',question:'Which rate?',reason:'business choice'},'B')
  await h.run('question',{taskHandle:task.taskHandle,action:'question',questionId:'native-pending-answer',reason:'ask user'})
  const pending=h.b.inbox.nextStep.find(message=>message.source.taskId===task.id)
  assert.ok(pending);assert.equal(pending.source.protocolVersion,2)
  assert.equal(h.b.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.id===pending.id),false)
  h.b.inbox.append('next-step',{id:'unrelated-input',role:'user',source:{kind:'user'},content:[{type:'text',text:'preserve other task'}]})
  const result=await h.run('control',{object:'task',action,taskHandle:task.taskHandle,expectedRevision:1,reason:'user changed work',requestId:'native-answer-'+action,...(action==='revise'?{objective:'new shipping'}:{})})
  assert.equal(result.outcome,'applied')
  assert.deepEqual(h.b.inbox.nextStep.map(message=>message.id),['unrelated-input'])
 }finally{await h.close()}
})

for(const outcome of ['allowed-once','rejected','cancelled'])test('native approval '+outcome+' is audited independently and gates its task effect',async()=>{
 const h=await mounted(),abort=new AbortController();let entered,answer
 const waiting=new Promise(resolve=>entered=resolve),reply=new Promise(resolve=>answer=resolve)
 h.root.on('approval/request',async request=>{entered(request);return reply})
 try{
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'native-approval-task-'+outcome})
  const pending=h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'pause this work',requestId:'native-approval-pause-'+outcome},'A',{signal:abort.signal})
  await waiting
  if(outcome==='cancelled')abort.abort(new Error('user cancelled pending approval'));else answer(outcome)
  const result=await pending
  assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,outcome==='allowed-once'?'paused':'active')
  const events=h.agents.get('A').session.snapshotEvents().filter(event=>event.type==='approval/asked'||event.type==='approval/decided')
  assert.equal(events.length,2);assert.equal(events[1].data.outcome,outcome)
  if(outcome==='rejected'){
   const retry=await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'reworded attempt',requestId:'native-denial-new-request'})
   assert.equal(retry.outcome,'rejected');assert.equal(h.agents.get('A').session.snapshotEvents().filter(event=>event.type==='approval/asked').length,1)
  }
  assert.equal(result.outcome,outcome==='allowed-once'?'applied':'rejected')
 }finally{answer?.('cancelled');await h.close()}
})
