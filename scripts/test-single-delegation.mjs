import assert from 'node:assert/strict'
import { pluginRecordOf, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createGrants } from '../src/coordinate.ts'
import { exportDiagnostics } from '../src/diagnostics.ts'
let count=0
const test=async(name,fn)=>{await fn();console.log('PASS '+name);count++}
import { fixture } from './fixtures/session-tools.mjs'
import {legacyHistory} from './fixtures/legacy-history.mjs'
const legacyFixture=()=>{const h=fixture();legacyHistory(h.agents.get('A'));return h}
await test('new and existing targets: one approval, same verified reply chain, no broad grant',async()=>{
 for(const name of ['create','send']){
 const h=legacyFixture();const task=await h.run(name,name==='create'?{prompt:'evaluate'}:{sessionId:'B',message:'evaluate'})
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
 const h=legacyFixture();h.setAnswer(async()=>outcome)
 await assert.rejects(h.run(name,name==='create'?{prompt:'task'}:{sessionId:'B',message:'task'}),/not authorized/);assert.equal(h.effects.length,0)
 }
 const h=legacyFixture();h.ctx.get=()=>undefined;await assert.rejects(h.run('create',{prompt:'task'}),/unavailable/);assert.equal(h.effects.length,0)
 const a=legacyFixture(),abort=new AbortController();a.setAnswer(async()=>{abort.abort();return 'allowed-once'})
 await assert.rejects(a.run('create',{prompt:'task'},'A',{signal:abort.signal}));assert.equal(a.effects.length,0)
})
await test('existing grant bypasses approval; invalid reply never asks for a new authorization',async()=>{
 const h=legacyFixture();h.grants.grant('A',['B']);await h.run('send',{sessionId:'B',message:'task'})
 assert.equal(h.approvals.length,0);await assert.rejects(h.run('send',{sessionId:'A',message:'reply',replyTo:'forged'},'B'),/incoming task/);assert.equal(h.approvals.length,0)
 await assert.rejects(h.run('create',{prompt:'delegate again'},'B'),/incoming collaboration/)
})
await test('revocation while approval pending prevents create/send; payload stays the approved snapshot',async()=>{
 for(const name of ['create','send']){const h=legacyFixture();h.setAnswer(async()=>{h.env.delivery.revoke('A');return 'allowed-once'})
 await assert.rejects(h.run(name,name==='create'?{prompt:'task'}:{sessionId:'B',message:'task'}),/authorization changed/);assert.equal(h.effects.length,0)}
 const h=legacyFixture(),args={sessionId:'B',message:'original'};h.setAnswer(async()=>{args.message='changed';args.sessionId='C';return 'allowed-once'})
 await h.run('send',args);assert.equal(h.effects[0][1],'B');assert.match(h.effects[0][2].content[0].text,/original$/)
})
await test('create reservation and duplicate call prevent second creation; failed flush has no create effect',async()=>{
 const h=legacyFixture();await h.run('create',{prompt:'task'},'A',{callId:'stable'})
 await assert.rejects(h.run('create',{prompt:'task'},'A',{callId:'stable'}),/already reserved/)
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1)
 const f=legacyFixture();f.setFlush(async()=>false);await assert.rejects(f.run('create',{prompt:'task'}),/durability/);assert.equal(f.effects.length,0)
 const g=legacyFixture();g.setFlush(async()=>{throw Error('disk failure')});await assert.rejects(g.run('create',{prompt:'task'}),/disk failure/);assert.equal(g.effects.length,0)
})
await test('cancel after creation reports identity and does not send or delete the new session',async()=>{
 const h=legacyFixture(),abort=new AbortController(),create=h.ctx.agents.create
 h.ctx.agents.create=async o=>{const result=await create(o);abort.abort();return result}
 await assert.rejects(h.run('create',{prompt:'task'},'A',{signal:abort.signal}),/creationConfirmed=true/)
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1);assert.equal(h.effects.filter(e=>e[0]==='send').length,0)
})
await test('reload recovers only complete two-sided evidence, never reauthorizes or wakes agents',async()=>{
 const h=legacyFixture(),task=await h.run('send',{sessionId:'B',message:'task'})
 await h.run('send',{sessionId:'A',message:'answer\nline two',replyTo:task.messageId},'B');h.reload()
 const before=h.effects.length;const result=await h.run('wait',{sessionId:'B',requestId:task.messageId})
 assert.equal(result.reply.recovered,true);assert.equal(result.reply.message.text,'answer\nline two');assert.equal(h.effects.length,before)
 await assert.rejects(h.run('send',{sessionId:'A',message:'old reply',replyTo:task.messageId},'B'),/incoming task/)
})
await test('offline reconciliation is read-only and closes handles; missing or conflicting facts refuse',async()=>{
 const h=legacyFixture(),task=await h.run('send',{sessionId:'B',message:'task'})
 await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');h.reload();h.agents.delete('B')
 assert.equal((await h.run('wait',{sessionId:'B',requestId:task.messageId})).reply.recovered,true)
 assert.ok(h.effects.some(e=>e[0]==='close'&&e[1]==='B'))
 const log=h.durable.get('B');log.events=log.events.filter(e=>pluginRecordOf(e)?.type!=='plugin:dsh-session-coordinator/delivery')
 await assert.rejects(h.run('wait',{sessionId:'B',requestId:task.messageId}),/evidence unavailable/)
})
await test('new target waits for correlated reply without relying on assistant text',async()=>{
 const h=legacyFixture(),create=h.ctx.agents.create;let replyWork
 h.ctx.agents.create=async o=>{const result=await create(o);const steer=result.agent.steer.bind(result.agent);result.agent.steer=m=>{steer(m);replyWork=Promise.resolve().then(()=>h.run('send',{sessionId:'A',message:'42',replyTo:m.id},o.sessionId))};return result}
 const result=await h.run('create',{prompt:'calculate',waitForReply:true,timeoutMs:500})
 await replyWork;assert.equal(result.reply.received,true);assert.equal(result.reply.message.text,'42')
})
await test('G5 snapshot still blocks completion; explicit human followup starts a fresh approval',async()=>{
 const h=legacyFixture(),task=await h.run('send',{sessionId:'B',message:'task'}),b=h.agents.get('B')
 b.session.append('user/message',{id:'snapshot',role:'user',source:{kind:'plugin:test',form:'snapshot',sections:[]},content:[{type:'text',text:'context'}]},{surfaceOp:'append'})
 await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');assert.ok(!h.effects.some(e=>e[0]==='conclude'))
 h.human('A');await h.run('send',{targets:['B'],content:'next task'});assert.equal(h.approvals.length,2)
})
await test('recovery refuses unknown versions, conflicting admissions, and fork-inherited evidence',async()=>{
 for(const scenario of ['version','conflict','inherited']){
  const h=legacyFixture(),task=await h.run('send',{sessionId:'B',message:'task'})
  await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');h.reload()
  const b=h.agents.get('B')
  if(scenario==='version'){
   const record=b.session.snapshotEvents().map(pluginRecordOf).find(r=>r?.type==='plugin:dsh-session-coordinator/delivery')
   appendPluginRecord(b.session,record.type,{...record.data,version:999})
  }else if(scenario==='conflict'){
   const root=b.session.snapshotEvents().find(e=>e.type==='user/message').data
   b.session.append('agent/inbox/spliced',{target:'next-turn',start:0,deleteCount:0,inserted:[{...root,content:[{type:'text',text:'changed'}]}]})
  }else{
   // Freeze the saved log before constructing inherited evidence; pending audit
   // flushes still belong to the original owned session, not this fork fixture.
   await exportDiagnostics(h.ctx,'B')
   h.agents.delete('B');h.durable.get('B').inheritedEventCount=h.durable.get('B').events.length
  }
  await assert.rejects(h.run('wait',{sessionId:'B',requestId:task.messageId}),/evidence unavailable/)
 }
})
await test('reload cancellation returns aborted without restoring or sending; handles close on read errors',async()=>{
 const h=legacyFixture(),task=await h.run('send',{sessionId:'B',message:'task'})
 await h.run('send',{sessionId:'A',message:'answer',replyTo:task.messageId},'B');h.reload()
 const abort=new AbortController();abort.abort();const before=h.effects.length
 assert.equal((await h.run('wait',{sessionId:'B',requestId:task.messageId},'A',{signal:abort.signal})).reply.aborted,true)
 assert.equal(h.effects.length,before)
 h.agents.delete('B');let closed=false;h.ctx.sessionPersistence.open=async()=>({header:{id:'B'},inheritedEventCount:0,read:async()=>{throw Error('storage failure')},close:async()=>{closed=true}})
 await assert.rejects(h.run('wait',{sessionId:'B',requestId:task.messageId}),/evidence unavailable/);assert.equal(closed,true)
})
await test('repeated panel request after reload cannot silently redeliver; delivered result survives later flush failure',async()=>{
 const h=legacyFixture(),raw=JSON.stringify({requestId:'stable-panel-request',sessionId:'B',message:'task',mode:'steer'})
 assert.equal((await h.env.delivery.fromCommand('A',raw)).kind,'success')
 const before=h.effects.filter(e=>e[0]==='send').length
 const {SessionDelivery}=await import('../src/delivery.ts');const reload=new SessionDelivery(h.ctx,{touch(){}},createGrants())
 assert.equal((await reload.fromCommand('A',raw)).kind,'error');assert.equal(h.effects.filter(e=>e[0]==='send').length,before)
 const f=legacyFixture();let n=0;f.setFlush(async()=>{if(++n===2)throw Error('post-delivery failure');return true})
 const originalWarn=console.warn;console.warn=()=>{}
 try {const sent=await f.run('send',{sessionId:'B',message:'task'});assert.equal(sent.accepted,true);assert.equal(f.effects.filter(e=>e[0]==='send').length,1)}finally{console.warn=originalWarn}
})


