import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fixture} from './fixtures/session-tools.mjs'
import {pluginRecordOf} from '@deepseek-ai/dsh-session'
import {registerCoordinateCommand} from '../src/coordinate.ts'
import {sessionControlCommand} from '../src/session-control.ts'

function pendingFixture(){
 const h=fixture(),b=h.agents.get('B')
 b.inbox.replace=(id,message)=>{for(const list of [b.inbox.nextStep,b.inbox.nextTurn]){const index=list.findIndex(m=>m.id===id);if(index>=0){list.splice(index,1,message);return true}}return false}
 b.inbox.remove=id=>{for(const list of [b.inbox.nextStep,b.inbox.nextTurn]){const index=list.findIndex(m=>m.id===id);if(index>=0){list.splice(index,1);return true}}return false}
 b.steer=m=>{b.inbox.nextStep.push(m);h.effects.push(['send','B',m])};b.followup=m=>{b.inbox.nextTurn.push(m);h.effects.push(['send','B',m])}
 h.human('A');return {...h,b}
}

test('one explicit work approval covers only its declared controls and communication revocation stays independent',async()=>{
 const h=pendingFixture()
 const first=await h.run('send',{targets:['B'],content:'work with separately approved controls',delivery:'queue',authorizationRequest:{participants:['A','B'],purpose:'review with explicit controls',extent:'work',controls:{controllers:['A'],targets:['A','B'],actions:['message.withdraw','communication.revoke','execution.interrupt']}}})
 assert.equal(first.results[0].admission,'accepted',JSON.stringify(first));assert.equal(typeof first.controlHandle,'string');assert.equal(h.approvals.length,1)
 const retained=await h.run('send',{targets:['B'],content:'keep this',delivery:'queue',context:{communicationHandle:first.communicationHandle}})
 const withdrawn=await h.run('control',{object:'message',action:'withdraw',messageId:first.results[0].messageId,controlHandle:first.controlHandle,requestId:'scoped-control-withdraw'})
 assert.equal(withdrawn.outcome,'withdrawn');assert.equal(h.approvals.length,1)
 const revoked=await h.run('control',{object:'communication',action:'revoke',handle:first.communicationHandle,controlHandle:first.controlHandle,requestId:'scoped-control-revoke'})
 assert.equal(revoked.communicationState,'revoked');assert.equal(h.approvals.length,1)
 assert.match(h.env.delivery.modelContext(h.agents.get('B')),/approvedControls/,'communication revocation does not erase independently approved control facts')
 const abort=new AbortController();h.b.status='running';h.b.session.append('turn/start',{turn:1})
 h.b.session.append('user/message',h.b.inbox.nextTurn.shift(),{surfaceOp:'append'})
 h.b.cancel=()=>h.effects.push(['cancel','B'])
 for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:h.b,turn:1,step:1,signal:abort.signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const observed=await h.run('status',{sessionId:'B'})
 const stopped=await h.run('control',{object:'execution',action:'interrupt',sessionId:'B',expectedExecution:observed.executionId,controlHandle:first.controlHandle,requestId:'scoped-control-interrupt'})
 assert.equal(stopped.outcome,'requested');assert.equal(h.approvals.length,1)
 assert.equal(h.b.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.id===retained.results[0].messageId),true)
 const send=await h.run('send',{targets:['B'],content:'not allowed after revoke',context:{communicationHandle:first.communicationHandle}})
 assert.equal(send.results[0].admission,'rejected')
})

