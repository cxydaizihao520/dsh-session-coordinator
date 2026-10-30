import assert from 'node:assert/strict'
import { Session, pluginRecordOf, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { registerBridgeTools } from '../src/tools.ts'
import { createGrants } from '../src/coordinate.ts'
let count=0
const test=async(name,fn)=>{await fn();console.log('PASS '+name);count++}
function fixture(){
 const agents=new Map(),tools=new Map(),listeners=new Map(),effects=[],approvals=[],durable=new Map()
 let answer=async()=> 'allowed-once',flush=async()=>true,call=0
 const blank=()=>new Proxy({}, {get:(o,k)=>k==='then'?undefined:o[k]??=()=>undefined})
 const make=id=>{
  const session=Session.create(id,undefined,{version:4,id,createdAt:1,isSeeded:false,delegationDepth:0,cwd:'/tmp/probe'})
  session.append('turn/start',{turn:0})
  const append=session.append.bind(session);session.append=(...args)=>{const e=append(...args);for(const f of listeners.get('session/event')??[])f(session,e);return e}
  const a={id,ctx:blank(),session,status:'idle',inbox:{nextStep:[],nextTurn:[]},
   steer(m){effects.push(['send',id,m]);session.append('user/message',m,{surfaceOp:'append'})},
   followup(m){this.steer(m)},cancel(){throw Error('unexpected cancel')}}
  agents.set(id,a);return a
 }
 const ctx={get:name=>name==='approval'?{request:async req=>{approvals.push(req);return answer(req)}}:undefined,
  on(name,fn){const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list)},
  tools:{register:t=>tools.set(t.name,t)},sessions:{async flush(s){const ok=await flush(s);if(ok)durable.set(s.id,{header:s.header,events:structuredClone(s.snapshotEvents()),inheritedEventCount:s.inheritedEventCount});return ok}},
  sessionPersistence:{async open(id,mode){assert.equal(mode,'read');const d=durable.get(id);if(!d)throw Error('missing log');return {...d,read:async()=>({events:d.events}),close:async()=>{effects.push(['close',id])}}}},
  agents:{get:id=>agents.get(id),list:()=>[],async create(o){effects.push(['create',o.sessionId]);return {agent:make(o.sessionId)}}},
  workspaceRegistry:{archivedSessionIds:[],list:()=>[],resolveByPath:async()=>undefined},agentPresets:{composedPreset(){},composeFrom(){}}
 }
 const grants=createGrants(),registry={touch(){},record(){}}
 const env={ctx,grants,registry};registerBridgeTools(env)
 make('A');make('B')
 const run=(name,args,who='A',options={})=>tools.get('session_coordinator_'+name).execute(args,{agent:agents.get(who),callId:options.callId??'call-'+(++call),signal:options.signal??new AbortController().signal,concludeTurn(){effects.push(['conclude',who])}})
 return {ctx,env,agents,tools,effects,approvals,durable,grants,run,make,setAnswer(fn){answer=fn},setFlush(fn){flush=fn},human(id){const a=agents.get(id);a.session.append('user/message',{id:'human-'+(++call),role:'user',source:{kind:'user'},content:[{type:'text',text:'new request'}]},{surfaceOp:'append'})},reload(){registerBridgeTools({...env,delivery:undefined,grants:createGrants()})}}
}
await test('new and existing targets: one approval, same verified reply chain, no broad grant',async()=>{
 for(const name of ['create','send']){
 const h=fixture();const task=await h.run(name,name==='create'?{prompt:'evaluate'}:{sessionId:'B',message:'evaluate'})
 assert.equal(h.approvals.length,1);assert.equal(h.grants.isGranted('A',task.sessionId),false)
 const entry=h.effects.find(e=>e[0]==='send');assert.equal(entry[2].source.kind,'session-message')
 const response=await h.run('send',{sessionId:'A',message:'business result',replyTo:task.messageId},task.sessionId)
 assert.equal(response.terminal,true);assert.equal(h.approvals.length,1)
 const received=await h.run('wait',{sessionId:task.sessionId,requestId:task.messageId});assert.equal(received.reply.message.text,'business result')
 await assert.rejects(h.run('send',{sessionId:task.sessionId,message:'third hop'}),/terminal/)
 await assert.rejects(h.run('send',{sessionId:'A',message:'twice',replyTo:task.messageId},task.sessionId),/one reply/)
 }
})
await test('denied/missing/cancelled/late approval: zero create or delivery effects',async()=>{
 for(const name of ['create','send'])for(const outcome of ['rejected','unavailable','cancelled']){
 const h=fixture();h.setAnswer(async()=>outcome)
 await assert.rejects(h.run(name,name==='create'?{prompt:'task'}:{sessionId:'B',message:'task'}),/not authorized/);assert.equal(h.effects.length,0)
 }
 const h=fixture();h.ctx.get=()=>undefined;await assert.rejects(h.run('create',{prompt:'task'}),/unavailable/);assert.equal(h.effects.length,0)
 const a=fixture(),abort=new AbortController();a.setAnswer(async()=>{abort.abort();return 'allowed-once'})
 await assert.rejects(a.run('create',{prompt:'task'},'A',{signal:abort.signal}));assert.equal(a.effects.length,0)
})
await test('existing grant bypasses approval; invalid reply never asks for a new authorization',async()=>{
 const h=fixture();h.grants.grant('A',['B']);await h.run('send',{sessionId:'B',message:'task'})
 assert.equal(h.approvals.length,0);await assert.rejects(h.run('send',{sessionId:'A',message:'reply',replyTo:'forged'},'B'),/incoming task/);assert.equal(h.approvals.length,0)
 await assert.rejects(h.run('create',{prompt:'delegate again'},'B'),/incoming collaboration/)
})
await test('revocation while approval pending prevents create/send; payload stays the approved snapshot',async()=>{
 for(const name of ['create','send']){const h=fixture();h.setAnswer(async()=>{h.env.delivery.revoke('A');return 'allowed-once'})
 await assert.rejects(h.run(name,name==='create'?{prompt:'task'}:{sessionId:'B',message:'task'}),/authorization changed/);assert.equal(h.effects.length,0)}
 const h=fixture(),args={sessionId:'B',message:'original'};h.setAnswer(async()=>{args.message='changed';args.sessionId='C';return 'allowed-once'})
 await h.run('send',args);assert.equal(h.effects[0][1],'B');assert.match(h.effects[0][2].content[0].text,/original$/)
})
await test('create reservation and duplicate call prevent second creation; failed flush has no create effect',async()=>{
 const h=fixture();await h.run('create',{prompt:'task'},'A',{callId:'stable'})
 await assert.rejects(h.run('create',{prompt:'task'},'A',{callId:'stable'}),/already reserved/)
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1)
 const f=fixture();f.setFlush(async()=>false);await assert.rejects(f.run('create',{prompt:'task'}),/durability/);assert.equal(f.effects.length,0)
 const g=fixture();g.setFlush(async()=>{throw Error('disk failure')});await assert.rejects(g.run('create',{prompt:'task'}),/disk failure/);assert.equal(g.effects.length,0)
})
await test('cancel after creation reports identity and does not send or delete the new session',async()=>{
 const h=fixture(),abort=new AbortController(),create=h.ctx.agents.create
 h.ctx.agents.create=async o=>{const result=await create(o);abort.abort();return result}
 await assert.rejects(h.run('create',{prompt:'task'},'A',{signal:abort.signal}),/creationConfirmed=true/)
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1);assert.equal(h.effects.filter(e=>e[0]==='send').length,0)
})
await test('reload recovers only complete two-sided evidence, never reauthorizes or wakes agents',async()=>{
 const h=fixture(),task=await h.run('send',{sessionId:'B',message:'task'})
 await h.run('send',{sessionId:'A',message:'answer\nline two',replyTo:task.messageId},'B');h.reload()
 const before=h.effects.length;const result=await h.run('wait',{sessionId:'B',requestId:task.messageId})
 assert.equal(result.reply.recovered,true);assert.equal(result.reply.message.text,'answer\nline two');assert.equal(h.effects.length,before)
 await assert.rejects(h.run('send',{sessionId:'A',message:'old reply',replyTo:task.messageId},'B'),/incoming task/)
})
await test('offline reconciliation is read-only and closes handles; missing or conflicting facts refuse',async()=>{
 const h=fixture(),task=await h.run('send',{sessionId:'B',message:'task'})
 await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');h.reload();h.agents.delete('B')
 assert.equal((await h.run('wait',{sessionId:'B',requestId:task.messageId})).reply.recovered,true)
 assert.ok(h.effects.some(e=>e[0]==='close'&&e[1]==='B'))
 const log=h.durable.get('B');log.events=log.events.filter(e=>pluginRecordOf(e)?.type!=='plugin:dsh-session-coordinator/delivery')
 await assert.rejects(h.run('wait',{sessionId:'B',requestId:task.messageId}),/evidence unavailable/)
})
await test('new target waits for correlated reply without relying on assistant text',async()=>{
 const h=fixture(),create=h.ctx.agents.create;let replyWork
 h.ctx.agents.create=async o=>{const result=await create(o);const steer=result.agent.steer.bind(result.agent);result.agent.steer=m=>{steer(m);replyWork=Promise.resolve().then(()=>h.run('send',{sessionId:'A',message:'42',replyTo:m.id},o.sessionId))};return result}
 const result=await h.run('create',{prompt:'calculate',waitForReply:true,timeoutMs:500})
 await replyWork;assert.equal(result.reply.received,true);assert.equal(result.reply.message.text,'42')
})
await test('G5 snapshot still blocks completion; explicit human followup starts a fresh approval',async()=>{
 const h=fixture(),task=await h.run('send',{sessionId:'B',message:'task'}),b=h.agents.get('B')
 b.session.append('user/message',{id:'snapshot',role:'user',source:{kind:'plugin:test',form:'snapshot',sections:[]},content:[{type:'text',text:'context'}]},{surfaceOp:'append'})
 await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');assert.ok(!h.effects.some(e=>e[0]==='conclude'))
 h.human('A');await h.run('send',{sessionId:'B',message:'next task'});assert.equal(h.approvals.length,2)
})
await test('recovery refuses unknown versions, conflicting admissions, and fork-inherited evidence',async()=>{
 for(const scenario of ['version','conflict','inherited']){
  const h=fixture(),task=await h.run('send',{sessionId:'B',message:'task'})
  await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');h.reload()
  const b=h.agents.get('B')
  if(scenario==='version'){
   const record=b.session.snapshotEvents().map(pluginRecordOf).find(r=>r?.type==='plugin:dsh-session-coordinator/delivery')
   appendPluginRecord(b.session,record.type,{...record.data,version:999})
  }else if(scenario==='conflict'){
   const root=b.session.snapshotEvents().find(e=>e.type==='user/message').data
   b.session.append('agent/inbox/spliced',{target:'next-turn',start:0,deleteCount:0,inserted:[{...root,content:[{type:'text',text:'changed'}]}]})
  }else{
   h.agents.delete('B');h.durable.get('B').inheritedEventCount=h.durable.get('B').events.length
  }
  await assert.rejects(h.run('wait',{sessionId:'B',requestId:task.messageId}),/evidence unavailable/)
 }
})
await test('reload cancellation returns aborted without restoring or sending; handles close on read errors',async()=>{
 const h=fixture(),task=await h.run('send',{sessionId:'B',message:'task'})
 await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');h.reload()
 const abort=new AbortController();abort.abort();const before=h.effects.length
 assert.equal((await h.run('wait',{sessionId:'B',requestId:task.messageId},'A',{signal:abort.signal})).reply.aborted,true)
 assert.equal(h.effects.length,before)
 h.agents.delete('B');let closed=false;h.ctx.sessionPersistence.open=async()=>({header:{id:'B'},inheritedEventCount:0,read:async()=>{throw Error('storage failure')},close:async()=>{closed=true}})
 await assert.rejects(h.run('wait',{sessionId:'B',requestId:task.messageId}),/evidence unavailable/);assert.equal(closed,true)
})
await test('repeated panel request after reload cannot silently redeliver; delivered result survives later flush failure',async()=>{
 const h=fixture(),raw=JSON.stringify({requestId:'stable-panel-request',sessionId:'B',message:'task',mode:'steer'})
 assert.equal((await h.env.delivery.fromCommand('A',raw)).kind,'success')
 const before=h.effects.filter(e=>e[0]==='send').length
 const {SessionDelivery}=await import('../src/delivery.ts');const reload=new SessionDelivery(h.ctx,{touch(){}},createGrants())
 assert.equal((await reload.fromCommand('A',raw)).kind,'error');assert.equal(h.effects.filter(e=>e[0]==='send').length,before)
 const f=fixture();let n=0;f.setFlush(async()=>{if(++n===2)throw Error('post-delivery failure');return true})
 const originalWarn=console.warn;console.warn=()=>{}
 try {const sent=await f.run('send',{sessionId:'B',message:'task'});assert.equal(sent.accepted,true);assert.equal(f.effects.filter(e=>e[0]==='send').length,1)}finally{console.warn=originalWarn}
})


