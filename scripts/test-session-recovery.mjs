import assert from 'node:assert/strict'
import {test} from 'node:test'
import {tasksFixture} from './fixtures/session-tasks.mjs'
import {installCollaboration} from '../src/collaboration-tools.ts'
import {fixture} from './fixtures/session-tools.mjs'
import {sessionControlCommand} from '../src/session-control.ts'
import {pluginRecordOf} from '@deepseek-ai/dsh-session'
import {openCollaborationStore} from '../src/collaboration-store.ts'
import {Context} from 'cordis'
import {Storage} from '@deepseek-ai/dsh-storage'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

async function reopen(h) {
  const runtime=await h.env.collaboration,store=runtime.store
  await runtime.close()
  h.listeners.clear()
  h.reload()
  h.env.collaboration=installCollaboration(h.env,{store})
  await h.env.collaboration
}

test('native on-disk task reopen preserves original operations and external files without authority or replay',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'i08-native-recovery-')),h=fixture(),contexts=[]
  t.after(async()=>{await (await h.env.collaboration)?.close();for(const ctx of contexts)await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
  const firstContext=new Context();new Storage(firstContext);contexts.push(firstContext)
  h.env.collaboration=installCollaboration(h.env,{store:await openCollaborationStore(firstContext,{directory})});await h.env.collaboration
  h.human('A')
  const work=await h.run('send',{targets:['B'],content:'two calculations',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'recover remaining work'}})
  const task=await h.run('task',{communicationHandle:work.communicationHandle,objective:'shipping',members:['B'],requestId:'disk-recovery-task'})
  const args={targets:['B'],content:'completed calculation',requestId:'disk-recovery-operation',context:{communicationHandle:work.communicationHandle,taskHandle:task.taskHandle}}
  const sent=await h.run('send',args)
  assert.equal(sent.results[0].admission,'accepted')
  const artifact=join(directory,'completed-calculation.txt');await writeFile(artifact,'completed business effect sentinel\n')
  const before=await h.run('status',{taskHandle:task.taskHandle})
  await (await h.env.collaboration).close();await firstContext.fiber.dispose()
  h.listeners.clear();h.reload()
  const secondContext=new Context();new Storage(secondContext);contexts.push(secondContext)
  h.env.collaboration=installCollaboration(h.env,{store:await openCollaborationStore(secondContext,{directory})});await h.env.collaboration
  const effects=h.effects.length,approvals=h.approvals.length,facts=await h.run('status',{taskId:task.id})
  assert.equal(facts.recoveryRequired,true);assert.equal(facts.taskHandle,undefined)
  assert.deepEqual(facts.operations,before.operations)
  assert.deepEqual(facts.budgetUsage,before.budgetUsage)
  assert.equal(await readFile(artifact,'utf8'),'completed business effect sentinel\n')
  assert.equal((await h.run('send',args)).results[0].admission,'accepted','readonly durable receipt reconciliation')
  assert.equal(h.effects.length,effects);assert.equal(h.approvals.length,approvals)
})

test('reopened task facts are readable by stable identity without restoring handles or execution',async()=>{
  const h=await tasksFixture()
  const t=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recover-shipping-task'})
  await h.run('send',{targets:['B'],content:'calculate shipping',requestId:'recover-original-send',context:{communicationHandle:h.communicationHandle,taskHandle:t.taskHandle}})
  await reopen(h)
  const effects=h.effects.length,approvals=h.approvals.length
  const fact=await h.run('status',{taskId:t.id})
  assert.equal(fact.id,t.id)
  assert.equal(fact.recoveryRequired,true)
  assert.equal(fact.taskHandle,undefined,'reading facts cannot mint an executable reference')
  assert.equal(fact.workStopped,'unknown','old process job and execution records are not live control proof')
  assert.equal(fact.operations.length,1)
  assert.equal(h.effects.length,effects)
  assert.equal(h.approvals.length,approvals)
  await assert.rejects(h.run('status',{taskHandle:t.taskHandle}),/earlier runtime|unknown/)
  await (await h.env.collaboration).close()
})