test('a work control scope cannot interrupt a later unrelated or mixed native turn',async()=>{
 for(const mixed of [false,true]){
  const h=pendingFixture(),work=await h.run('send',{targets:['B'],content:'work X',delivery:'queue',authorizationRequest:{participants:['A','B'],purpose:'work X',extent:'work',controls:{actions:['execution.interrupt']}}})
  h.b.status='running';h.b.session.append('turn/start',{turn:1});h.b.session.append('user/message',{id:'unrelated-human-work',role:'user',source:{kind:'user'},content:[{type:'text',text:'independent work Y'}]},{surfaceOp:'append'})
  if(mixed)h.b.session.append('user/message',h.b.inbox.nextTurn.shift(),{surfaceOp:'append'})
  for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:h.b,turn:1,step:1,signal:new AbortController().signal,messages:[]},async()=>({kind:'enter',messages:[]}))
  let cancelled=0;h.b.cancel=()=>cancelled++
  const status=await h.run('status',{sessionId:'B'}),input={object:'execution',action:'interrupt',sessionId:'B',expectedExecution:status.executionId,requestId:'unrelated-scope-interrupt-'+mixed,controlHandle:work.controlHandle}
  const result=await h.run('control',input)
  assert.equal(result.error.code,'CONTROL_AUTHORIZATION_DENIED');assert.equal(cancelled,0);assert.equal(h.approvals.length,1)
  const {controlHandle,...exactTurn}=input
  const explicit=await h.run('control',{...exactTurn,requestId:'explicit-turn-interrupt-'+mixed})
  assert.equal(explicit.outcome,'requested');assert.equal(cancelled,1);assert.equal(h.approvals.length,2,'an explicitly approved whole-turn control remains available')
 }
})

test('control scopes cannot be forged, silently upgraded or restored from historical sends',async()=>{
 const h=pendingFixture();h.make('C');h.human('C')
 const auth={participants:['A','B','C'],purpose:'scoped review',extent:'work',controls:{controllers:['A'],targets:['A','B'],actions:['message.withdraw','authorization.revoke']}}
 const sent=await h.run('send',{targets:['B'],content:'retain pending',delivery:'queue',authorizationRequest:auth,requestId:'control-bound-first'})
 const input={object:'message',action:'withdraw',messageId:sent.results[0].messageId,controlHandle:sent.controlHandle,requestId:'control-bound-withdraw'}
 const forged=await h.run('control',{...input,controlHandle:'invented-control-handle',requestId:'control-forged-scope'})
 assert.equal(forged.error.code,'CONTROL_AUTHORIZATION_DENIED')
 const actor=await h.run('control',{...input,requestId:'control-wrong-controller'},'C');assert.equal(actor.error.code,'CONTROL_AUTHORIZATION_DENIED')
 const wrongAction=await h.run('control',{object:'communication',action:'revoke',handle:sent.communicationHandle,controlHandle:sent.controlHandle,requestId:'control-unapproved-action'})
 assert.equal(wrongAction.error.code,'CONTROL_AUTHORIZATION_DENIED');assert.equal(h.approvals.length,1)
 h.agents.get('C').followup=message=>h.agents.get('C').inbox.nextTurn.push(message)
 h.agents.get('C').inbox.remove=()=>{throw Error('out-of-scope target must not be mutated')}
 const c=await h.run('send',{targets:['C'],content:'out of control target scope',delivery:'queue',context:{communicationHandle:sent.communicationHandle}})
 const target=await h.run('control',{...input,messageId:c.results[0].messageId,requestId:'control-wrong-target'})
 assert.equal(target.error.code,'CONTROL_AUTHORIZATION_DENIED')
 const revoked=await h.run('control',{object:'authorization',action:'revoke',handle:sent.controlHandle,controlHandle:sent.controlHandle,requestId:'control-revoke-only-scope'})
 assert.equal(revoked.controlState,'revoked');assert.equal(h.approvals.length,1)
 assert.equal(h.env.delivery.modelContext(h.agents.get('A')).includes('approvedControls'),false)
 assert.equal((await h.run('control',input)).error.code,'CONTROL_AUTHORIZATION_DENIED');assert.equal(h.b.inbox.nextTurn.length,1)
 assert.equal((await h.run('send',{targets:['B'],content:'communication retained',context:{communicationHandle:sent.communicationHandle}})).results[0].admission,'accepted')
 const upgraded=await h.run('send',{targets:['B'],content:'new explicitly approved controls',authorizationRequest:{...auth,controls:{...auth.controls,actions:['message.withdraw','communication.revoke']}}})
 assert.equal(upgraded.results[0].admission,'accepted');assert.equal(h.approvals.length,2,'new control scope requires a new exact approval')
 h.reload()
 const old=await h.run('send',{targets:['B'],content:'retain pending',delivery:'queue',authorizationRequest:auth,requestId:'control-bound-first'})
 assert.equal(old.historical,true);assert.equal(old.controlHandle,undefined);assert.equal(h.approvals.length,2)
 const afterReload=await h.run('control',{object:'authorization',action:'revoke',handle:upgraded.controlHandle,requestId:'control-old-runtime-scope'})
 assert.equal(afterReload.error.code,'PERMISSION_NOT_FOUND');assert.equal(h.approvals.length,2)
 await assert.rejects(h.run('send',{targets:['B'],content:'once cannot grant controls',authorizationRequest:{...auth,participants:['A','B'],extent:'message',reply:'once'}}),/control scope/)
})