await test('diagnostics retain legacy attempt hops including terminal refusal without business text', async()=>{
 const { exportDiagnostics }=await import('../src/diagnostics.ts')
 const h=legacyFixture();const first=await h.run('send',{sessionId:'B',message:'PRIVATE-business-task'})
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
 const h=legacyFixture();await h.run('send',{sessionId:'B',message:'business'})
 h.agents.delete('A')
 const exported=await exportDiagnostics(h.ctx,'B',['A'])
 assert.ok(exported.sessions.find(s=>s.sessionId==='A').records.some(r=>r.stage==='accepted'))
 assert.equal(h.agents.has('A'),false)
 assert.ok(h.effects.some(e=>e[0]==='close'&&e[1]==='A'))
})
await test('diagnostics storage failure cannot hide delivery outcome or leak error details',async()=>{
 const h=legacyFixture();h.setAnswer(async()=>{throw Error('approval unavailable PRIVATE-CREDENTIAL')})
 const { exportDiagnostics }=await import('../src/diagnostics.ts')
 await assert.rejects(h.run('send',{sessionId:'B',message:'PRIVATE-body'}),/PRIVATE-CREDENTIAL/)
 const exported=await exportDiagnostics(h.ctx,'A')
 assert.ok(!JSON.stringify(exported).includes('PRIVATE'))
 assert.ok(exported.sessions[0].records.some(r=>r.stage==='failed'))
 h.setAnswer(async()=> 'allowed-once');h.human('A');legacyHistory(h.agents.get('A'))
 h.setFlush(async session=>pluginRecordOf(session.snapshotEvents().at(-1))?.type!=='plugin:dsh-session-coordinator/diagnostic')
 const result=await h.run('send',{sessionId:'B',message:'actual-delivery'})
 assert.equal(result.accepted,true)
 assert.equal((await exportDiagnostics(h.ctx,'A')).sessions[0].persistence,'unavailable')
})