test('explicit recovery approves only the selected task and never replays accepted work',async()=>{
  const h=await tasksFixture()
  const t=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recover-selected-task'})
  const s=await h.run('task',{communicationHandle:h.communicationHandle,objective:'product',members:['B'],requestId:'recover-other-task'})
  await h.run('send',{targets:['B'],content:'original shipping step',requestId:'recover-accepted-step',context:{communicationHandle:h.communicationHandle,taskHandle:t.taskHandle}})
  await reopen(h)
  h.human('A')
  const effects=h.effects.length,approvals=h.approvals.length
  const resumed=await h.run('control',{object:'task',taskId:t.id,expectedRevision:1,action:'resume',reason:'checked original effects; resume only missing shipping work',requestId:'recover-selected-control'})
  assert.equal(resumed.state,'active',JSON.stringify(resumed))
  assert.notEqual(resumed.taskHandle,t.taskHandle)
  assert.notEqual(resumed.communicationHandle,h.communicationHandle)
  assert.equal(h.approvals.length,approvals+1,'one explicit approval shows both selected task and new communication scope')
  assert.equal(h.effects.length,effects,'resume does not resend old accepted work or wake recipients')
  assert.equal((await h.run('status',{taskId:s.id})).recoveryRequired,true)
  assert.equal((await h.run('status',{taskId:s.id})).state,'recovery-required')
  const plain=await h.run('send',{targets:['B'],content:'cannot drop the recovered task identity',requestId:'recover-drop-task',context:{communicationHandle:resumed.communicationHandle}})
  assert.equal(plain.results[0].admission,'rejected')
  const remaining=await h.run('send',{targets:['B'],content:'only the remaining shipping step',requestId:'recover-remaining-step',context:{communicationHandle:resumed.communicationHandle,taskHandle:resumed.taskHandle}})
  assert.equal(remaining.results[0].admission,'accepted',JSON.stringify(remaining))
  assert.equal((await h.run('status',{taskId:t.id})).operations.length,2,'the original accepted identity remains once alongside the new remaining step')
  await (await h.env.collaboration).close()
})

test('recovery refusal and unrelated members cannot restore task authority',async()=>{
  const h=await tasksFixture(['A','B','C'])
  const t=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recover-refused-task'})
  await reopen(h);h.human('A')
  await assert.rejects(h.run('status',{taskId:t.id},'C'),/member|authorized/)
  h.setAnswer(async()=> 'denied-once')
  const effects=h.effects.length
  const refused=await h.run('control',{object:'task',taskId:t.id,expectedRevision:1,action:'resume',reason:'resume selected work',requestId:'recover-refused-control'})
  assert.equal(refused.outcome,'rejected')
  assert.equal((await h.run('status',{taskId:t.id})).recoveryRequired,true)
  assert.equal(h.effects.length,effects)
  await (await h.env.collaboration).close()
})

test('a persisted recovery result is historical and cannot return executable references after another reload',async()=>{
  const h=await tasksFixture()
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recover-history-task'})
  await reopen(h);h.human('A')
  const args={object:'task',taskId:task.id,expectedRevision:1,action:'resume',reason:'resume remaining shipping work',requestId:'recover-history-control'}
  const recovered=await h.run('control',args)
  assert.equal(recovered.outcome,'applied')
  assert.ok(recovered.taskHandle)
  await reopen(h)
  const effects=h.effects.length,approvals=h.approvals.length
  const historical=await h.run('control',args)
  assert.equal(historical.historical,true)
  assert.equal(historical.taskHandle,undefined)
  assert.equal(historical.communicationHandle,undefined)
  assert.equal(historical.workStopped,'unknown')
  assert.equal((await h.run('status',{taskId:task.id})).recoveryRequired,true)
  assert.equal(h.effects.length,effects)
  assert.equal(h.approvals.length,approvals)
  await (await h.env.collaboration).close()
})