test('revoking a control permission across the intent checkpoint prevents the queued mutation',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'keep pending',delivery:'queue',authorizationRequest:{participants:['A','B'],purpose:'race',extent:'work',controls:{actions:['message.withdraw','authorization.revoke']}}})
 let revoked=false
 h.setFlush(async session=>{if(!revoked&&session.snapshotEvents().map(pluginRecordOf).some(record=>record?.type==='plugin:dsh-session-coordinator/control'&&record.data.stage==='intent'&&record.data.requestId==='control-race-withdraw')){revoked=true;assert.equal((await h.run('control',{object:'authorization',action:'revoke',handle:sent.controlHandle,controlHandle:sent.controlHandle,requestId:'control-race-revoke'})).controlState,'revoked')}return true})
 const result=await h.run('control',{object:'message',action:'withdraw',messageId:sent.results[0].messageId,controlHandle:sent.controlHandle,requestId:'control-race-withdraw'})
 assert.equal(result.error.code,'CONTROL_AUTHORIZATION_DENIED');assert.equal(h.b.inbox.nextTurn.length,1)
})

function commandFixture(h){
 let definition
 h.ctx.inject=(_names,fn)=>fn({commands:{register(value){definition=value}}})
 registerCoordinateCommand(h.ctx,h.grants,undefined,undefined,payload=>sessionControlCommand(h.env,payload))
 let seq=0
 return async(raw,patch={},record={})=>{
  const payload={rawInput:raw,agent:h.agents.get('A'),commandId:'native-human-command-'+(++seq),signal:new AbortController().signal,...patch}
  if(!record.missing)payload.agent.session.append('command/run',{commandId:payload.commandId,name:'coordinate',args:raw,source:{kind:'user'},...record})
  return definition.handler(payload)
 }
}

test('native human command directly withdraws via the shared consumer and never requests a second approval',async()=>{
 const h=pendingFixture(),command=commandFixture(h)
 const sent=await h.run('send',{targets:['B'],content:'precise pending item',delivery:'queue'})
 const before=h.approvals.length,choices=await command('controls')
 assert.equal(choices.kind,'success',choices.text)
 const choice=JSON.parse(choices.text).choices.find(item=>item.input.messageId===sent.results[0].messageId)
 assert.ok(choice)
 const result=await command('control '+JSON.stringify({...choice.input,requestId:'native-ui-withdraw'}))
 assert.equal(JSON.parse(result.text).outcome,'withdrawn',result.text);assert.equal(h.approvals.length,before)
 assert.equal(h.b.inbox.nextTurn.length,0)
})

