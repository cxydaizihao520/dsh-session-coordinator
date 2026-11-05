import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fixture} from './fixtures/session-tools.mjs'
import {reconcileReply} from '../src/coordination-records.ts'

test('fresh chats have no legacy workflow constructor or rejected cancellation entry',()=>{
 const h=fixture()
 for(const name of ['collaboration_start','cancel'])assert.equal(h.tools.has('session_coordinator_'+name),false,name)
 for(const name of ['find','read','create','send','wait','status','control','task','collaboration_material'])assert.ok(h.tools.has('session_coordinator_'+name),name)
})

test('optional question and deadline tools expose their modern contract without legacy ordinary routes',()=>{
 const h=fixture(),question=h.tools.get('session_coordinator_question'),deadline=h.tools.get('session_coordinator_schedule')
 assert.deepEqual(question.parameters.properties.action.enum,['question'])
 assert.ok(question.parameters.required.includes('taskHandle'))
 assert.equal(question.parameters.properties.scopeId,undefined)
 assert.ok(deadline.parameters.properties.notBefore)
 assert.ok(deadline.parameters.required.includes('taskHandle'))
 assert.equal(deadline.parameters.properties.scopeId,undefined)
})

test('ordinary create/send/wait schemas and direct dispatch reject legacy argument shapes',async()=>{
 const h=fixture()
 for(const [name,args,fields] of [['create',{prompt:'legacy task'},['prompt','replyHandling','waitForReply','timeoutMs']],['send',{sessionId:'B',message:'legacy send'},['sessionId','sessionIds','message','intent','mode','waitForReply','retryFailed']],['wait',{sessionId:'B',sinceSeq:0},['sessionId','requestId','sinceSeq','requireTurnEnd','waitFor']]]){
  const definition=h.tools.get('session_coordinator_'+name)
  for(const field of fields)assert.equal(definition.parameters.properties[field],undefined,`${name}.${field}`)
  await assert.rejects(h.run(name,args),/legacy|Legacy/)
 }
})

import {surfaceFixture} from './fixtures/session-tool-surface.mjs'

test('status queries a historical message live or offline through the shared receipt reader',async()=>{
 const h=fixture();h.human('A')
 const sent=await h.run('send',{targets:['B'],content:'one notification'})
 const args={sessionId:'B',messageId:sent.results[0].messageId}
 const live=await h.run('status',args)
 assert.equal(live.status,'appended');assert.equal(live.historical,true);assert.equal(live.live,true)
 const before=h.effects.length
 await h.ctx.sessions.flush(h.agents.get('B').session);h.agents.delete('B')
 const offline=await h.run('status',args)
 assert.equal(offline.live,false);assert.deepEqual(offline.evidence,live.evidence)
 assert.equal(offline.status,'appended');assert.equal(offline.historical,true)
 const unknown=await h.run('status',{sessionId:'B',messageId:'not-a-real-message'})
 assert.equal(unknown.status,'unknown');assert.equal(unknown.communicationHandle,undefined)
 assert.deepEqual(JSON.parse(h.tools.get('session_coordinator_status').output.render({},offline)[0].text),offline)
 assert(h.effects.slice(before).every(effect=>effect[0]==='close'),'read-only inspection must not wake the target')
 await assert.rejects(h.run('status',{taskId:'stored-task',messageId:args.messageId}),/messageId requires.*sessionId/)
})

test('read pages completed segments without skipping the remaining outputs or exposing reasoning',async()=>{
 const h=fixture(),b=h.agents.get('B')
 for(const text of ['first output','second output'])b.session.append('assistant/message',{turn:0,step:1,message:{role:'assistant',content:[{type:'reasoning',text:'private reasoning'},{type:'text',text}]}},{surfaceOp:'append'})
 const first=await h.run('read',{sessionId:'B',view:'segments',limit:1})
 assert.deepEqual(first.segments.map(x=>x.text),['first output']);assert.equal(first.truncated,true)
 assert.equal(first.segments[0].reasoning,undefined)
 const second=await h.run('read',{sessionId:'B',view:'segments',sinceSeq:first.nextCursorSeq,limit:1})
 assert.deepEqual(second.segments.map(x=>x.text),['second output']);assert.equal(second.truncated,false)
 const legacy=await h.run('segments',{sessionId:'B',limit:1})
 assert.deepEqual(legacy.segments.map(x=>x.text),['first output']);assert.equal(legacy.nextCursorSeq,first.nextCursorSeq)
 assert.deepEqual(h.effects,[])
 await assert.rejects(h.run('read',{sessionId:'B',view:'segments',role:'user'}),/segments.*sinceSeq/)
})

