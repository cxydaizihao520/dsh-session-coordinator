import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fixture} from './fixtures/session-tools.mjs'

function nativeDelivery(h,id){
 const a=h.agents.get(id);a.inbox={nextStep:[],nextTurn:[],remove(messageId){for(const list of [this.nextStep,this.nextTurn]){const i=list.findIndex(m=>m.id===messageId);if(i>=0){list.splice(i,1);return true}}return false}}
 a.send=(m,target,wakeup)=>{h.effects.push(['native-send',id,target,wakeup,m]);a.inbox[target==='next-turn'?'nextTurn':'nextStep'].push(m);a.session.append('agent/inbox/spliced',{target,start:0,inserted:[m]})}
 a.steer=m=>a.send(m,'next-step',true);a.followup=m=>a.send(m,'next-turn',true);a.inject=m=>a.send(m,'next-step',false)
 a.whenIdle=()=>new Promise(()=>{});a.runMaintenance=fn=>{if(a.status==='running')throw Error('busy');return fn(new AbortController().signal)}
 return a
}
async function start(h,a,turn=1){a.status='running';const controller=new AbortController();a.session.append('turn/start',{turn});for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:a,turn,step:1,signal:controller.signal,messages:[]},async()=>({kind:'enter',messages:[]}));return controller}
const send=(h,id,delivery,extra={})=>h.run('send',{targets:['B'],content:'business input '+id,delivery,requestId:id,...extra})

test('message queue context and strict steer select native timing without cancelling execution',async()=>{
 const h=fixture();h.human('A');const a=nativeDelivery(h,'B')
 assert.equal((await send(h,'mode-message-idle','message')).results[0].admission,'accepted');assert.deepEqual(h.effects.at(-1).slice(2,4),['next-step',true])
 const controller=await start(h,a)
 assert.equal((await send(h,'mode-queue-busy','queue')).results[0].admission,'accepted');assert.deepEqual(h.effects.at(-1).slice(2,4),['next-turn',true])
 assert.equal((await send(h,'mode-context-busy','context')).results[0].admission,'accepted');assert.deepEqual(h.effects.at(-1).slice(2,4),['next-step',false])
 const status=await h.run('status',{sessionId:'B'});assert.ok(status.executionId)
 const strict=await send(h,'mode-steer-busy','steer',{expectedExecution:status.executionId});assert.equal(strict.results[0].admission,'accepted');assert.deepEqual(h.effects.at(-1).slice(2,4),['next-step',false])
 controller.abort({reason:'user stopped'})
 assert.equal(a.inbox.nextStep.some(m=>m.id===strict.results[0].messageId),false)
 const stale=await send(h,'mode-steer-stale','steer',{expectedExecution:status.executionId});assert.equal(stale.results[0].admission,'rejected')
 const late=await send(h,'mode-message-cancelling','message');assert.equal(late.results[0].admission,'rejected')
})

test('strict steer cannot guess an unobserved execution or move an ended turn input to a new turn',async()=>{
 const h=fixture();h.human('A');const a=nativeDelivery(h,'B');a.status='running'
 assert.equal((await send(h,'strict-no-observation','steer',{expectedExecution:'invented'})).results[0].admission,'rejected');assert.equal(h.effects.length,0)
 await start(h,a);const status=await h.run('status',{sessionId:'B'});const delivered=await send(h,'strict-turn-ending','steer',{expectedExecution:status.executionId})
 assert.equal(delivered.results[0].admission,'accepted');a.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 await new Promise(r=>setImmediate(r))
 assert.equal(a.inbox.nextStep.some(m=>m.id===delivered.results[0].messageId),false);assert.equal(a.inbox.nextTurn.length,0)
})

test('a work reply inherits receive-only without requiring a guessed replyTo or waking idle owner',async()=>{
 const h=fixture();h.human('A');const a=nativeDelivery(h,'A')
 const first=await h.run('send',{targets:['B'],content:'test independently',requestId:'receive-only-work-first',replyHandling:'receive-only',authorizationRequest:{participants:['A','B'],purpose:'test',extent:'work'}})
 const response=await h.run('send',{targets:['A'],content:'test result',requestId:'receive-only-work-result',context:{communicationHandle:first.communicationHandle}},'B')
 assert.equal(response.results[0].admission,'accepted');assert.equal(h.effects.filter(e=>e[0]==='native-send'&&e[1]==='A').length,0)
 const received=a.session.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id===response.results[0].messageId)
 assert.equal(received.data.source.replyTo,first.results[0].messageId)
 assert.equal(received.data.content[0].text,'test result')
})

test('receive-only queue stays queued instead of maintenance injecting it into the current history',async()=>{
 const h=fixture();h.human('A');const a=nativeDelivery(h,'A')
 const first=await h.run('send',{targets:['B'],content:'answer later',requestId:'receive-queue-first',replyHandling:'receive-only',authorizationRequest:{participants:['A','B'],purpose:'check',extent:'message',reply:'once'}})
 const response=await h.run('send',{targets:['A'],content:'queued answer',requestId:'receive-queue-reply',delivery:'queue',replyTo:first.results[0].messageId},'B')
 assert.equal(response.results[0].admission,'accepted');assert.deepEqual(h.effects.at(-1).slice(2,4),['next-turn',false])
 assert.equal(a.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===response.results[0].messageId),false)
 assert.equal(a.inbox.nextTurn.length,1)
})