test('a precise native user stop does not depend on choosing among unrelated recurring grants',async()=>{
 const h=pendingFixture(),command=commandFixture(h)
 for(const purpose of ['work X','work Y'])await h.run('send',{targets:['B'],content:purpose,delivery:'queue',authorizationRequest:{participants:['A','B'],purpose,extent:'work',controls:{actions:['execution.interrupt']}}})
 h.b.status='running';h.b.session.append('turn/start',{turn:1});let cancelled=0;h.b.cancel=()=>cancelled++
 for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:h.b,turn:1,step:1,signal:new AbortController().signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const status=await h.run('status',{sessionId:'B'}),before=h.approvals.length
 const result=await command('control '+JSON.stringify({object:'execution',action:'interrupt',sessionId:'B',expectedExecution:status.executionId,requestId:'native-stop-among-grants'}))
 assert.equal(JSON.parse(result.text).outcome,'requested',result.text);assert.equal(cancelled,1);assert.equal(h.approvals.length,before)
})

test('missing, forged, mismatched, ended or cancelled native user commands do not authorize controls',async()=>{
 for(const scenario of ['missing','wrong-source','wrong-args','done','cancelled','wrong-agent']){
  const h=pendingFixture(),command=commandFixture(h),sent=await h.run('send',{targets:['B'],content:'do not withdraw',delivery:'queue'})
  const raw='control '+JSON.stringify({object:'message',action:'withdraw',messageId:sent.results[0].messageId,requestId:'invalid-ui-'+scenario}),abort=new AbortController()
  const patch={},record={}
  if(scenario==='missing')record.missing=true
  if(scenario==='wrong-source')record.source={kind:'session-message'}
  if(scenario==='wrong-args')record.args=raw+' different'
  if(scenario==='cancelled'){abort.abort();patch.signal=abort.signal}
  if(scenario==='wrong-agent')patch.agent={...h.agents.get('A')}
  if(scenario==='done')h.agents.get('A').session.append('command/done',{commandId:'native-human-command-1',kind:'success'})
  const before=h.approvals.length,result=await command(raw,patch,record)
  assert.equal(result.kind,'error',scenario+': '+result.text);assert.equal(h.approvals.length,before);assert.equal(h.b.inbox.nextTurn.length,1)
 }
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'forged model flag',delivery:'queue'})
 await assert.rejects(h.run('control',{object:'message',action:'withdraw',messageId:sent.results[0].messageId,requestId:'forged-model-user-approval',approved:true}),/unexpected control field/)
 assert.equal(h.b.inbox.nextTurn.length,1)
})

test('edit preserves queue position, original send idempotency and version conflicts',async()=>{
 const h=pendingFixture(),args={targets:['B'],content:'  original\n',delivery:'queue',requestId:'control-original'}
 const sent=await h.run('send',args),id=sent.results[0].messageId
 const other={id:'unrelated',role:'user',source:{kind:'user'},content:[{type:'text',text:'keep'}]};h.b.inbox.nextTurn.push(other)
 const edit={object:'message',action:'edit',messageId:id,expectedRevision:1,content:'  revised\n',requestId:'control-edit-01'}
 const changed=await h.run('control',edit)
 assert.equal(changed.outcome,'edited');assert.equal(changed.revision,2);assert.deepEqual(h.b.inbox.nextTurn.map(m=>m.id),[id,'unrelated']);assert.equal(h.b.inbox.nextTurn[0].content[0].text,'  revised\n')
 assert.deepEqual(await h.run('send',args),sent);assert.equal(h.b.inbox.nextTurn[0].content[0].text,'  revised\n')
 assert.deepEqual(await h.run('control',edit),changed)
 const stale=await h.run('control',{...edit,requestId:'control-edit-02'});assert.equal(stale.error.code,'REVISION_CONFLICT')
 const status=await h.run('status',{sessionId:'B'});assert.equal(status.deliveries.find(x=>x.messageId===id).revision,2)
})