test('native schema and dispatch hide duplicate read aliases while genuine old chats retain them',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A'),b=h.agents.get('B'),c=h.agents.get('C')
 for(const agent of [a,b,c])for(const name of ['segments','message_status']){
  const full='session_coordinator_'+name
  assert.equal(h.tools.get(full,agent),undefined)
  assert(!h.tools.sdkSchemas(agent).some(tool=>tool.name===full))
 }
 assert.equal((await h.invoke('message_status',{sessionId:'B',messageId:'unknown'})).isError,true)
 await h.legacy()
 for(const agent of [a,b])for(const name of ['segments','message_status'])assert.ok(h.tools.get('session_coordinator_'+name,agent))
 assert.equal(h.tools.get('session_coordinator_segments',c),undefined)
 const deny=b.ctx.tools.restrict({deny:['session_coordinator_segments']});h.env.toolSurface.refresh()
 assert.equal(h.tools.get('session_coordinator_segments',b),undefined);deny()
 const result=await h.run('status',{sessionId:'B',messageId:'unknown'},'C')
 assert.equal(result.status,'unknown');assert.equal(result.historical,true)
})

test('native schemas SDK and dispatch expose legacy tools only to genuine scope members',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A'),b=h.agents.get('B'),c=h.agents.get('C')
 let teamCalls=0;h.ctx.tools.register({name:'native_team',description:'unrelated native capability',parameters:{},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},async execute(){teamCalls++;return 'team preserved'}})
 for(const agent of [a,b,c]){assert.equal(h.tools.get('session_coordinator_collaboration_start',agent),undefined);assert.equal(h.tools.get('session_coordinator_collaboration_task',agent),undefined);assert.ok(h.tools.schemas(agent).some(x=>x.name==='native_team'))}
 assert.equal((await h.invoke('collaboration_task',{scopeId:'invented',objective:'wrong',members:['B']})).isError,true)
 const scope=await h.legacy()
 for(const agent of [a,b])assert.ok(h.tools.sdkSchemas(agent).some(x=>x.name==='session_coordinator_collaboration_task'))
 assert.equal(h.tools.get('session_coordinator_collaboration_task',c),undefined)
 const task=await h.run('collaboration_task',{scopeId:scope.id,objective:'old work continues',members:['B']})
 const operation=await h.run('collaboration_send',{scopeId:scope.id,taskId:task.id,taskRevision:1,sessionId:'B',intent:'task',message:'actual legacy business work'})
 assert.equal(operation.status,'submitted');assert.equal(h.effects.at(-1).message.content[0].text,'actual legacy business work')
 const team=await h.tools.execute({...h.exec(),name:'native_team',arguments:{}});assert.equal(team.isError,false);assert.equal(teamCalls,1)
 const cached=h.tools.get('session_coordinator_collaboration_task',a)
 await h.run('collaboration_control',{scopeId:scope.id,action:'cancel',reason:'close this old scope'})
 assert.equal(h.tools.get('session_coordinator_collaboration_task',a),undefined)
 assert.ok(h.tools.get('session_coordinator_collaboration_status',a),'terminal history remains readable')
 await assert.rejects(cached.execute({scopeId:scope.id,objective:'cached old schema',members:['B']},h.exec()),/unavailable/)
 assert.equal((await h.invoke('collaboration_task',{scopeId:scope.id,objective:'late call',members:['B']})).isError,true)
})

test('a mixed chat cannot use its legacy adapter to write a modern work scope by raw coordinates',async t=>{
 const h=await surfaceFixture(t);await h.legacy()
 const work=await h.run('send',{targets:['B'],content:'modern collaboration',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'modern independently controlled work'}})
 const task=await h.run('task',{communicationHandle:work.communicationHandle,objective:'modern task',members:['B'],requestId:'mixed-modern-task'})
 const scope=(await h.run('collaboration_status',{})).scopes.find(scope=>scope.communicationHandle===work.communicationHandle)
 const approvals=h.approvals.length,effects=h.effects.length
 for(const [name,args] of [['task',{scopeId:scope.id,objective:'bypass request identity',members:['B']}],['send',{scopeId:scope.id,taskId:task.id,taskRevision:1,sessionId:'B',message:'bypass handle'}],['control',{scopeId:scope.id,taskId:task.id,action:'pause',reason:'bypass current task reference'}],['result',{scopeId:scope.id,taskId:task.id,taskRevision:1,operationId:'invented',text:'wrong result'}]]){
  const result=await h.invoke('collaboration_'+name,args)
  assert.equal(result.isError,true,name)
  assert.match(JSON.stringify(result),/current.*taskHandle|modern.*scope/i,name)
 }
 assert.equal(h.approvals.length,approvals);assert.equal(h.effects.length,effects)
 assert.equal((await h.run('status',{taskHandle:task.taskHandle})).state,'active')
})

