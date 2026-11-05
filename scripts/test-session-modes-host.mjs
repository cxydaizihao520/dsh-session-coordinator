// Explicit installed-host method probe; scratch Sessions only, no application/model calls.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {z} from 'zod'
import {fixture} from './fixtures/session-tools.mjs'
const source=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'],{encoding:'utf8'})
const start=source.indexOf('//#region lib/types/inbox.js'),end=source.indexOf('//#endregion',start)
assert.ok(start>=0&&end>start)
const {ReactLoopInbox,inboxProjectionDefinition}=new Function('z$1',source.slice(start,end)+'\nreturn {ReactLoopInbox,inboxProjectionDefinition}')(z)
const sendStart=source.indexOf('\tsend(message, target, wakeup) {'),sendEnd=source.indexOf('\n\tfollowup(',sendStart)
assert.ok(sendStart>=0&&sendEnd>sendStart)
const nativeSend=new Function('return '+source.slice(sendStart,sendEnd).trim().replace(/^send\(/,'function send('))()
function nativeAgent(h){
 const a=h.agents.get('B'),abort=new AbortController();a.status='running';a.phase={kind:'running',abort};a.wakeDriver=()=>h.effects.push(['wake'])
 a.inbox=new ReactLoopInbox({stateOf:session=>session.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},a.session,{emit(name,payload){for(const fn of h.listeners.get(name)??[])fn({agent:a,...payload})}})
 a.send=nativeSend;a.steer=m=>a.send(m,'next-step',true);a.followup=m=>a.send(m,'next-turn',true)
 return {a,abort}
}
async function observe(h,a,abort){a.session.append('turn/start',{turn:1});for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:a,turn:1,step:1,signal:abort.signal,messages:[]},async()=>({kind:'enter',messages:[]}))}

test('mounted multipart receive-only input survives reopening without wakeup or restored authority',async()=>{
 const {Context}=await import('cordis'),{SessionStore}=await import('@deepseek-ai/dsh-session')
 for(const content of ['single',[{type:'text',text:'first'},{type:'text',text:'second'}]]){
  const h=fixture(),root=new Context(),sessions=new SessionStore(root),session=sessions.prepare('B'),leave=sessions.enter(session);sessions.announce(session)
  try {
   h.agents.get('B').session=session
   root.on('session/event',(s,e)=>{for(const fn of h.listeners.get('session/event')??[])fn(s,e)})
   const {a}=nativeAgent(h);h.human('A');a.whenIdle=()=>new Promise(()=>{});a.runMaintenance=()=>{throw Error('busy')};a.inject=m=>a.inbox.append('next-step',m)
   const sent=await h.run('send',{targets:['B'],content,delivery:'context',requestId:'reopen-multipart-context'});assert.equal(sent.results[0].admission,'accepted')
   a.status='idle';a.phase={kind:'idle'};a.runMaintenance=async fn=>fn(new AbortController().signal);h.ctx.agents.list=()=>[a];h.reload()
   await new Promise(resolve=>setImmediate(resolve))
   const history=session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===sent.results[0].messageId)
   assert.equal(history.length,1);assert.deepEqual(history[0].data.content,typeof content==='string'?[{type:'text',text:content}]:content)
   assert.equal(a.inbox.nextStep.length,0);assert.equal(h.effects.filter(e=>e[0]==='wake').length,0);assert.doesNotMatch(h.env.delivery.modelContext(a),/"replyPermission"|"communicationHandle"|"replyTo"/)
  }finally{leave();await root.fiber.dispose()}
 }
})

test('installed native send negative control redirects wakeup after abort; strict adapter never does',async()=>{
 const raw=fixture(),negative=nativeAgent(raw);negative.abort.abort();negative.a.send({id:'negative',role:'user',source:{kind:'user'},content:[]},'next-step',true)
 assert.equal(negative.a.inbox.nextTurn.length,1);assert.equal(raw.effects.filter(e=>e[0]==='wake').length,1)
 const h=fixture();h.human('A');const {a,abort}=nativeAgent(h);await observe(h,a,abort)
 const status=await h.run('status',{sessionId:'B'})
 h.ctx.on('session/event',(session,event)=>{if(session===a.session&&event.type==='agent/inbox/spliced'&&event.data.inserted.length)abort.abort({code:'reentrant-stop'})})
 const result=await h.run('send',{targets:['B'],content:'strict current turn',delivery:'steer',expectedExecution:status.executionId,requestId:'native-strict-reentry'})
 assert.equal(result.results[0].admission,'accepted',JSON.stringify(result));assert.equal(a.inbox.nextStep.length,0);assert.equal(a.inbox.nextTurn.length,0);assert.equal(h.effects.filter(e=>e[0]==='wake').length,0)
 const observed=await h.run('status',{sessionId:'B'});assert.equal(observed.deliveries.find(row=>row.messageId===result.results[0].messageId).consumption,'withdrawn')
})