test('withdraw removes only the exact pending input and does not cancel execution',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'withdraw this',delivery:'queue',requestId:'control-withdraw-send'})
 h.b.inbox.nextStep.push({id:'other-input'});const input={object:'message',action:'withdraw',messageId:sent.results[0].messageId,requestId:'control-withdraw-01'}
 const result=await h.run('control',input);assert.equal(result.outcome,'withdrawn');assert.equal(h.b.inbox.nextTurn.length,0);assert.equal(h.b.inbox.nextStep[0].id,'other-input')
 assert.deepEqual(await h.run('control',input),result)
 assert.equal((await h.run('control',{...input,requestId:'control-withdraw-02'})).outcome,'already_withdrawn')
})

test('revoke blocks future work submissions but preserves accepted pending input',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'pending work',delivery:'queue',requestId:'control-work-send',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 const before=h.approvals.length,result=await h.run('control',{object:'communication',action:'revoke',handle:sent.communicationHandle,requestId:'control-revoke-01'})
 assert.equal(h.approvals.length,before+1);assert.equal(result.communicationState,'revoked');assert.equal(result.inFlight[0].admission,'accepted');assert.equal(h.b.inbox.nextTurn.length,1);assert.equal(result.workStopped,'unknown')
 const denied=await h.run('send',{targets:['B'],content:'new input',context:{communicationHandle:sent.communicationHandle},requestId:'control-revoked-send'});assert.equal(denied.results[0].admission,'rejected')
})

test('interrupt targets the observed execution, retains inbox and waits for native turn/end evidence',async()=>{
 const h=pendingFixture(),abort=new AbortController();h.b.status='running';h.b.session.append('turn/start',{turn:1});h.b.inbox.nextTurn.push({id:'unrelated'})
 h.b.cancel=(cause,options)=>{assert.equal(cause.kind,'hook');assert.equal(options.keepInbox,true);h.effects.push(['cancel']);abort.abort(cause)}
 for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:h.b,turn:1,step:1,signal:abort.signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const status=await h.run('status',{sessionId:'B'}),input={object:'execution',action:'interrupt',sessionId:'B',expectedExecution:status.executionId,requestId:'control-interrupt-01'}
 const result=await h.run('control',input);assert.equal(result.outcome,'requested');assert.equal(result.executionStopped,false);assert.equal(result.workStopped,'unknown');assert.equal(h.b.inbox.nextTurn.length,1)
 h.b.session.append('turn/end',{turn:1,reason:{kind:'cancelled',cause:{kind:'hook',reason:'test'}}});h.b.status='idle'
 const after=await h.run('status',{sessionId:'B'});assert.equal(after.controls.find(x=>x.requestId===input.requestId).executionStopped,true);assert.equal(after.controls.find(x=>x.requestId===input.requestId).workStopped,'unknown')
 const stale=await h.run('control',{...input,requestId:'control-interrupt-02'});assert.equal(stale.error.code,'EXECUTION_CONFLICT');assert.equal(h.effects.filter(x=>x[0]==='cancel').length,1)
})

test('missing pending evidence is unknown and native remove false never claims withdrawal',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'racing input',delivery:'queue',requestId:'control-remove-race'})
 h.b.inbox.remove=()=>{h.b.inbox.nextTurn.length=0;return false}
 const result=await h.run('control',{object:'message',action:'withdraw',messageId:sent.results[0].messageId,requestId:'control-remove-false'})
 assert.equal(result.outcome,'unknown')
})

test('native claim during control approval is reported without rewriting consumed history',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'already claimed',delivery:'queue',requestId:'control-claim-race'})
 h.setAnswer(async()=>{const message=h.b.inbox.nextTurn.shift();for(const fn of h.listeners.get('agent/inbox/claimed')??[])fn({agent:h.b,message,turn:1});h.b.session.append('user/message',message,{surfaceOp:'append'});return 'allowed-once'})
 const result=await h.run('control',{object:'message',action:'edit',messageId:sent.results[0].messageId,expectedRevision:1,content:'must not replace',requestId:'control-claim-edit'})
 assert.equal(result.outcome,'already_claimed');assert.equal(h.b.session.snapshotEvents().find(e=>e.type==='user/message').data.content[0].text,'already claimed')
})

