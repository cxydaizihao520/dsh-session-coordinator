import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fixture} from './fixtures/session-tools.mjs'
import {tasksFixture} from './fixtures/session-tasks.mjs'
import {exportDiagnostics,exportRelatedDiagnostics} from '../src/diagnostics.ts'

test('current batch diagnostics preserve each real outcome and permission identity without business text',async()=>{
 const h=fixture();h.human('A');h.make('C');h.ctx.workspaceRegistry.archivedSessionIds=['C'];const result=await h.run('send',{targets:['B','C'],content:'PRIVATE body /secret/file',requestId:'diagnostic-batch-1'});
 assert.deepEqual(result.results.map(x=>x.admission),['accepted','rejected']);const exported=await exportRelatedDiagnostics(h.ctx,'A'),rows=exported.sessions[0].records;
 const b=rows.find(x=>x.stage==='returned'&&x.targetSessionId==='B'),c=rows.find(x=>x.stage==='failed'&&x.targetSessionId==='C');assert.equal(b.protocol,'session-message');assert.equal(b.delivery,'accepted');assert.equal(c.reason,'target-unavailable');assert.equal(c.delivery,'not-sent');assert.equal(c.requestId,result.requestId);assert.equal(c.messageId,result.results[1].messageId);
 assert.ok(!JSON.stringify(exported).includes('PRIVATE'));assert.ok(exported.runtime.plugin.artifactSha256);assert.equal(exported.runtime.host.version,null);assert.equal(exported.runtime.client.loadedFingerprint,null);
})

test('explicit rejection and unknown native outcome remain distinguishable in registered tools',async()=>{
 for(const kind of ['denied','unknown']){
  const h=fixture();h.human('A');if(kind==='denied')h.setAnswer(async()=> 'rejected');else h.agents.get('B').steer=()=>{throw Error('PRIVATE transport detail')};
  const result=await h.run('send',{targets:['B'],content:'PRIVATE request',requestId:'diagnostic-'+kind});assert.equal(result.results[0].admission,kind==='denied'?'rejected':'unknown');
  const exported=await exportDiagnostics(h.ctx,'A'),row=exported.sessions[0].records.findLast(x=>x.targetSessionId==='B'&&x.stage==='failed');assert.equal(row.reason,kind==='denied'?'authorization-denied':'delivery-unknown');assert.equal(row.delivery,kind==='denied'?'not-sent':'unknown');assert.ok(!JSON.stringify(exported).includes('PRIVATE'));
 }
})

test('control uncertainty preserves effective revocation and in-flight truth without exporting audit bodies',async()=>{
 const {diagnosticCall}=await import('../src/diagnostics.ts');const h=fixture();h.human('A');
 await diagnosticCall(h.ctx,h.agents.get('A'),'session_coordinator_control',{object:'communication',action:'revoke',requestId:'control-unknown-export',handle:'communication-test',content:'PRIVATE edit'},'control-call',new AbortController().signal,async()=>({requestId:'control-unknown-export',object:'communication',action:'revoke',outcome:'unknown',communicationState:'revoked',handle:'communication-test',workStopped:'unknown',inFlight:[{messageId:'message-test',admission:'unknown'}],before:{content:'PRIVATE before'},error:{code:'CONTROL_UNKNOWN',message:'PRIVATE storage'}}));
 const dump=await exportDiagnostics(h.ctx,'A');const failed=dump.sessions[0].records.find(x=>x.stage==='failed');assert.equal(failed.communicationState,'revoked');assert.equal(failed.delivery,'unknown');assert.equal(failed.workStopped,'unknown');assert.ok(dump.sessions[0].records.some(x=>x.stage==='control-in-flight'&&x.messageId==='message-test'&&x.delivery==='unknown'));assert.ok(!JSON.stringify(dump).includes('PRIVATE'));
})

test('an uncertain creation remains separate from a first message that was never requested',async()=>{
 const h=fixture();h.human('A');h.ctx.agents.create=async()=>{throw Error('PRIVATE creation error')};const result=await h.run('create',{requestId:'creation-unknown-export'});assert.equal(result.creationState,'unknown');
 const dump=await exportDiagnostics(h.ctx,'A');assert.ok(dump.sessions[0].records.some(row=>row.creationState==='unknown'&&row.reason==='creation-unknown'));assert.ok(!JSON.stringify(dump).includes('PRIVATE'));
})