await test('diagnostics retain legacy attempt hops including terminal refusal without business text', async()=>{
 const { exportDiagnostics }=await import('../src/diagnostics.ts')
 const h=fixture();const first=await h.run('send',{sessionId:'B',message:'PRIVATE-business-task'})
 const reply=await h.run('send',{sessionId:'A',message:'PRIVATE-business-result',replyTo:first.messageId},'B')
 await assert.rejects(h.run('send',{sessionId:'B',message:'PRIVATE-third-attempt'}),/terminal/)
 const before=h.effects.length, packageA=await exportDiagnostics(h.ctx,'A',['B'])
 assert.equal(h.effects.length,before,'export must not send or load agents')
 const rows=packageA.sessions.flatMap(s=>s.records)
 const denied=rows.find(r=>r.stage==='hop-check'&&r.attemptedHop===3)
 assert.ok(denied);assert.equal(denied.parentHop,2);assert.equal(denied.hopLimit,2)
 assert.equal(denied.rootMessageId,first.rootMessageId);assert.equal(denied.delivery,'not-sent')
 assert.ok(rows.some(r=>r.stage==='accepted'&&r.messageId===reply.messageId&&r.hopCount===2))
 assert.ok(rows.some(r=>r.stage==='failed'&&r.reason==='legacy-terminal'))
 assert.ok(!JSON.stringify(packageA).includes('PRIVATE-'))
 assert.equal(packageA.sessions[0].persistence,'flushed')
})
await test('diagnostics export survives native persistence without resuming or restoring reply authority',async()=>{
 const { exportDiagnostics }=await import('../src/diagnostics.ts')
 const h=fixture();await h.run('send',{sessionId:'B',message:'business'})
 h.agents.delete('A')
 const exported=await exportDiagnostics(h.ctx,'B',['A'])
 assert.ok(exported.sessions.find(s=>s.sessionId==='A').records.some(r=>r.stage==='accepted'))
 assert.equal(h.agents.has('A'),false)
 assert.ok(h.effects.some(e=>e[0]==='close'&&e[1]==='A'))
})
await test('diagnostics storage failure cannot hide delivery outcome or leak error details',async()=>{
 const h=fixture();h.setAnswer(async()=>{throw Error('approval unavailable PRIVATE-CREDENTIAL')})
 const { exportDiagnostics }=await import('../src/diagnostics.ts')
 await assert.rejects(h.run('send',{sessionId:'B',message:'PRIVATE-body'}),/PRIVATE-CREDENTIAL/)
 const exported=await exportDiagnostics(h.ctx,'A')
 assert.ok(!JSON.stringify(exported).includes('PRIVATE'))
 assert.ok(exported.sessions[0].records.some(r=>r.stage==='failed'))
 h.setAnswer(async()=> 'allowed-once');h.human('A')
 h.setFlush(async session=>pluginRecordOf(session.snapshotEvents().at(-1))?.type!=='plugin:dsh-session-coordinator/diagnostic')
 const result=await h.run('send',{sessionId:'B',message:'actual-delivery'})
 assert.equal(result.accepted,true)
 assert.equal((await exportDiagnostics(h.ctx,'A')).sessions[0].persistence,'unavailable')
})