test('independent control rejection leaves a member send permission and pending message intact',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'remain pending',delivery:'queue',requestId:'control-denial-send',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 h.setAnswer(async()=> 'rejected')
 const result=await h.run('control',{object:'communication',action:'revoke',handle:sent.communicationHandle,requestId:'control-denial-revoke'})
 assert.equal(result.outcome,'rejected');assert.equal(h.b.inbox.nextTurn.length,1)
 const next=await h.run('send',{targets:['B'],content:'still authorized',context:{communicationHandle:sent.communicationHandle},requestId:'control-still-send'})
 assert.equal(next.results[0].admission,'accepted')
})

test('one-message revoke at the reply intent checkpoint prevents its native submission',async()=>{
 const h=pendingFixture(),first=await h.run('send',{targets:['B'],content:'one report',requestId:'control-once-first',authorizationRequest:{participants:['A','B'],purpose:'report',extent:'message',reply:'once'}})
 // The receiver has actually consumed this authorized input.
 const original=h.b.inbox.nextStep.shift();h.b.session.append('user/message',original,{surfaceOp:'append'})
 let revoked=false
 h.setFlush(async session=>{const intent=session.snapshotEvents().map(pluginRecordOf).some(r=>r?.type==='plugin:dsh-session-coordinator/delivery'&&r.data.stage==='intent'&&r.data.message?.source?.replyTo===first.results[0].messageId);if(session.id==='B'&&intent&&!revoked){revoked=true;const result=await h.run('control',{object:'communication',action:'revoke',handle:first.results[0].messageId,requestId:'control-once-revoke'});assert.equal(result.communicationState,'revoked')}return true})
 const result=await h.run('send',{targets:['A'],content:'too late',replyTo:first.results[0].messageId,requestId:'control-once-reply'},'B')
 assert.equal(revoked,true);assert.equal(result.results[0].admission,'rejected');assert.equal(h.effects.filter(e=>e[0]==='send'&&e[1]==='A').length,0)
})

test('a previously accepted message keeps that fact when a direct duplicate refuses replay',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'known accepted',requestId:'control-known-admission',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 await assert.rejects(h.env.delivery.send({sessionId:'B',message:'known accepted'},h.agents.get('A'),undefined,{protocolVersion:2,messageId:sent.results[0].messageId,communicationHandle:sent.communicationHandle}),/inspection/)
 const result=await h.run('control',{object:'communication',action:'revoke',handle:sent.communicationHandle,requestId:'control-known-revoke'})
 assert.equal(result.inFlight[0].admission,'accepted')
})

test('concurrent retries after pre-action cancellation share one new control approval',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'retry control',delivery:'queue',requestId:'control-concurrent-send'})
 const input={object:'message',action:'withdraw',messageId:sent.results[0].messageId,requestId:'control-concurrent-withdraw'},abort=new AbortController();abort.abort()
 assert.equal((await h.run('control',input,'A',{signal:abort.signal})).outcome,'rejected')
 const count=h.approvals.length,[left,right]=await Promise.all([h.run('control',input),h.run('control',input)])
 assert.equal(h.approvals.length,count+1);assert.deepEqual(left,right);assert.equal(left.outcome,'withdrawn')
})