await test('a transport exception cannot be mislabeled as a pre-send policy denial',async()=>{
 const {exportDiagnostics}=await import('../src/diagnostics.ts');const h=legacyFixture()
 h.agents.get('B').steer=()=>{throw Error('approval rejected PRIVATE-after-submission')}
 await assert.rejects(h.run('send',{sessionId:'B',message:'PRIVATE-business'}),/PRIVATE-after-submission/)
 const dump=await exportDiagnostics(h.ctx,'A'),rows=dump.sessions[0].records
 assert.ok(rows.some(r=>r.stage==='submit-started'))
 assert.equal(rows.find(r=>r.stage==='failed').delivery,'unknown')
 assert.ok(!JSON.stringify(dump).includes('PRIVATE'))
})


await test('diagnostics retain unknown durability and manual post-submit failures',async()=>{
 const {exportDiagnostics}=await import('../src/diagnostics.ts');const h=legacyFixture()
 h.setFlush(async session=>session.id!=='B')
 const result=await h.run('send',{sessionId:'B',message:'PRIVATE-message'})
 assert.equal(result.accepted,true,'preserve legacy live acceptance contract')
 let dump=await exportDiagnostics(h.ctx,'A')
 assert.ok(dump.sessions[0].records.some(r=>r.stage==='transport-returned'&&r.delivery==='unknown'))
 assert.ok(!dump.sessions[0].records.some(r=>r.stage==='accepted'))
 const other=legacyFixture();other.agents.get('B').steer=()=>{throw Error('approval rejected PRIVATE-transport')}
 const command=await other.env.delivery.fromCommand('A',JSON.stringify({requestId:'manual-unknown-1',sessionId:'B',mode:'steer',message:'PRIVATE-manual'}))
 assert.equal(command.kind,'error')
 dump=await exportDiagnostics(other.ctx,'A')
 assert.equal(dump.sessions[0].records.find(r=>r.stage==='failed').delivery,'unknown')
 assert.ok(!JSON.stringify(dump).includes('PRIVATE'))
})