test('recovery cannot reset a task budget across runtime replacement',async()=>{
  const h=await tasksFixture()
  const t=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recover-budget-task',budget:{maxOperations:1}})
  const args={targets:['B'],content:'shipping work',context:{communicationHandle:h.communicationHandle,taskHandle:t.taskHandle}}
  await h.run('send',{...args,requestId:'recover-budget-first'})
  await h.run('send',{...args,requestId:'recover-budget-limit'})
  const before=await h.run('status',{taskHandle:t.taskHandle})
  assert.equal(before.state,'budget-exhausted')
  await reopen(h);h.human('A')
  const approvals=h.approvals.length
  const result=await h.run('control',{object:'task',taskId:t.id,expectedRevision:1,action:'resume',reason:'cannot reset limits',requestId:'recover-budget-control'})
  assert.equal(result.outcome,'rejected')
  const after=await h.run('status',{taskId:t.id})
  assert.deepEqual(after.budgetStop,before.budgetStop)
  assert.deepEqual(after.budgetUsage,before.budgetUsage)
  assert.equal(h.approvals.length,approvals)
  await (await h.env.collaboration).close()
})

test('recovery rechecks the revision after native approval',async()=>{
  const h=await tasksFixture()
  const t=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recover-race-task'})
  await h.run('control',{object:'communication',handle:h.communicationHandle,action:'revoke',requestId:'recover-race-revoke'})
  let entered,release,first=true
  const start=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
  h.setAnswer(async()=>{if(first){first=false;entered();await gate}return 'allowed-once'})
  const pending=h.run('control',{object:'task',taskId:t.id,expectedRevision:1,action:'resume',reason:'restore revoked communication for shipping',requestId:'recover-race-control'})
  await start
  const revised=await h.run('control',{object:'task',taskHandle:t.taskHandle,expectedRevision:1,action:'revise',objective:'shipping v2',reason:'new requirements',requestId:'recover-race-revise'})
  assert.equal(revised.revision,2)
  release()
  const result=await pending
  assert.equal(result.outcome,'rejected')
  assert.equal(result.communicationHandle,undefined)
  assert.equal((await h.run('status',{taskId:t.id})).revision,2)
  await (await h.env.collaboration).close()
})

test('coordinate off during recovery approval prevents the pending new permission',async()=>{
  const h=await tasksFixture(),task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recovery-revoke-task'})
  await reopen(h);h.human('A')
  let enter,release
  const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve)
  h.setAnswer(async()=>{enter();await gate;return 'allowed-once'})
  const effects=h.effects.length
  const pending=h.run('control',{object:'task',taskId:task.id,action:'resume',expectedRevision:1,reason:'restore selected task',requestId:'recovery-revoke-control'})
  await entered;h.env.delivery.revoke('A');release()
  const result=await pending
  assert.equal(result.outcome,'rejected');assert.equal(result.communicationHandle,undefined)
  assert.equal((await h.run('status',{taskId:task.id})).recoveryRequired,true)
  assert.equal(h.effects.length,effects)
  await (await h.env.collaboration).close()
})