test('send submitted before revoke retains acceptance after its pending durability checkpoint',async()=>{
 const h=pendingFixture();let revocation
 h.setFlush(async session=>{if(session.id==='B'&&!revocation){revocation={};const handle=h.b.inbox.nextTurn[0].source.communicationHandle;revocation=await h.run('control',{object:'communication',action:'revoke',handle,requestId:'control-inflight-revoke'})}return true})
 const sent=await h.run('send',{targets:['B'],content:'already submitted',delivery:'queue',requestId:'control-inflight-send',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 assert.equal(revocation.communicationState,'revoked');assert.equal(revocation.inFlight[0].admission,'unknown');assert.equal(sent.results[0].admission,'accepted');assert.equal(h.b.inbox.nextTurn.length,1)
 const status=await h.run('status',{sessionId:'B'});assert.equal(status.deliveries.find(x=>x.messageId===sent.results[0].messageId).admission,'accepted');assert.equal(status.controls.find(x=>x.requestId==='control-inflight-revoke').inFlight[0].admission,'accepted')
})

test('revocation remains effective on audit flush failure and edit uncertainty never replays',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'pending',delivery:'queue',requestId:'control-failure-send',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 h.setFlush(async session=>session.id!=='A')
 const revoked=await h.run('control',{object:'communication',action:'revoke',handle:sent.communicationHandle,requestId:'control-failure-revoke'})
 assert.equal(revoked.outcome,'unknown');assert.equal(revoked.communicationState,'revoked');h.setFlush(async()=>true)
 const denied=await h.run('send',{targets:['B'],content:'no new grant',context:{communicationHandle:sent.communicationHandle},requestId:'control-failure-after'});assert.equal(denied.results[0].admission,'rejected')
 const input={object:'message',action:'edit',messageId:sent.results[0].messageId,expectedRevision:1,content:'edited despite lost receipt',requestId:'control-failure-edit'}
 h.setFlush(async session=>session.id!=='B');const edited=await h.run('control',input);assert.equal(edited.outcome,'unknown');assert.equal(h.b.inbox.nextTurn[0].content[0].text,input.content)
 h.setFlush(async()=>true);assert.deepEqual(await h.run('control',input),edited);assert.equal((await h.run('status',{sessionId:'B'})).deliveries.find(x=>x.messageId===sent.results[0].messageId).revision,2)
 h.reload();assert.equal((await h.run('control',input)).outcome,'unknown');assert.equal(h.b.inbox.nextTurn[0].content[0].text,input.content)
})

test('execution replacement during approval never interrupts the later turn',async()=>{
 const h=pendingFixture(),first=new AbortController();h.b.status='running';h.b.session.append('turn/start',{turn:1});let cancels=0;h.b.cancel=()=>cancels++
 const observe=async(turn,signal)=>{for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:h.b,turn,step:1,signal,messages:[]},async()=>({kind:'enter',messages:[]}))};await observe(1,first.signal)
 const old=(await h.run('status',{sessionId:'B'})).executionId
 h.setAnswer(async()=>{h.b.session.append('turn/end',{turn:1,reason:{kind:'completed'}});h.b.session.append('turn/start',{turn:2});await observe(2,new AbortController().signal);return 'allowed-once'})
 const result=await h.run('control',{object:'execution',action:'interrupt',sessionId:'B',expectedExecution:old,requestId:'control-execution-replaced'})
 assert.equal(result.error.code,'EXECUTION_CONFLICT');assert.equal(cancels,0)
})

test('legacy cancel cannot use an old coordination grant to bypass exact execution control',async()=>{
 const h=pendingFixture();h.grants.grant('A',['B']);let cancelled=0;h.b.cancel=()=>cancelled++
 assert.equal(h.tools.has('session_coordinator_cancel'),false)
 assert.equal(cancelled,0);assert.equal(h.approvals.length,0)
})