test('denied work and expired runtime handles keep request protocol without claiming a grant',async()=>{
 for(const kind of ['denied','expired']){
  const h=fixture();h.human('A');const authorizationRequest={extent:'work',participants:['A','B'],purpose:'PRIVATE purpose'};let handle;
  if(kind==='expired'){
   const granted=await h.run('send',{targets:['B'],content:'PRIVATE original',authorizationRequest,requestId:'work-granted-diagnostic'});handle=granted.communicationHandle;assert.ok(handle);h.reload();
  }else h.setAnswer(async()=> 'rejected');
  const requestId='work-failed-diagnostic-'+kind;
  const result=await h.run('send',{targets:['B'],content:'PRIVATE new',requestId,...(handle?{context:{communicationHandle:handle}}:{authorizationRequest})});assert.equal(result.results[0].admission,'rejected');
  const dump=await exportDiagnostics(h.ctx,'A'),row=dump.sessions[0].records.findLast(x=>x.requestId===requestId&&x.stage==='failed');assert.equal(row.protocol,'session-work');assert.equal(row.communicationHandle,undefined);assert.equal(row.requestedHandle,handle);assert.equal(row.reason,kind==='denied'?'authorization-denied':'authorization-unavailable');assert.ok(!JSON.stringify(dump).includes('PRIVATE'));
 }
})

test('terminal reply diagnostics report actual none even when input redundantly asks once',async()=>{
 const h=fixture();h.human('A');const authorizationRequest={extent:'message',participants:['A','B'],purpose:'return report',reply:'once'};
 const first=await h.run('send',{targets:['B'],content:'PRIVATE original',authorizationRequest,requestId:'terminal-diag-original'});
 const reply=await h.run('send',{targets:['A'],content:'PRIVATE result',replyTo:first.results[0].messageId,authorizationRequest,requestId:'terminal-diag-reply'},'B');assert.equal(reply.results[0].admission,'accepted');
 const dump=await exportDiagnostics(h.ctx,'B'),rows=dump.sessions[0].records.filter(row=>row.messageId===reply.results[0].messageId&&row.replyPermission!==undefined);assert.ok(rows.length);for(const row of rows){assert.equal(row.terminal,true);assert.equal(row.replyPermission,'none')};assert.ok(!JSON.stringify(dump).includes('PRIVATE'));
})

test('registered control diagnostics preserve rejection and revision while omitting native edit audit bodies',async()=>{
 const {pluginRecordOf}=await import('@deepseek-ai/dsh-session');const h=fixture();h.human('A');const b=h.agents.get('B');b.followup=message=>b.inbox.nextTurn.push(message);b.inbox.replace=(id,message)=>{const i=b.inbox.nextTurn.findIndex(x=>x.id===id);if(i<0)return false;b.inbox.nextTurn.splice(i,1,message);return true};
 const sent=await h.run('send',{targets:['B'],delivery:'queue',content:'PRIVATE original',requestId:'diagnostic-real-control-send'}),messageId=sent.results[0].messageId;
 h.setAnswer(async()=> 'rejected');const denied=await h.run('control',{object:'message',action:'edit',messageId,expectedRevision:1,content:'PRIVATE denied',requestId:'diagnostic-real-control-denied'});assert.equal(denied.outcome,'rejected');assert.equal(b.inbox.nextTurn[0].content[0].text,'PRIVATE original');
 h.human('A');h.setAnswer(async()=> 'allowed-once');const edited=await h.run('control',{object:'message',action:'edit',messageId,expectedRevision:1,content:'PRIVATE edited /secret/path',requestId:'diagnostic-real-control-edited'});assert.equal(edited.outcome,'edited');assert.equal(edited.revision,2);
 const audit=h.agents.get('A').session.snapshotEvents().map(pluginRecordOf).find(x=>x?.type==='plugin:dsh-session-coordinator/control'&&x.data.stage==='intent');assert.equal(audit.data.input.content,'PRIVATE edited /secret/path');
 const dump=await exportRelatedDiagnostics(h.ctx,'A'),rows=dump.sessions[0].records,failed=rows.findLast(x=>x.requestId===denied.requestId&&x.stage==='failed'),changed=rows.findLast(x=>x.requestId===edited.requestId&&x.stage==='returned');assert.equal(failed.protocol,'session-control');assert.equal(failed.outcome,'rejected');assert.equal(failed.reason,'authorization-denied');assert.equal(changed.outcome,'edited');assert.equal(changed.revision,2);assert.equal(changed.messageId,messageId);assert.ok(!JSON.stringify(dump).includes('PRIVATE'));assert.ok(!JSON.stringify(dump).includes('/secret/path'));
})