test('unknown recovery persistence cannot expose a usable unrestricted grant or replay effects',async()=>{
  const h=await tasksFixture()
  const t=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recover-storage-task'})
  await reopen(h);h.human('A')
  const runtime=await h.env.collaboration,update=runtime.store.update.bind(runtime.store)
  runtime.store.update=async(...args)=>{await update(...args);throw Object.assign(new Error('durability unknown after write'),{code:'durability-unknown'})}
  const effects=h.effects.length
  const result=await h.run('control',{object:'task',taskId:t.id,expectedRevision:1,action:'resume',reason:'resume with storage fault',requestId:'recover-storage-control'})
  assert.equal(result.outcome,'unknown')
  const written=[...h.records.values()].flatMap(record=>Object.values(record.data.tasks)).find(task=>task.id===t.id)
  assert.ok(written.communicationHandle,'fault occurs after the actual task store write')
  assert.equal((await h.run('send',{targets:['B'],content:'cannot escape unknown restoration',requestId:'recover-storage-escape',context:{communicationHandle:written.communicationHandle}})).results[0].admission,'rejected')
  assert.equal(h.effects.length,effects)
  runtime.store.update=update
  await reopen(h)
  assert.equal((await h.run('status',{taskId:t.id})).recoveryRequired,true)
  assert.equal(h.effects.length,effects)
  await (await h.env.collaboration).close()
})
// Append to the integrated recovery suite after I08/I09 are both present.
for(const elapsed of [500,2000])test('native disk reopen restores only selected never-submitted schedules at the original deadline: '+elapsed,async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const directory=await mkdtemp(join(tmpdir(),'i09-native-schedule-recovery-')),h=fixture(),contexts=[]
 let pulse,currentContext
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 const open=async()=>{
  currentContext=new Context();new Storage(currentContext);contexts.push(currentContext)
  h.env.collaboration=installCollaboration(h.env,{store:await openCollaborationStore(currentContext,{directory})});await h.env.collaboration
 }
 t.after(async()=>{await(await h.env.collaboration)?.close();for(const ctx of contexts)await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
 await open();h.human('A')
 const permit=await h.run('send',{targets:['B'],content:'two independent future calculations',authorizationRequest:{extent:'work',participants:['A','B'],purpose:'shipping and product'}})
 const first=await h.run('task',{communicationHandle:permit.communicationHandle,objective:'shipping',members:['B'],requestId:'schedule-recover-t'}),second=await h.run('task',{communicationHandle:permit.communicationHandle,objective:'product',members:['B'],requestId:'schedule-recover-s'})
 const notBefore=Date.now()+1000
 const plan=(task,operationId)=>h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'original '+operationId,operationId,notBefore})
 await plan(first,'schedule-recover-original-t');await plan(second,'schedule-recover-original-s')
 const context={communicationHandle:permit.communicationHandle,taskHandle:first.taskHandle}
 const accepted=await h.run('send',{targets:['B'],content:'already accepted work',requestId:'schedule-recover-accepted',context})
 h.setFlush(async session=>session.id!=='B')
 const unknown=await h.run('send',{targets:['B'],content:'already attempted work',requestId:'schedule-recover-unknown',context})
 h.setFlush(async()=>true)
 assert.equal(accepted.results[0].admission,'accepted');assert.equal(unknown.results[0].admission,'unknown')
 await plan(first,'schedule-recover-manual-t')
 const {scopes}=await h.scopeStatus({}),scope=scopes.find(scope=>scope.tasks[first.id])
 await h.run('schedule',{taskHandle:first.taskHandle,operationId:'schedule-recover-manual-t',action:'withdraw',reason:'remove this future operation explicitly'})
 await h.run('control',{object:'task',action:'pause',taskHandle:first.taskHandle,expectedRevision:1,requestId:'schedule-recover-pause-t',reason:'pause only shipping before its deadline'})
 const before=await h.run('status',{taskHandle:first.taskHandle}),original=before.operations.find(op=>op.id==='schedule-recover-original-t')
 assert.equal(original.status,'withdrawn');assert.equal(original.resumeAfterPause,true);assert.equal(original.wire,undefined)
 await(await h.env.collaboration).close();await currentContext.fiber.dispose();h.listeners.clear();h.reload();await open()
 const sends=()=>h.effects.filter(row=>row[0]==='send'&&row[2].id.startsWith('schedule-recover-original-'))
 t.mock.timers.tick(elapsed);await pulse();assert.equal(sends().length,0)
 const facts=await h.run('status',{taskId:first.id})
 assert.equal(facts.recoveryRequired,true);assert.deepEqual(facts.operations,before.operations)
 h.human('A')
 const approvals=h.approvals.length
 const resumed=await h.run('control',{object:'task',action:'resume',taskId:first.id,expectedRevision:1,requestId:'schedule-recover-resume-t',reason:'resume only the original unsubmitted shipping work'})
 assert.equal(resumed.state,'active');assert.equal(h.approvals.length,approvals+1)
 const approval=JSON.parse(h.approvals.at(-1).reason)
 assert.deepEqual(approval.schedules,[{operationId:original.id,notBefore}]);assert.match(approval.impact,/never-submitted schedules.*original deadlines/)
 await pulse()
 if(elapsed<1000){assert.equal(sends().length,0);t.mock.timers.tick(1000-elapsed);await pulse()}
 assert.equal(sends().length,1);assert.equal(sends()[0][2].id,original.id)
 const restored=await h.run('status',{taskHandle:resumed.taskHandle}),current=restored.operations.find(op=>op.id===original.id)
 assert.equal(current.notBefore,original.notBefore);assert.equal(current.taskRevision,original.taskRevision);assert.equal(current.createdAt,original.createdAt)
 assert.equal(current.admission,'accepted');assert.equal(current.wire.source.communicationHandle,resumed.communicationHandle)
 for(const sent of [accepted,unknown])assert.equal(h.effects.filter(row=>row[0]==='send'&&row[2].id===sent.results[0].messageId).length,1)
 assert.equal(restored.operations.find(op=>op.id===unknown.results[0].messageId).admission,'unknown')
 assert.equal(restored.operations.find(op=>op.id==='schedule-recover-manual-t').status,'withdrawn')
 assert.equal(h.effects.some(row=>row[0]==='send'&&row[2].id==='schedule-recover-manual-t'),false)
 const untouched=await h.run('status',{taskId:second.id})
 assert.equal(untouched.recoveryRequired,true);assert.equal(untouched.operations[0].status,'scheduled');assert.equal(untouched.operations[0].wire,undefined)
 await pulse();assert.equal(sends().length,1)
 h.human('A')
 await h.run('control',{object:'task',action:'resume',taskId:second.id,expectedRevision:1,requestId:'schedule-recover-resume-s',reason:'separately resume remaining product work'})
 await pulse();assert.equal(sends().length,2);assert.deepEqual(sends().map(row=>row[2].id),['schedule-recover-original-t','schedule-recover-original-s'])
 await pulse();assert.equal(sends().length,2)
})