await test('a transport exception cannot be mislabeled as a pre-send policy denial',async()=>{
 const {exportDiagnostics}=await import('../src/diagnostics.ts');const h=fixture()
 h.agents.get('B').steer=()=>{throw Error('approval rejected PRIVATE-after-submission')}
 await assert.rejects(h.run('send',{sessionId:'B',message:'PRIVATE-business'}),/PRIVATE-after-submission/)
 const dump=await exportDiagnostics(h.ctx,'A'),rows=dump.sessions[0].records
 assert.ok(rows.some(r=>r.stage==='submit-started'))
 assert.equal(rows.find(r=>r.stage==='failed').delivery,'unknown')
 assert.ok(!JSON.stringify(dump).includes('PRIVATE'))
})


await test('diagnostics retain unknown durability and manual post-submit failures',async()=>{
 const {exportDiagnostics}=await import('../src/diagnostics.ts');const h=fixture()
 h.setFlush(async session=>session.id!=='B')
 const result=await h.run('send',{sessionId:'B',message:'PRIVATE-message'})
 assert.equal(result.accepted,true,'preserve legacy live acceptance contract')
 let dump=await exportDiagnostics(h.ctx,'A')
 assert.ok(dump.sessions[0].records.some(r=>r.stage==='transport-returned'&&r.delivery==='unknown'))
 assert.ok(!dump.sessions[0].records.some(r=>r.stage==='accepted'))
 const other=fixture();other.agents.get('B').steer=()=>{throw Error('approval rejected PRIVATE-transport')}
 const command=await other.env.delivery.fromCommand('A',JSON.stringify({requestId:'manual-unknown-1',sessionId:'B',mode:'steer',message:'PRIVATE-manual'}))
 assert.equal(command.kind,'error')
 dump=await exportDiagnostics(other.ctx,'A')
 assert.equal(dump.sessions[0].records.find(r=>r.stage==='failed').delivery,'unknown')
 assert.ok(!JSON.stringify(dump).includes('PRIVATE'))
})


await test('pre-submit cancellation and invalid targets are known not-sent attempts, never transport unknown',async()=>{
 const {exportDiagnostics}=await import('../src/diagnostics.ts')
 for(const args of [{sessionId:'/PRIVATE/path',message:'PRIVATE-body'},{sessionId:'B',message:'PRIVATE-body'}]){
  const h=fixture(),cancelled=args.sessionId==='B'
  await assert.rejects(h.run('send',args,'A',{signal:cancelled?AbortSignal.abort():new AbortController().signal}))
  const rows=(await exportDiagnostics(h.ctx,'A')).sessions[0].records
  const failed=rows.find(r=>['failed','cancelled'].includes(r.stage))
  assert.ok(failed);assert.equal(failed.delivery,'not-sent')
  assert.ok(!rows.some(r=>r.stage==='submit-started'))
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'))
 }
})
console.log(count+' single-delegation groups passed')