test('registered revoke durability failure exports effective revocation and each actual admission',async()=>{
 const h=fixture();h.human('A');const first=await h.run('send',{targets:['B'],content:'PRIVATE accepted',requestId:'diagnostic-revoke-accepted',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'PRIVATE review'}});assert.equal(first.results[0].admission,'accepted');
 h.agents.get('B').steer=()=>{throw Error('PRIVATE transport detail')};const uncertain=await h.run('send',{targets:['B'],content:'PRIVATE unknown',requestId:'diagnostic-revoke-uncertain',context:{communicationHandle:first.communicationHandle}});assert.equal(uncertain.results[0].admission,'unknown');
 h.setFlush(async session=>session.id!=='A');const revoked=await h.run('control',{object:'communication',action:'revoke',handle:first.communicationHandle,requestId:'diagnostic-real-revoke-unknown'});assert.equal(revoked.outcome,'unknown');assert.equal(revoked.communicationState,'revoked');assert.equal(revoked.workStopped,'unknown');
 const dump=await exportDiagnostics(h.ctx,'A'),rows=dump.sessions[0].records,failed=rows.findLast(x=>x.requestId===revoked.requestId&&x.stage==='failed');assert.equal(failed.protocol,'session-control');assert.equal(failed.communicationState,'revoked');assert.equal(failed.delivery,'unknown');assert.equal(failed.workStopped,'unknown');assert.equal(dump.sessions[0].incomplete,true);
 const flights=rows.filter(x=>x.requestId===revoked.requestId&&x.stage==='control-in-flight');assert.equal(flights.find(x=>x.messageId===first.results[0].messageId).delivery,'accepted');assert.equal(flights.find(x=>x.messageId===uncertain.results[0].messageId).delivery,'unknown');assert.ok(!JSON.stringify(dump).includes('PRIVATE'));
 h.setFlush(async()=>true);const blocked=await h.run('send',{targets:['B'],content:'PRIVATE after revoke',requestId:'diagnostic-revoke-blocked',context:{communicationHandle:first.communicationHandle}});assert.equal(blocked.results[0].admission,'rejected');
})

test('registered task declaration and selective cancellation export facts without business text',async()=>{
 const h=await tasksFixture(),get=h.ctx.get;h.ctx.get=name=>name==='jobs'?{list:()=>[],get(){throw Error('no jobs')}}:get(name)
 const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'PRIVATE shipping /secret/input',members:['B'],requestId:'diagnostic-declare-task'})
 const b=h.agents.get('B');b.followup=message=>b.inbox.nextTurn.push(message);b.inbox.remove=id=>{const index=b.inbox.nextTurn.findIndex(message=>message.id===id);if(index<0)return false;b.inbox.nextTurn.splice(index,1);return true}
 const sent=await h.run('send',{targets:['B'],delivery:'queue',content:'PRIVATE calculation',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
 assert.equal(sent.results[0].admission,'accepted')
 const result=await h.run('control',{object:'task',action:'cancel',taskHandle:task.taskHandle,expectedRevision:1,reason:'PRIVATE reason',requestId:'diagnostic-task-cancel'})
 assert.equal(result.state,'cancelled');assert.equal(result.workStopped,true,JSON.stringify(result));assert.equal(b.inbox.nextTurn.length,0)
 const dump=await exportRelatedDiagnostics(h.ctx,'A'),rows=dump.sessions[0].records
 const declared=rows.findLast(row=>row.tool==='session_coordinator_task'&&row.stage==='returned'),stopped=rows.findLast(row=>row.requestId===result.requestId&&row.stage==='returned'),pending=rows.findLast(row=>row.requestId===result.requestId&&row.stage==='control-pending')
 assert.equal(declared.protocol,'session-work');assert.equal(declared.taskId,task.id);assert.equal(declared.taskHandle,task.taskHandle)
 assert.equal(stopped.object,'task');assert.equal(stopped.outcome,'applied');assert.equal(stopped.state,'cancelled');assert.equal(stopped.workStopped,true)
 assert.equal(pending.messageId,sent.results[0].messageId);assert.equal(pending.outcome,'withdrawn')
 assert.ok(!JSON.stringify(dump).includes('PRIVATE'));assert.ok(!JSON.stringify(dump).includes('/secret/input'))
})