test('an unrecovered active legacy status cannot block another task original deadline',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000})
 const h=await tasksFixture();let pulse
 h.ctx.setInterval=fn=>(pulse=fn,1);h.ctx.clearInterval=()=>{}
 try{
  const second=await h.run('task',{communicationHandle:h.communicationHandle,objective:'product',members:['B'],requestId:'recovery-flag-other-task'}),first=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping',members:['B'],requestId:'recovery-flag-selected-task'})
  const notBefore=Date.now()+1000
  for(const [task,operationId]of [[second,'recovery-flag-other-operation'],[first,'recovery-flag-selected-operation']])await h.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:operationId,operationId,notBefore})
  const {scopes}=await h.scopeStatus({}),scope=scopes.find(scope=>scope.tasks[first.id])
  await reopen(h);h.human('A')
  await assert.rejects(h.run('collaboration_control',{scopeId:scope.id,taskId:second.id,action:'resume',reason:'legacy state changes do not grant a new work permission'}),/unavailable|current.*taskHandle/)
  const other=await h.run('status',{taskId:second.id});assert.equal(other.state,'recovery-required');assert.equal(other.recoveryRequired,true)
  await h.run('control',{object:'task',taskId:first.id,expectedRevision:1,action:'resume',reason:'explicitly recover only shipping',requestId:'recovery-flag-selected-control'})
  t.mock.timers.tick(1000);await pulse()
  const sends=h.effects.filter(row=>row[0]==='send'&&row[2].id.startsWith('recovery-flag-'))
  assert.deepEqual(sends.map(row=>row[2].id),['recovery-flag-selected-operation'])
  const untouched=await h.run('status',{taskId:second.id});assert.equal(untouched.recoveryRequired,true);assert.equal(untouched.operations[0].status,'scheduled');assert.equal(untouched.operations[0].wire,undefined)
 }finally{await(await h.env.collaboration).close()}
})