test('a native surface disposal failure cannot skip durable task cancellation or its material abort',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A'),native=a.ctx.tools;let fault=false
 a.ctx={tools:{restrict(definition){const dispose=native.restrict(definition);return()=>{if(fault)throw Error('native scoped disposal unavailable');return dispose()}}}}
 const scope=await h.legacy(),task=await h.run('collaboration_task',{scopeId:scope.id,objective:'cancel independently',members:['B']})
 const material=h.runtime.taskOperation(scope.id,task.id,1,h.exec())
 fault=true
 const result=await h.invoke('collaboration_control',{scopeId:scope.id,action:'cancel',reason:'stop old task without losing cancellation'})
 const aborted=material.signal.aborted;material.release();fault=false;h.env.toolSurface.refresh()
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(aborted,true)
 assert.equal((await h.run('collaboration_status',{scopeId:scope.id})).state,'cancelled')
 assert.equal(h.tools.get('session_coordinator_collaboration_task',a),undefined)
})

import {SessionToolSurface} from "../src/session-tool-surface.ts"
test('compatibility readiness failure does not veto an unrelated native chat step',async t=>{
 const h=await surfaceFixture(t)
 h.env.toolSurface.dispose()
 await h.runtime.close()
 const failure=new Error('legacy storage unavailable')
 const surface=new SessionToolSurface(h.env,Promise.reject(failure),new Map())
 t.after(()=>surface.dispose())
 let entered=false
 const a=h.agents.get('C')
 await assert.doesNotReject(h.ctx.waterfall(a,'agent/pre-step',{agent:a,messages:[],turn:1,step:1,signal:new AbortController().signal},async()=>{entered=true;return {kind:'enter',messages:[]}}))
 assert.equal(entered,true)
})

test('legacy exchange cannot unmask a native inherited deny for ordinary send',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A')
 await h.env.delivery.send({sessionId:'B',message:'old in-flight work'},a,undefined,{authorize:async()=>{}})
 assert.equal(h.env.delivery.hasLegacyExchange(a),true)
 a.ctx.tools.restrict({deny:['session_coordinator_send']})
 assert.equal(h.tools.get('session_coordinator_send',a),undefined)
 h.env.toolSurface.refresh(a)
 assert.equal(h.tools.get('session_coordinator_send',a),undefined,'native deny must remain effective after compatibility refresh')
})


test('persistent compatibility intersects native filters before and after old context',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A'),b=h.agents.get('B')
 const denyA=a.ctx.tools.restrict({deny:['session_coordinator_collaboration_task']})
 const scope=await h.legacy()
 assert.equal(h.tools.get('session_coordinator_collaboration_task',a),undefined)
 assert.ok(h.tools.get('session_coordinator_collaboration_task',b))
 const denyB=b.ctx.tools.restrict({deny:['session_coordinator_collaboration_task']})
 h.env.toolSurface.refresh()
 for(const who of ['A','B'])assert.equal((await h.invoke('collaboration_task',{scopeId:scope.id,objective:'must remain denied',members:['B']},who)).isError,true)
 denyA();h.env.toolSurface.refresh(a)
 assert.ok(h.tools.get('session_coordinator_collaboration_task',a));assert.equal(h.tools.get('session_coordinator_collaboration_task',b),undefined)
 denyB()
})