test('installed native claim preserves next-turn input until a next-turn boundary',async()=>{
 const h=fixture();h.human('A');const {a,abort}=nativeAgent(h);await observe(h,a,abort)
 const queued=await h.run('send',{targets:['B'],content:'next turn business',delivery:'queue',requestId:'native-queue-boundary'})
 assert.equal(queued.results[0].admission,'accepted');assert.equal(a.inbox.claim('next-step',1).length,0)
 assert.equal(a.inbox.nextTurn.length,1);assert.equal(a.inbox.claim('next-turn',2)[0].id,queued.results[0].messageId)
})

test('mounted Session publication defers strict removal and fences a racing next-step claim',async()=>{
 const {Context}=await import('cordis');const {SessionStore}=await import('@deepseek-ai/dsh-session');const {SessionDeliveryState}=await import('../src/session-delivery-state.ts')
 const root=new Context(),sessions=new SessionStore(root),session=sessions.prepare('mounted-B'),detach=sessions.enter(session);sessions.announce(session)
 const handlers=new Map(),agents=new Map(),errors=[]
 const ctx={on(name,fn){root.on(name,(...args)=>{try{return fn(...args)}catch(error){errors.push(error);throw error}});const list=handlers.get(name)??[];list.push(fn);handlers.set(name,list)},effect(){},agents:{get:id=>agents.get(id)},sessions:{flush:async()=>true}}
 const a={id:String(session.id),session,status:'running'};agents.set(a.id,a)
 a.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},session,{emit(name,payload){for(const fn of handlers.get(name)??[])fn({agent:a,...payload})}})
 a.send=(m,target)=>a.inbox.append(target,m)
 const state=new SessionDeliveryState(ctx,()=>{}),first=new AbortController();session.append('turn/start',{turn:1})
 const pre=handlers.get('agent/pre-step')[0]
 await pre({agent:a,turn:1,step:1,signal:first.signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const id=state.executionId(a),message={id:'mounted-strict',role:'user',source:{kind:'session-message',protocolVersion:2,expectedExecution:id},content:[{type:'text',text:'only original turn'}]}
 state.prepare(a,message,'steer',id);a.inbox.append('next-step',message)
 session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const raced=a.inbox.claim('next-step',2)
 const decision=await pre({agent:a,turn:2,step:1,signal:new AbortController().signal,messages:raced},async()=>({kind:'enter',messages:raced}))
 assert.equal(errors.length,0);assert.ok(decision.kind==='reject'||!decision.messages.some(m=>m.id===message.id))
 const other={id:'unrelated-input',role:'user',source:{kind:'user'},content:[{type:'text',text:'keep this independent work'}]}
 const mixed=await pre({agent:a,turn:2,step:1,signal:new AbortController().signal,messages:[...raced,other]},async()=>({kind:'enter',messages:[...raced,other]}))
 assert.equal(mixed.kind,'enter');assert.deepEqual(mixed.messages.map(m=>m.id),[other.id]);await new Promise(r=>setImmediate(r));assert.equal(a.inbox.nextStep.length,0)
 // Abort inside the publisher also must not leak an AbortSignal listener exception.
 const abort=new AbortController();await pre({agent:a,turn:3,step:1,signal:abort.signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const nextId=state.executionId(a),next={...message,id:'mounted-abort',source:{...message.source,expectedExecution:nextId}}
 state.prepare(a,next,'steer',nextId)
 const stop=root.on('session/event',(s,e)=>{if(s===session&&e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.id===next.id))abort.abort()})
 a.inbox.append('next-step',next);await new Promise(r=>setImmediate(r));assert.equal(a.inbox.nextStep.length,0);assert.equal(errors.length,0)
 stop();detach();await root.fiber.dispose()
})

test('native fresh main sessions may omit delegationDepth; work permission still excludes subagents',async()=>{
 const {Context}=await import('cordis'),{SessionStore}=await import('@deepseek-ai/dsh-session')
 for(const meta of [undefined,{delegationDepth:0},{delegationDepth:1},{origin:'subagent'}]){
  const h=fixture(),root=new Context(),sessions=new SessionStore(root)
  try{
   for(const id of ['A','B']){
    const session=sessions.prepare(id,{meta}),a=h.agents.get(id)
    a.session=session;a.steer=m=>session.append('user/message',m,{surfaceOp:'append'})
   }
   h.human('A')
   const result=await h.run('send',{targets:['B'],content:'complete reconciliation and report',requestId:'native-depth-default',authorizationRequest:{participants:['A','B'],purpose:'reconcile',extent:'work'}})
   const main=meta===undefined||meta.delegationDepth===0
   assert.equal(result.results[0].admission,main?'accepted':'rejected',JSON.stringify(result))
   assert.equal(h.approvals.length,main?1:0)
  }finally{await root.fiber.dispose()}
 }
})