// Native commands only append command/run + command/done; they do not run the model.
test('native human recovery wakes the owner once to reconcile and do only remaining work',async t=>{
  const h=await tasksFixture();t.after(async()=>await (await h.env.collaboration).close())
  const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping: preserve stage1, do remaining stage2',members:['B'],requestId:'ui-recovery-task'})
  await h.run('send',{targets:['B'],content:'stage1 already completed',requestId:'ui-recovery-original',context:{communicationHandle:h.communicationHandle,taskHandle:task.taskHandle}})
  await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'wait for explicit resume',requestId:'ui-recovery-pause'})
  await reopen(h)
  const effects=h.effects.length,approvals=h.approvals.length,caller=h.agents.get('A')
  const input={object:'task',action:'resume',taskId:task.id,expectedRevision:1,reason:'resume remaining work',requestId:'ui-recovery-native'}
  const rawInput=' control '+JSON.stringify(input),commandId='native-resume-command'
  caller.session.append('command/run',{commandId,name:'coordinate',args:rawInput,source:{kind:'user'}})
  const payload={agent:caller,rawInput,commandId,signal:new AbortController().signal}
  const result=await sessionControlCommand(h.env,payload)
  assert.equal(result.kind,'success',result.text)
  assert.equal(JSON.parse(result.text).state,'active')
  const ownerInputs=h.effects.slice(effects).filter(e=>e[0]==='send'&&e[1]==='A')
  assert.equal(ownerInputs.length,1,'resume must actually give the idle owner the next input, without a manual continue')
  assert.equal(ownerInputs[0][2].source.kind,'session-collaboration','do not forge a human message')
  assert.match(ownerInputs[0][2].content[0].text,/核对|reconcile/)
  assert.equal(h.effects.slice(effects).filter(e=>e[0]==='send'&&e[1]==='B').length,0,'never replay old dispatch')
  assert.equal(h.approvals.length,approvals,'the verified user command is the approval')
  await sessionControlCommand(h.env,payload)
  assert.equal(h.effects.slice(effects).filter(e=>e[0]==='send'&&e[1]==='A').length,1,'same mutation cannot wake twice')
})

for(const ownerBusy of [false,true])test('native same-process resume notifies only the owner, busy='+ownerBusy,async t=>{
 const h=await tasksFixture(['A','B','C']);t.after(async()=>await(await h.env.collaboration).close())
 const shipping=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping remainder',members:['B'],requestId:'live-ui-shipping'})
 const other=await h.run('task',{communicationHandle:h.communicationHandle,objective:'independent product',members:['C'],requestId:'live-ui-product'})
 await h.run('control',{object:'task',action:'pause',taskHandle:shipping.taskHandle,expectedRevision:1,reason:'pause shipping only',requestId:'live-ui-pause'})
 const owner=h.agents.get('A'),modes=[],base=owner.steer.bind(owner)
 owner.status=ownerBusy?'running':'idle';owner.steer=m=>{modes.push('steer');base(m)};owner.followup=()=>assert.fail('resume must not wait for the entire current turn')
 const effects=h.effects.length,approvals=h.approvals.length
 const input={object:'task',action:'resume',taskHandle:shipping.taskHandle,expectedRevision:1,reason:'resume remaining shipping',requestId:'live-ui-resume'},rawInput='control '+JSON.stringify(input),commandId='native-live-resume'
 owner.session.append('command/run',{commandId,name:'coordinate',args:rawInput,source:{kind:'user'}})
 const result=await sessionControlCommand(h.env,{agent:owner,rawInput,commandId,signal:new AbortController().signal})
 assert.equal(result.kind,'success',result.text);assert.deepEqual(modes,['steer'])
 assert.deepEqual(h.effects.slice(effects).filter(e=>e[0]==='send').map(e=>e[1]),['A'])
 assert.equal((await h.run('status',{taskHandle:other.taskHandle})).state,'active')
 assert.equal(h.approvals.length,approvals)
})