await test('pre-submit cancellation and invalid targets are known not-sent attempts, never transport unknown',async()=>{
 const {exportDiagnostics}=await import('../src/diagnostics.ts')
 for(const args of [{sessionId:'/PRIVATE/path',message:'PRIVATE-body'},{sessionId:'B',message:'PRIVATE-body'}]){
  const h=legacyFixture(),cancelled=args.sessionId==='B'
  await assert.rejects(h.run('send',args,'A',{signal:cancelled?AbortSignal.abort():new AbortController().signal}))
  const rows=(await exportDiagnostics(h.ctx,'A')).sessions[0].records
  const failed=rows.find(r=>['failed','cancelled'].includes(r.stage))
  assert.ok(failed);assert.equal(failed.delivery,'not-sent')
  assert.ok(!rows.some(r=>r.stage==='submit-started'))
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'))
 }
})
console.log(count+' single-delegation groups passed')

await test('v1.5 existing chat sends and replies through one entry with exact text',async()=>{
 const h=fixture();h.human('A')
 const text='  original\n```js\n1 + 2\n```\n'
 const sent=await h.run('send',{targets:['B'],content:text,requestId:'new-contract-request',authorizationRequest:{participants:['A','B'],purpose:'check once',extent:'message',reply:'once'}})
 assert.equal(sent.results[0].admission,'accepted')
 const message=h.effects.find(e=>e[0]==='send')[2]
 assert.equal(message.source.protocolVersion,2)
 assert.equal(message.content[0].text,text)
 const reply=await h.run('send',{targets:['A'],content:' result\n',replyTo:sent.results[0].messageId,requestId:'new-contract-reply'},'B')
 assert.equal(reply.results[0].admission,'accepted');assert.equal(h.approvals.length,1)
 assert.equal(h.effects.filter(e=>e[0]==='send')[1][2].content[0].text,' result\n')
 const read=await h.run('read',{sessionId:'B'})
 assert.ok(read.messages.some(m=>m.text===text))
})
await test('v1.5 unknown admission reserves reply permission and never retries transport',async()=>{
 const h=fixture();h.human('A')
 const request={targets:['B'],content:'check',requestId:'durable-request',authorizationRequest:{participants:['A','B'],purpose:'check',extent:'message',reply:'once'}}
 const sent=await h.run('send',request);const id=sent.results[0].messageId
 h.setFlush(async s=>s.id!=='A')
 const reply={targets:['A'],content:'answer',replyTo:id,requestId:'durable-response'}
 const result=await h.run('send',reply,'B')
 assert.equal(result.results[0].admission,'unknown')
 assert.deepEqual(await h.run('send',reply,'B'),result)
 const second=await h.run('send',{...reply,requestId:'another-response'},'B')
 assert.equal(second.results[0].admission,'rejected')
 assert.equal(h.effects.filter(e=>e[0]==='send').length,2)
})
await test('v1.5 rejection and structured abort do not write; notifications grant no reply',async()=>{
 for(const kind of ['rejected','cancel']){
  const h=fixture(),abort=new AbortController();h.human('A')
  h.setAnswer(async()=>{if(kind==='cancel')abort.abort({why:'user cancelled'});return kind==='rejected'?'rejected':'allowed-once'})
  const result=await h.run('send',{targets:['B'],content:'notify',requestId:'denied-request'},'A',{signal:abort.signal})
  assert.equal(result.results[0].admission,'rejected');assert.equal(h.effects.length,0)
  assert.ok(!result.results[0].error.message.includes('[object Object]'))
 }
 const h=fixture();h.human('A')
 const sent=await h.run('send',{targets:['B'],content:'notice',requestId:'notice-request'})
 const reply=await h.run('send',{targets:['A'],content:'unsolicited',replyTo:sent.results[0].messageId,requestId:'notice-response'},'B')
 assert.equal(reply.results[0].admission,'rejected');assert.equal(h.effects.length,1)
})
await test('v1.5 stable request rejects content changes and preserves admission after reload',async()=>{
 const h=fixture();h.human('A')
 const request={targets:['B'],content:'notify',requestId:'idempotent-request'}
 const sent=await h.run('send',request)
 assert.deepEqual(await h.run('send',request),sent)
 await assert.rejects(h.run('send',{...request,content:'changed'}),/REQUEST_CONFLICT/)
 h.reload();const repeat=await h.run('send',request)
 assert.equal(repeat.results[0].admission,'accepted')
 assert.equal(repeat.historical,true)
 assert.equal(repeat.communicationHandle,undefined)
 assert.equal(repeat.results[0].messageId,sent.results[0].messageId)
 assert.equal(h.effects.filter(e=>e[0]==='send').length,1)
})
await test('read pages forward without skipping messages and binds cursors to the chat',async()=>{
 const h=fixture();for(let i=0;i<5;i++)h.human('B')
 const first=await h.run('read',{sessionId:'B',limit:2})
 assert.equal(first.messages.length,2);assert.equal(first.truncated,true)
 assert.ok(first.nextCursor);assert.ok(first.messages[0].messageId)
 const second=await h.run('read',{sessionId:'B',limit:2,cursor:first.nextCursor})
 const third=await h.run('read',{sessionId:'B',limit:2,cursor:second.nextCursor})
 assert.equal(new Set([...first.messages,...second.messages,...third.messages].map(m=>m.messageId)).size,5)
 assert.equal(third.truncated,false)
 await assert.rejects(h.run('read',{sessionId:'A',cursor:first.nextCursor}),/cursor/)
 assert.equal(h.effects.length,0)
})
await test('v1.5 retries only known-not-submitted requests without reopening a rejected approval',async()=>{
 const h=fixture();h.human('A');h.ctx.workspaceRegistry.archivedSessionIds=['B']
 const args={targets:['B'],content:'notice',requestId:'retryable-request'}
 assert.equal((await h.run('send',args)).results[0].admission,'rejected')
 h.ctx.workspaceRegistry.archivedSessionIds=[]
 assert.equal((await h.run('send',args)).results[0].admission,'accepted')
 assert.equal(h.effects.filter(e=>e[0]==='send').length,1)
 const denied=fixture();denied.human('A');denied.setAnswer(async()=> 'rejected')
 await denied.run('send',args);await denied.run('send',args)
 assert.equal(denied.approvals.length,1);assert.equal(denied.effects.length,0)
})
await test('direct read tool rendering preserves usable cursor and source identity',async()=>{
 const h=fixture();h.human('A');h.human('A');h.human('A')
 const args={sessionId:'A',limit:1}
 const result=await h.run('read',args)
 const rendered=h.tools.get('session_coordinator_read').output.render(args,result)
 const modelValue=JSON.parse(rendered[0].text)
 assert.equal(modelValue.nextCursor,result.nextCursor)
 assert.equal(modelValue.truncated,true)
 assert.equal(modelValue.messages[0].messageId,result.messages[0].messageId)
 assert.deepEqual(modelValue.messages[0].source,result.messages[0].source)
 const next=await h.run('read',{sessionId:'A',cursor:modelValue.nextCursor,limit:1})
 assert.notEqual(next.messages[0].messageId,modelValue.messages[0].messageId)
})
await test('work permission supports repeated same-entry exchanges without task registration or renewed approval',async()=>{
 const h=fixture();h.human('A')
 let result=await h.run('send',{targets:['B'],content:'Implement the first requirement',requestId:'work-first-message',authorizationRequest:{participants:['A','B'],purpose:'Implement and independently test requirements',extent:'work'}})
 assert.equal(result.results[0].admission,'accepted');assert.ok(result.communicationHandle)
 const handle=result.communicationHandle
 for(let i=0;i<22;i++){
  const sender=i%2===0?'B':'A',target=sender==='B'?'A':'B'
  result=await h.run('send',{targets:[target],content:'Verified business stage '+i,requestId:'work-exchange-'+i,context:{communicationHandle:handle},replyTo:result.results[0].messageId},sender)
  assert.equal(result.results[0].admission,'accepted',JSON.stringify(result))
 }
 assert.equal(h.approvals.length,1);assert.equal(h.effects.filter(e=>e[0]==='send').length,23)
 assert.equal(h.effects.at(-1)[2].source.communicationHandle,handle)
 h.reload()
 const expired=await h.run('send',{targets:['B'],content:'must not resume old rights',requestId:'work-after-reload',context:{communicationHandle:handle}})
 assert.equal(expired.results[0].admission,'rejected');assert.equal(h.approvals.length,1)
})
await test('work authorization cannot expand one-reply, bypass rejection, or escape a scoped task budget',async()=>{
 const request={targets:['B'],content:'work',requestId:'work-negative-case',authorizationRequest:{participants:['A','B'],purpose:'ship',extent:'work'}}
 const denied=fixture();denied.human('A');denied.setAnswer(async()=> 'rejected')
 assert.equal((await denied.run('send',request)).results[0].admission,'rejected')
 assert.equal((await denied.run('send',{...request,requestId:'work-negative-again'})).results[0].admission,'rejected');assert.equal(denied.approvals.length,1)
 const h=fixture();h.human('A')
 const once=await h.run('send',{targets:['B'],content:'once only',requestId:'once-not-work',authorizationRequest:{participants:['A','B'],purpose:'once',extent:'message',reply:'once'}})
 const upgrade=await h.run('send',{...request,targets:['A'],requestId:'upgrade-to-work'},'B')
 assert.equal(upgrade.results[0].admission,'rejected');assert.equal(h.approvals.length,1)
 h.agents.get('A').session.append('user/message',{id:'scoped-input',role:'user',source:{kind:'session-collaboration',scopeId:'scope-budget-exhausted',taskId:'task-1'},content:[{type:'text',text:'existing budgeted task'}]},{surfaceOp:'append'})
 const escape=await h.run('send',request)
 assert.equal(escape.results[0].admission,'rejected');assert.match(escape.results[0].error.message,/budgets/);assert.equal(h.approvals.length,1)
 assert.equal(h.effects.filter(e=>e[0]==='send').length,1)
})
await test('matching work permission is reused and withdrawal while approving prevents submission',async()=>{
 const h=fixture();h.human('A')
 const request={targets:['B'],content:'first',requestId:'work-reuse-first',authorizationRequest:{participants:['A','B'],purpose:'ship',extent:'work'}}
 const first=await h.run('send',request)
 const second=await h.run('send',{...request,content:'next business stage',requestId:'work-reuse-second'})
 assert.equal(second.results[0].admission,'accepted');assert.equal(first.communicationHandle,second.communicationHandle);assert.equal(h.approvals.length,1)
 h.env.delivery.revoke('A')
 assert.equal((await h.run('send',{targets:['A'],content:'late',requestId:'work-revoked-reply',context:{communicationHandle:first.communicationHandle}},'B')).results[0].admission,'rejected')
 const f=fixture();f.human('A');f.setAnswer(async()=>{f.env.delivery.revoke('A');return 'allowed-once'})
 assert.equal((await f.run('send',request)).results[0].admission,'rejected');assert.equal(f.effects.length,0)
})
await test('work context inference rejects ambiguity and a forged handle never asks for permission',async()=>{
 const h=fixture();h.human('A')
 const grant=async(purpose,id)=>h.run('send',{targets:['B'],content:purpose,requestId:id,authorizationRequest:{participants:['A','B'],purpose,extent:'work'}})
 const one=await grant('review module one','module-one-work');const two=await grant('review module two','module-two-work')
 assert.notEqual(one.communicationHandle,two.communicationHandle)
 const ambiguous=await h.run('send',{targets:['A'],content:'unclear work',requestId:'ambiguous-work-reply'},'B')
 assert.equal(ambiguous.results[0].admission,'rejected');assert.match(ambiguous.results[0].error.message,/AUTHORIZATION_AMBIGUOUS/)
 const forged=await h.run('send',{targets:['A'],content:'forged permission',requestId:'forged-work-reply',context:{communicationHandle:'communication-made-up'}},'B')
 assert.equal(forged.results[0].admission,'rejected');assert.equal(h.approvals.length,2)
 const chosen=await h.run('send',{targets:['A'],content:'review module one complete',requestId:'selected-work-reply',context:{communicationHandle:one.communicationHandle},replyTo:one.results[0].messageId},'B')
 assert.equal(chosen.results[0].admission,'accepted');assert.equal(h.approvals.length,2)
})
await test('work unknown admission is not replayed and caller cancellation does not revoke prior permission',async()=>{
 const h=fixture();h.human('A')
 const first=await h.run('send',{targets:['B'],content:'begin',requestId:'work-unknown-first',authorizationRequest:{participants:['A','B'],purpose:'business',extent:'work'}})
 const request={targets:['A'],content:'business answer',requestId:'work-unknown-reply',context:{communicationHandle:first.communicationHandle},replyTo:first.results[0].messageId}
 h.setFlush(async s=>s.id!=='A')
 const unknown=await h.run('send',request,'B');assert.equal(unknown.results[0].admission,'unknown')
 assert.deepEqual(await h.run('send',request,'B'),unknown);assert.equal(h.effects.filter(e=>e[0]==='send').length,2)
 h.setFlush(async()=>true)
 const cancelled=await h.run('send',{targets:['B'],content:'cancel this send',requestId:'work-one-cancel',context:{communicationHandle:first.communicationHandle}},'A',{signal:AbortSignal.abort({reason:'caller cancelled'})})
 assert.equal(cancelled.results[0].error.code,'CANCELLED')
 assert.equal((await h.run('send',{targets:['B'],content:'next authorized stage',requestId:'work-after-cancel',context:{communicationHandle:first.communicationHandle}})).results[0].admission,'accepted')
 assert.equal(h.approvals.length,1)
})
await test('an explicit single-message purpose never silently inherits an incoming work permission',async()=>{
 const h=fixture();h.human('A')
 const work=await h.run('send',{targets:['B'],content:'review only',requestId:'work-purpose-first',authorizationRequest:{participants:['A','B'],purpose:'review only',extent:'work'}})
 const single=await h.run('send',{targets:['A'],content:'a distinct notice',requestId:'explicit-new-purpose',authorizationRequest:{participants:['A','B'],purpose:'different purpose',extent:'message',reply:'none'}},'B')
 assert.equal(single.results[0].admission,'accepted');assert.equal(single.communicationHandle,undefined)
 assert.equal(h.approvals.length,2)
 const response=await h.run('send',{targets:['B'],content:'unapproved reply',requestId:'explicit-notice-response',replyTo:single.results[0].messageId})
 assert.equal(response.results[0].admission,'rejected')
 assert.ok(work.communicationHandle)
})
await test('an explicit independent work handle remains usable alongside unrelated scoped task input',async()=>{
 const h=fixture();h.human('A')
 const first=await h.run('send',{targets:['B'],content:'independent work',requestId:'independent-work-first',authorizationRequest:{participants:['A','B'],purpose:'independent review',extent:'work'}})
 h.agents.get('A').session.append('user/message',{id:'other-task-result',role:'user',source:{kind:'session-collaboration',scopeId:'other-budgeted-scope',taskId:'other-task'},content:[{type:'text',text:'unrelated task result'}]},{surfaceOp:'append'})
 const next=await h.run('send',{targets:['B'],content:'continue independent review',requestId:'independent-work-next',context:{communicationHandle:first.communicationHandle}})
 assert.equal(next.results[0].admission,'accepted',JSON.stringify(next));assert.equal(h.approvals.length,1)
 const unbound=await h.run('send',{targets:['B'],content:'ambiguous bound context',requestId:'unbound-budget-work'})
 assert.equal(unbound.results[0].admission,'rejected');assert.equal(h.effects.filter(e=>e[0]==='send').length,2)
})