test('a real legacy one-reply input remains replyable through the modern send schema',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A'),b=h.agents.get('B')
 const original=await h.env.delivery.send({sessionId:'B',message:'old one reply'},a,undefined,{authorize:async()=>{}})
 const message=b.inbox.nextStep[0];b.session.append('user/message',message,{surfaceOp:'append'})
 const reply=await h.run('send',{targets:['A'],content:'  preserved reply  ',replyTo:original.messageId},'B')
 assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply))
 assert.equal(h.effects.at(-1).message.content[0].text,'  preserved reply  ')
 const wire=h.effects.at(-1).message;assert.equal(wire.source.protocolVersion,2);a.session.append('user/message',wire,{surfaceOp:'append'})
 const recovered=await reconcileReply(h.ctx,'A','B',original.messageId,new AbortController().signal)
 assert.equal(recovered.text,'  preserved reply  ')
 const third=await h.run('send',{targets:['B'],content:'third hop',replyTo:wire.id},'A');assert.equal(third.results[0].admission,'rejected')

 const again=await h.run('send',{targets:['A'],content:'extra reply',replyTo:original.messageId},'B')
 assert.equal(again.results[0].admission,'rejected')
})

test('modern scheduled edits keep a versioned task reference and never use raw legacy coordinates',async t=>{
 const h=await surfaceFixture(t);h.ctx.setInterval=()=>1;h.ctx.clearInterval=()=>{}
 const work=await h.run('send',{targets:['B'],content:'work',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'schedule'}})
 const task=await h.run('task',{communicationHandle:work.communicationHandle,objective:'later',members:['B'],requestId:'schedule-current-task'})
 const operation=await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'old',notBefore:Date.now()+3600000,operationId:'scheduled-current-edit'})
 const edit=await h.run('schedule',{taskHandle:task.taskHandle,operationId:operation.id,action:'edit',message:'new',reason:'correct pending instruction'})
 assert.equal(edit.text,'new');assert.equal(edit.status,'scheduled')
 assert.equal(h.approvals.at(-1).toolName,'session_coordinator_schedule')
 assert.doesNotMatch(h.approvals.at(-1).reason,/multiple tasks and rounds/)
 const withdrawn=await h.run('schedule',{taskHandle:task.taskHandle,operationId:operation.id,action:'withdraw',reason:'remove pending instruction'})
 assert.equal(withdrawn.status,'withdrawn')
})


for(const failure of ['flush','submit'])test('modern legacy reply preserves unknown '+failure+' and never replays',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A'),b=h.agents.get('B')
 const parent=await h.env.delivery.send({sessionId:'B',message:'old reply right'},a,undefined,{authorize:async()=>{}})
 b.session.append('user/message',b.inbox.nextStep[0],{surfaceOp:'append'})
 if(failure==='flush')h.ctx.sessions.flush=async session=>session.id!=='A'
 else a.steer=()=>{throw Error('native submit outcome uncertain')}
 const input={targets:['A'],content:'reply',replyTo:parent.messageId,requestId:'legacy-modern-unknown-'+failure}
 const result=await h.run('send',input,'B'),before=h.effects.length
 assert.equal(result.results[0].admission,'unknown',JSON.stringify(result))
 assert.deepEqual(await h.run('send',input,'B'),result);assert.equal(h.effects.length,before)
})


test('independent old once replies do not inherit an unrelated legacy scope or bypass exact targets',async t=>{
 const h=await surfaceFixture(t),b=h.agents.get('B'),c=h.agents.get('C'),scope=await h.legacy()
 const task=await h.run('collaboration_task',{scopeId:scope.id,objective:'old scoped work',members:['B']})
 const op=await h.run('collaboration_send',{scopeId:scope.id,taskId:task.id,taskRevision:1,sessionId:'B',intent:'task',message:'old scope input'})
 b.session.append('user/message',[...b.inbox.nextStep,...b.inbox.nextTurn].find(m=>m.id===op.id),{surfaceOp:'append'})
 const parent=await h.env.delivery.send({sessionId:'B',message:'independent once'},c,undefined,{authorize:async()=>{}})
 b.session.append('user/message',b.inbox.nextStep.find(m=>m.id===parent.messageId),{surfaceOp:'append'})
 const wrong=await h.run('send',{targets:['A'],content:'wrong target',replyTo:parent.messageId},'B');assert.equal(wrong.results[0].admission,'rejected')
 const material=await h.run('send',{targets:['C'],content:[{type:'text',text:'unsupported shape'}],replyTo:parent.messageId},'B');assert.equal(material.results[0].admission,'rejected')
 const stale=await h.run('send',{targets:['C'],content:'stale execution',replyTo:parent.messageId,delivery:'steer',expectedExecution:'not-current'},'B');assert.equal(stale.results[0].admission,'rejected')
 const reply=await h.run('send',{targets:['C'],content:'independent answer',replyTo:parent.messageId},'B');assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply))
})