test('native mutation throwing after apply keeps exact unknown identity and never repeats the edit',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'original',delivery:'queue',requestId:'control-throw-send'}),id=sent.results[0].messageId
 const replace=h.b.inbox.replace;let calls=0;h.b.inbox.replace=(...args)=>{calls++;replace(...args);throw Error('native completion receipt lost')}
 const input={object:'message',action:'edit',messageId:id,expectedRevision:1,content:'already changed',requestId:'control-throw-edit'}
 const result=await h.run('control',input);assert.equal(result.outcome,'unknown');assert.equal(result.messageId,id);assert.equal(result.sessionId,'B')
 assert.equal(h.b.inbox.nextTurn[0].content[0].text,input.content);assert.deepEqual(await h.run('control',input),result);assert.equal(calls,1)
})

test('control rejects conflicting object fields before approval or mutation',async()=>{
 const h=pendingFixture(),sent=await h.run('send',{targets:['B'],content:'keep',delivery:'queue',requestId:'control-object-send'}),count=h.approvals.length
 await assert.rejects(h.run('control',{object:'message',action:'withdraw',messageId:sent.results[0].messageId,sessionId:'A',requestId:'control-object-conflict'}),/unexpected control field/)
 assert.equal(h.approvals.length,count);assert.equal(h.b.inbox.nextTurn.length,1)
})

test('confirmed explicit interruption reaches only the stopped agent model context without changing inbox or permission',async()=>{
 const h=pendingFixture(),b=h.b,abort=new AbortController();b.status='running';b.session.append('turn/start',{turn:1})
 for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:b,turn:1,step:1,signal:abort.signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const sent=await h.run('send',{targets:['B'],content:'pending follow-up',delivery:'queue',requestId:'interruption-context-work',authorizationRequest:{participants:['A','B'],purpose:'follow-up',extent:'work'}})
 assert.equal(sent.results[0].admission,'accepted',JSON.stringify(sent));assert.equal(b.inbox.nextTurn.length,1)
 b.cancel=(_cause,options)=>{assert.equal(options.keepInbox,true)}
 const execution=(await h.run('status',{sessionId:'B'})).executionId
 await h.run('control',{object:'execution',action:'interrupt',sessionId:'B',expectedExecution:execution,requestId:'interruption-context-stop'})
 assert.doesNotMatch(h.env.delivery.modelContext(b),/"interruptedExecution"/,'request alone is not confirmation')
 b.session.append('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'hook',reason:'session_coordinator_control interruption-context-stop'}}});b.status='idle'
 const context=h.env.delivery.modelContext(b),facts=JSON.parse(context.slice(context.indexOf('\n')+1))
 assert.deepEqual(facts.interruptedExecution,{executionId:execution,requestId:'interruption-context-stop'})
 assert.doesNotMatch(h.env.delivery.modelContext(h.agents.get('A')),/"interruptedExecution"/)
 assert.equal(b.inbox.nextTurn[0].id,sent.results[0].messageId)
 const next=await h.run('send',{targets:['B'],content:'new independent input',delivery:'queue',context:{communicationHandle:sent.communicationHandle},requestId:'interruption-context-next'})
 assert.equal(next.results[0].admission,'accepted');assert.equal(b.inbox.nextTurn.length,2)
 h.reload();assert.doesNotMatch(h.env.delivery.modelContext(b),/"interruptedExecution"/,'old runtime controls are not reconstructed as current execution facts')
})

test('rejected interruption followed by a natural end never becomes an explicit-stop context fact',async()=>{
 const h=pendingFixture(),b=h.b,abort=new AbortController();b.status='running';b.session.append('turn/start',{turn:1})
 for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:b,turn:1,step:1,signal:abort.signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const execution=(await h.run('status',{sessionId:'B'})).executionId;h.setAnswer(async()=> 'rejected')
 const result=await h.run('control',{object:'execution',action:'interrupt',sessionId:'B',expectedExecution:execution,requestId:'interruption-context-denied'})
 assert.equal(result.outcome,'rejected');b.session.append('turn/end',{turn:1,reason:{kind:'completed'}});b.status='idle'
 assert.doesNotMatch(h.env.delivery.modelContext(b),/"interruptedExecution"/)
})