for(const failure of ['cancel','flush-unknown'])test('native resume reports continuation uncertainty and never replays, '+failure,async t=>{
 const h=await tasksFixture();t.after(async()=>await(await h.env.collaboration).close())
 const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'remaining shipping',members:['B'],requestId:'failed-ui-task'})
 await h.run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'pause shipping',requestId:'failed-ui-pause'})
 const owner=h.agents.get('A'),abort=new AbortController(),before=h.effects.length
 const input={object:'task',action:'resume',taskHandle:task.taskHandle,expectedRevision:1,reason:'resume remaining',requestId:'failed-ui-resume'},rawInput='control '+JSON.stringify(input),commandId='native-failed-resume'
 owner.session.append('command/run',{commandId,name:'coordinate',args:rawInput,source:{kind:'user'}})
 let delivered=false
 owner.steer=m=>{delivered=true;h.effects.push(['send','A',m]);owner.session.append('user/message',m,{surfaceOp:'append'})}
 h.setFlush(async session=>{
  if(failure==='cancel'&&session.snapshotEvents().map(pluginRecordOf).some(r=>r?.type==='plugin:dsh-session-coordinator/control'&&r.data.requestId===input.requestId&&r.data.stage==='result'))abort.abort()
  return !(failure==='flush-unknown'&&delivered)
 })
 const payload={agent:owner,rawInput,commandId,signal:abort.signal},result=await sessionControlCommand(h.env,payload)
 assert.equal(result.kind,'error',result.text);assert.equal(JSON.parse(result.text).outcome,'unknown')
 assert.equal(JSON.parse(result.text).error.code,'RESUME_CONTINUATION_UNKNOWN')
 assert.equal(h.effects.slice(before).filter(e=>e[0]==='send').length,failure==='cancel'?0:1)
 h.setFlush(async()=>true)
 await sessionControlCommand(h.env,payload)
 assert.equal(h.effects.slice(before).filter(e=>e[0]==='send').length,failure==='cancel'?0:1,'uncertain or cancelled input must not be replayed')
})

test('a member native recovery notifies the actual owner through the selected restricted work permission',async t=>{
 const h=await tasksFixture(['A','B','C']);t.after(async()=>await(await h.env.collaboration).close())
 const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'shipping remainder',members:['B'],requestId:'member-ui-task'})
 await reopen(h)
 const caller=h.agents.get('B'),before=h.effects.length,approvals=h.approvals.length
 const input={object:'task',action:'resume',taskId:task.id,expectedRevision:1,reason:'explicitly resume remaining shipping',requestId:'member-ui-resume'},rawInput='control '+JSON.stringify(input),commandId='native-member-resume'
 caller.session.append('command/run',{commandId,name:'coordinate',args:rawInput,source:{kind:'user'}})
 const result=await sessionControlCommand(h.env,{agent:caller,rawInput,commandId,signal:new AbortController().signal})
 assert.equal(result.kind,'success',result.text)
 const inputs=h.effects.slice(before).filter(e=>e[0]==='send');assert.deepEqual(inputs.map(e=>e[1]),['A'])
 assert.equal(inputs[0][2].source.senderSessionId,'B');assert.equal(inputs[0][2].source.taskId,task.id)
 assert.equal(inputs[0][2].source.communicationHandle,JSON.parse(result.text).communicationHandle)
 assert.equal(h.approvals.length,approvals)
})