import {exportDiagnostics} from '../src/diagnostics.ts'
test('renamed modern schedule remains a task operation in diagnostic export',async t=>{
 const h=await surfaceFixture(t);h.ctx.setInterval=()=>1;h.ctx.clearInterval=()=>{}
 const work=await h.run('send',{targets:['B'],content:'work',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'schedule'}})
 const task=await h.run('task',{communicationHandle:work.communicationHandle,objective:'later',members:['B'],requestId:'schedule-current-task'})
 const operation=await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'later',notBefore:Date.now()+3600000})
 const dump=await exportDiagnostics(h.ctx,'A'),row=dump.sessions[0].records.findLast(row=>row.tool==='session_coordinator_schedule'&&row.stage==='returned')
 assert.ok(['persistent','session-work'].includes(row.protocol),'modern optional task must not be marked legacy-single');assert.equal(row.operationId,operation.id)
})

test('prepared native legacy dispatch is rechecked after the scope becomes terminal',async t=>{
 const h=await surfaceFixture(t),scope=await h.legacy();let entered,release
 const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
 const dispose=h.ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.arguments?.objective==='queued old call'){entered();await gate}return next()})
 try{
  const queued=h.invoke('collaboration_task',{scopeId:scope.id,objective:'queued old call',members:['B']})
  await waiting;await h.run('collaboration_control',{scopeId:scope.id,action:'cancel',reason:'finish this historical scope'})
  release();const result=await queued;assert.equal(result.isError,true)
  assert.equal(Object.keys((await h.runtime.status({scopeId:scope.id},h.exec())).tasks).length,0)
 }finally{release?.();dispose()}
})

test('disposing compatibility before readiness never restores globals or scoped filters later',async t=>{
 const h=await surfaceFixture(t),a=h.agents.get('A'),runtime=h.runtime
 h.env.toolSurface.dispose()
 let resolve;const ready=new Promise(done=>resolve=done)
 const definition={name:'historical_fixture_tool',description:'historical only',parameters:{},output:{schema:{type:'object'},render:()=>[]},async execute(){return {}}}
 const deny=a.ctx.tools.restrict({deny:['session_coordinator_send']})
 const surface=new SessionToolSurface(h.env,ready,new Map([['task',definition]]))
 assert.equal(h.tools.get('historical_fixture_tool',a),undefined)
 surface.dispose();resolve(runtime);await new Promise(resolve=>setImmediate(resolve))
 assert.equal(h.tools.get('historical_fixture_tool',a),undefined);assert.equal(h.tools.get('session_coordinator_send',a),undefined)
 deny();assert.ok(h.tools.get('session_coordinator_send',a))
})

test('retained receipt does not terminate current work after one reply',async t=>{
 const h=await surfaceFixture(t)
 const request=await h.run('send',{targets:['B'],content:'work',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'continue review'}})
 h.agents.get('B').session.append('user/message',h.effects.at(-1).message,{surfaceOp:'append'})
 const reply=await h.run('send',{targets:['A'],content:'review result',replyTo:request.results[0].messageId,context:{communicationHandle:request.communicationHandle}},'B')
 const message=h.effects.at(-1).message;h.agents.get('A').session.append('user/message',message,{surfaceOp:'append'})
 assert.equal(reply.results[0].admission,'accepted');assert.equal(message.source.hopCount,2)
 const receipt=await h.run('status',{sessionId:'A',messageId:reply.results[0].messageId})
 assert.equal(receipt.terminal,false,'work permission has no two-hop terminal')
})

test('readonly receipts do not invent v2 first-message reply permission',async t=>{
 const h=await surfaceFixture(t)
 for(const reply of ['none','once']){
  const first=await h.run('send',{targets:['B'],content:'check '+reply,authorizationRequest:{extent:'message',participants:['A','B'],purpose:'receipt test',reply}})
  h.agents.get('B').session.append('user/message',h.effects.at(-1).message,{surfaceOp:'append'})
  const receipt=await h.run('status',{sessionId:'B',messageId:first.results[0].messageId})
  assert.equal(receipt.terminal,undefined,'source does not persist the original none/once grant')
  if(reply==='once'){
   const result=await h.run('send',{targets:['A'],content:'done',replyTo:first.results[0].messageId},'B')
   h.agents.get('A').session.append('user/message',h.effects.at(-1).message,{surfaceOp:'append'})
   assert.equal((await h.run('status',{sessionId:'A',messageId:result.results[0].messageId})).terminal,true)
  }
 }
})