test('pending and claimed do not become included until the exact message enters a branded model request',async()=>{
 const {markAgentLoopRequest}=await import('@deepseek-ai/dsh-llm')
 const h=fixture();h.human('A');const a=nativeDelivery(h,'B');await start(h,a)
 const first=await send(h,'consumption-first','message');const message=a.inbox.nextStep[0]
 const state=async()=> (await h.run('status',{sessionId:'B'})).deliveries.find(row=>row.messageId===first.results[0].messageId).consumption
 assert.equal(await state(),'pending')
 for(const fn of h.listeners.get('agent/inbox/claimed')??[])fn({agent:a,message,turn:1})
 assert.equal(await state(),'claimed')
 const request={sessionId:'B',provider:'fixture',model:'fixture',messages:[message],signal:new AbortController().signal}
 for(const fn of h.listeners.get('llm/stream')??[])for await(const _ of fn(request,async function*(){})){}
 assert.equal(await state(),'claimed')
 for(const fn of h.listeners.get('llm/stream')??[])for await(const _ of fn(markAgentLoopRequest(request),async function*(){})){}
 assert.equal(await state(),'included')
})

test('known cancellation after intent but before native submission retries the same identity only within this runtime',async()=>{
 const h=fixture();h.human('A');nativeDelivery(h,'B');const abort=new AbortController();let once=true
 // Detect the owned delivery intent using the native plugin-record accessor.
 const {pluginRecordOf}=await import('@deepseek-ai/dsh-session')
 h.setFlush(async session=>{if(session.id==='A'&&once&&session.snapshotEvents().some(event=>pluginRecordOf(event)?.type==='plugin:dsh-session-coordinator/delivery')){once=false;abort.abort({code:'stop-before-submit'})}return true})
 const args={targets:['B'],content:'keep identity',requestId:'retry-pre-submit'}
 const stopped=await h.run('send',args,'A',{signal:abort.signal});assert.equal(stopped.results[0].admission,'rejected');assert.equal(h.effects.length,0)
 const retry=await h.run('send',args);assert.equal(retry.results[0].admission,'accepted',JSON.stringify(retry));assert.equal(h.effects.filter(e=>e[0]==='native-send').length,1)
})

test('missing context capability and unobserved running execution fail before native submission',async()=>{
 const h=fixture();h.human('A');h.agents.get('B').status='running'
 const message=await send(h,'unobserved-busy-message','message');assert.equal(message.results[0].admission,'rejected');assert.equal(h.effects.length,0)
 const context=await send(h,'unsupported-context','context');assert.equal(context.results[0].admission,'rejected');assert.equal(h.effects.length,0)
})

test('withdrawn strict receive-only replies are not revived by maintenance or plugin reload',async()=>{
 const h=fixture();h.human('A');const a=nativeDelivery(h,'A');const abort=await start(h,a)
 const root=await h.run('send',{targets:['B'],content:'reply into this execution',requestId:'strict-context-request',replyHandling:'receive-only',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'message',reply:'once'}})
 const status=await h.run('status',{sessionId:'A'})
 const response=await h.run('send',{targets:['A'],content:'strict result',requestId:'strict-context-reply',replyTo:root.results[0].messageId,delivery:'steer',expectedExecution:status.executionId},'B')
 assert.equal(response.results[0].admission,'accepted');abort.abort();a.status='idle'
 for(const fn of h.listeners.get('agent/status')??[])await fn({agent:a,status:'idle'})
 await new Promise(r=>setImmediate(r))
 assert.equal(a.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.id===response.results[0].messageId),false)
 h.ctx.agents.list=()=>[...h.agents.values()];h.reload();await new Promise(r=>setImmediate(r))
 assert.equal(a.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.id===response.results[0].messageId),false)
})

test('receive-only applies to one actual reply, not all later work messages in the conversation',async()=>{
 const h=fixture();h.human('A');nativeDelivery(h,'A')
 const first=await h.run('send',{targets:['B'],content:'test this change',requestId:'round-receive-first',replyHandling:'receive-only',authorizationRequest:{participants:['A','B'],purpose:'fix and test',extent:'work'}})
 const answer=await h.run('send',{targets:['A'],content:'one failing test',requestId:'round-receive-answer',context:{communicationHandle:first.communicationHandle}},'B')
 assert.equal(answer.results[0].admission,'accepted');nativeDelivery(h,'B')
 const next=await h.run('send',{targets:['B'],content:'fix applied, test again',requestId:'round-receive-next',context:{communicationHandle:first.communicationHandle}})
 assert.equal(next.results[0].admission,'accepted',JSON.stringify(next));assert.deepEqual(h.effects.at(-1).slice(2,4),['next-step',true])
 const explicit=await h.run('send',{targets:['B'],content:'independent next check',requestId:'round-receive-explicit',replyHandling:'continue',context:{communicationHandle:first.communicationHandle}})
 assert.equal(explicit.results[0].admission,'accepted');assert.equal(h.approvals.length,1)
})

test('restart cannot materialize an old strict pending receipt as ordinary idle context',async()=>{
 const h=fixture();h.human('A');const a=nativeDelivery(h,'A');await start(h,a)
 const root=await h.run('send',{targets:['B'],content:'reply to this execution',requestId:'restart-strict-root',replyHandling:'receive-only',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'message',reply:'once'}})
 const status=await h.run('status',{sessionId:'A'})
 const response=await h.run('send',{targets:['A'],content:'old strict reply',requestId:'restart-strict-reply',delivery:'steer',expectedExecution:status.executionId,replyTo:root.results[0].messageId},'B')
 assert.equal(response.results[0].admission,'accepted');assert.equal(a.inbox.nextStep.length,1)
 a.status='idle';h.ctx.agents.list=()=>[...h.agents.values()];h.reload();await new Promise(r=>setImmediate(r))
 assert.equal(a.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.id===response.results[0].messageId),false)
 assert.equal(a.inbox.nextStep.length,0)
})
