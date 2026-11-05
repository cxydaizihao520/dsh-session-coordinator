// Native rc.5 inbox/control methods on mounted scratch Sessions; no provider or desktop mutation.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {Context} from 'cordis'
import {SessionStore,ToolCallRecovery,pluginRecordOf} from '@deepseek-ai/dsh-session'
import {LlmError,errorChain} from '@deepseek-ai/dsh-llm'
import {z} from 'zod'
import {fixture} from './fixtures/session-tools.mjs'
import {registerCoordinateCommand} from '../src/coordinate.ts'
import {sessionControlCommand} from '../src/session-control.ts'
import {tasksFixture} from './fixtures/session-tasks.mjs'
import {installCollaboration} from '../src/collaboration-tools.ts'
const source=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'],{encoding:'utf8'})
const start=source.indexOf('//#region lib/types/inbox.js'),end=source.indexOf('//#endregion',start)
const {ReactLoopInbox,inboxProjectionDefinition}=new Function('z$1',source.slice(start,end)+'\nreturn {ReactLoopInbox,inboxProjectionDefinition}')(z)
const method=(first,last,parameters=[],values=[])=>{const start=source.indexOf(first),end=source.indexOf(last,start);assert.ok(start>=0&&end>start);return new Function(...parameters,'return '+source.slice(start,end).trim().replace(/^(async )?\w+\(/,(_m,async='')=>async+'function('))(...values)}
const cancel=method('\tcancel(cause, options = {}) {','\n\trunMaintenance(')
const causeStart=source.indexOf('function abortedCancelCause('),causeEnd=source.indexOf('\n/** Drives',causeStart)
const cancelCause=new Function('assertNever',source.slice(causeStart,causeEnd)+'\nreturn abortedCancelCause;')(value=>{throw Error('invalid native cancel cause '+JSON.stringify(value))})
const turn=method('\tasync turn() {','\n\tasync step(', ['ToolCallRecovery','abortedCancelCause','LlmError','errorChain'],[ToolCallRecovery,cancelCause,LlmError,errorChain])
const message=(id,text)=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text}]})

test('actual native command parser, lifecycle and cancellation reach shared human control without approval',async()=>{
 const commands=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js'],{encoding:'utf8'})
 const slice=(first,last)=>{const a=commands.indexOf(first),b=commands.indexOf(last,a);assert.ok(a>=0&&b>a);return commands.slice(a,b)}
 const helpers=slice('function parseCommand(line)', '/** Reject invalid command metadata')+slice('function normalizeResult(command, value)', '\nlet CommandRuntime =')
 const execute=new Function('NO_ATTACHMENTS',helpers+'\nreturn '+slice('\t\tasync execute(agent, line, submittedAttachments, signal) {','\n\t\t/** Contained').trim().replace('async execute(','async function('))(Object.freeze([]))
 const h=fixture();h.human('A');const b=h.agents.get('B');b.followup=m=>b.inbox.nextTurn.push(m);b.inbox.remove=id=>{const index=b.inbox.nextTurn.findIndex(m=>m.id===id);if(index<0)return false;b.inbox.nextTurn.splice(index,1);return true}
 const sent=await h.run('send',{targets:['B'],content:'native command withdrawal',delivery:'queue'})
 let definition;h.ctx.inject=(_names,fn)=>fn({commands:{register(value){definition=value}}})
 registerCoordinateCommand(h.ctx,h.grants,undefined,undefined,payload=>sessionControlCommand(h.env,payload))
 let seq=0;const runtime={view:()=>new Map([['coordinate',{definition}]]),mintCommandId:()=> 'native-real-command-'+(++seq),appendLifecycle:(session,type,data)=>session.append(type,data),settleThrown(){throw Error('native command unexpectedly threw')}}
 h.agents.get('A').session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 const before=h.approvals.length,result=await execute.call(runtime,h.agents.get('A'),'/coordinate control '+JSON.stringify({object:'message',action:'withdraw',messageId:sent.results[0].messageId,requestId:'actual-native-ui-withdraw'}),[],new AbortController().signal)
 assert.equal(result.result.kind,'success',result.result.text);assert.equal(JSON.parse(result.result.text).outcome,'withdrawn');assert.equal(h.approvals.length,before);assert.equal(b.inbox.nextTurn.length,0)
 const events=h.agents.get('A').session.snapshotEvents(),run=events.find(e=>e.type==='command/run')
 assert.equal(run.data.args.startsWith(' control '),true,'host preserves separator whitespace in rawInput')
 assert.equal(events.some(e=>e.type==='command/done'&&e.data.commandId===run.data.commandId),true)
 const abort=new AbortController();abort.abort();await assert.rejects(execute.call(runtime,h.agents.get('A'),'/coordinate controls',[],abort.signal));assert.equal(seq,1)

 const tasks=await tasksFixture(),task=await tasks.run('task',{communicationHandle:tasks.communicationHandle,objective:'only remaining shipping',members:['B'],requestId:'native-recovery-owner'})
 const store=(await tasks.env.collaboration).store
 await(await tasks.env.collaboration).close();tasks.listeners.clear();tasks.reload();tasks.env.collaboration=installCollaboration(tasks.env,{store});await tasks.env.collaboration
 const owner=tasks.agents.get('A'),inputs=[];let wakes=0
 owner.phase={kind:'idle'}
 owner.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},owner.session,{emit(name,payload){for(const fn of tasks.listeners.get(name)??[])fn({agent:owner,...payload})}})
 const splice=owner.inbox.splice.bind(owner.inbox)
 owner.inbox.splice=(target,start,count,messages)=>{inputs.push({target,messages});return splice(target,start,count,messages)}
 owner.wakeDriver=()=>{wakes++;owner.inbox.claim('next-turn',1)}
 owner.send=method('\tsend(message, target, wakeup) {','\n\tfollowup(')
 owner.steer=method('\tsteer(input) {','\n\tinject(')
 let taskDefinition;tasks.ctx.inject=(_names,fn)=>fn({commands:{register(value){taskDefinition=value}}})
 registerCoordinateCommand(tasks.ctx,tasks.grants,undefined,undefined,payload=>sessionControlCommand(tasks.env,payload))
 const taskRuntime={...runtime,view:()=>new Map([['coordinate',{definition:taskDefinition}]])},resumeApprovals=tasks.approvals.length
 try {
  const result=await execute.call(taskRuntime,owner,'/coordinate control '+JSON.stringify({object:'task',action:'resume',taskId:task.id,expectedRevision:1,reason:'checked history; do remaining work',requestId:'actual-native-ui-resume'}),[],new AbortController().signal)
  assert.equal(result.result.kind,'success',result.result.text);assert.equal(wakes,1);assert.equal(inputs.length,1);assert.equal(inputs[0].target,'next-step')
  assert.equal(inputs[0].messages[0].source.kind,'session-collaboration');assert.equal(tasks.approvals.length,resumeApprovals)
  assert.equal(owner.session.snapshotEvents().at(-1).type,'command/done','native command closes after the verified notification submission')
  const state=await tasks.run('status',{taskHandle:JSON.parse(result.result.text).taskHandle}),notification=state.operations.find(op=>op.id.startsWith('resume-notify-'))
  assert.equal(notification.status,'claimed','native wake claims before the delivery durability checkpoint returns')
  assert.equal(notification.admission,'accepted','confirmed durability is independent of model consumption state')
  const duplicate=await execute.call(taskRuntime,owner,'/coordinate control '+JSON.stringify({object:'task',action:'resume',taskId:task.id,expectedRevision:1,reason:'checked history; do remaining work',requestId:'actual-native-ui-resume'}),[],new AbortController().signal)
  assert.equal(duplicate.result.kind,'success',duplicate.result.text);assert.equal(wakes,1,'the same accepted notification cannot wake twice')
 }finally{await(await tasks.env.collaboration).close()}
})

function mounted(){
 const h=fixture(),root=new Context(),sessions=new SessionStore(root),session=sessions.prepare('B'),leave=sessions.enter(session);sessions.announce(session)
 const b=h.agents.get('B');b.session=session;b.phase={kind:'idle'}
 Object.defineProperty(b,'status',{get:()=>b.phase.kind==='idle'?'idle':'running'})
 root.on('session/event',(s,e)=>{for(const fn of h.listeners.get('session/event')??[])fn(s,e)})
 b.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},session,{emit(name,payload){for(const fn of h.listeners.get(name)??[])fn({agent:b,...payload})}})
 b.steer=m=>b.inbox.append('next-step',m);b.followup=m=>b.inbox.append('next-turn',m);b.cancel=cancel
 h.human('A');return {...h,b,root,async close(){leave();await root.fiber.dispose()}}
}

test('mounted native replace preserves queue position and discarded old version is not withdrawal',async()=>{
 const h=mounted();try{
 const sent=await h.run('send',{targets:['B'],content:'old',delivery:'queue',requestId:'native-control-edit-send'}),id=sent.results[0].messageId
 h.b.inbox.append('next-turn',message('other','keep'))
 const result=await h.run('control',{object:'message',action:'edit',messageId:id,expectedRevision:1,content:'  edited\n',requestId:'native-control-edit'})
 assert.equal(result.outcome,'edited');assert.deepEqual(h.b.inbox.nextTurn.map(m=>m.id),[id,'other']);assert.equal(h.b.inbox.nextTurn[0].content[0].text,'  edited\n')
 const status=await h.run('status',{sessionId:'B'});assert.equal(status.deliveries.find(x=>x.messageId===id).consumption,'pending')
 const claimed=h.b.inbox.claim('next-turn',1);assert.equal(claimed[0].content[0].text,'  edited\n');assert.equal((await h.run('status',{sessionId:'B'})).deliveries.find(x=>x.messageId===id).consumption,'claimed')
 const stale=await h.run('control',{object:'message',action:'withdraw',messageId:id,requestId:'native-control-after-claim'});assert.equal(stale.outcome,'already_claimed')
 }finally{await h.close()}
})

test('mounted native remove withdraws only pending input without touching other queue entries',async()=>{
 const h=mounted();try{
 const sent=await h.run('send',{targets:['B'],content:'remove',delivery:'queue',requestId:'native-control-remove-send'})
 h.b.inbox.append('next-step',message('other','keep'))
 const result=await h.run('control',{object:'message',action:'withdraw',messageId:sent.results[0].messageId,requestId:'native-control-remove'})
 assert.equal(result.outcome,'withdrawn');assert.equal(h.b.inbox.nextTurn.length,0);assert.equal(h.b.inbox.nextStep[0].id,'other')
 }finally{await h.close()}
})

test('a native inserted listener may claim an edit before replace returns without regressing consumption',async()=>{
 const h=mounted();try{
 const sent=await h.run('send',{targets:['B'],content:'old',delivery:'queue',requestId:'native-edit-claim-send'}),id=sent.results[0].messageId
 h.ctx.on('agent/inbox/inserted',({agent,message})=>{if(agent===h.b&&message.id===id&&message.content[0].text==='new')h.b.inbox.claim('next-turn',1)})
 const result=await h.run('control',{object:'message',action:'edit',messageId:id,expectedRevision:1,content:'new',requestId:'native-edit-claim-control'})
 assert.equal(result.outcome,'edited');assert.equal(h.b.inbox.nextTurn.length,0)
 const row=(await h.run('status',{sessionId:'B'})).deliveries.find(x=>x.messageId===id);assert.equal(row.revision,2);assert.equal(row.consumption,'claimed')
 }finally{await h.close()}
})

test('native cancel keeps unrelated inbox and native turn finally records the observed hook stop',async()=>{
 const h=mounted();try{
 const abort=new AbortController();h.b.phase={kind:'running',turn:0,step:0,abort,wakeRequested:false};h.b.ctx=h.root
 h.b.throwError=error=>{throw error};h.b.dispatch={serial:async()=>{}}
 h.b.preStep=async()=>{const payload={agent:h.b,turn:1,step:1,signal:abort.signal,messages:[message('active','work')]};return (h.listeners.get('agent/pre-step')??[]).reduceRight((tail,fn)=>()=>fn(payload,tail),async()=>({kind:'enter',messages:payload.messages}))()}
 let started;const ready=new Promise(resolve=>started=resolve)
 h.b.step=async()=>{started();return new Promise((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(abort.signal.reason),{once:true}))}
 const running=turn.call(h.b);running.catch(()=>{});await ready
 h.b.inbox.append('next-turn',message('other','keep'))
 const status=await h.run('status',{sessionId:'B'}),result=await h.run('control',{object:'execution',action:'interrupt',sessionId:'B',expectedExecution:status.executionId,requestId:'native-control-interrupt'})
 assert.equal(result.outcome,'requested');await assert.rejects(running,reason=>reason.kind==='hook')
 assert.equal(h.b.inbox.nextTurn[0].id,'other')
 const event=h.b.session.snapshotEvents().find(e=>e.type==='turn/end');assert.equal(event.data.reason.kind,'aborted');assert.equal(event.data.reason.reason.kind,'hook')
 const after=await h.run('status',{sessionId:'B'});assert.equal(after.controls[0].executionStopped,true);assert.equal(after.controls[0].workStopped,'unknown')
 const context=h.env.delivery.modelContext(h.b),facts=JSON.parse(context.slice(context.indexOf('\n')+1))
 assert.deepEqual(facts.interruptedExecution,{executionId:status.executionId,requestId:'native-control-interrupt'})
 assert.equal(h.b.inbox.nextTurn[0].id,'other')
 }finally{await h.close()}
})

for(const scenario of ['reload-edit','edit-throws','withdraw-throws','source-conflict'])test('receive-only maintenance follows native version: '+scenario,async()=>{
 const h=mounted();try{
 h.b.phase={kind:'running'};h.b.runMaintenance=()=>{throw Error('busy')};h.b.whenIdle=()=>new Promise(()=>{});h.b.send=(m,t)=>h.b.inbox.append(t,m);h.b.inject=m=>h.b.inbox.append('next-step',m)
 const sent=await h.run('send',{targets:['B'],content:'old context',delivery:'context',requestId:'native-maintenance-send'}),id=sent.results[0].messageId
 assert.equal(sent.results[0].admission,'accepted')
 if(scenario==='source-conflict'){
  const old=h.b.inbox.nextStep[0];h.b.inbox.replace(id,{...old,source:{...old.source,senderSessionId:'forged-other'}})
 }else{
  const action=scenario==='withdraw-throws'?'withdraw':'edit',method=action==='edit'?'replace':'remove'
  if(scenario.endsWith('throws')){const native=h.b.inbox[method].bind(h.b.inbox);let thrown=false;h.b.inbox[method]=(...args)=>{const result=native(...args);if(!thrown){thrown=true;throw Error('completion unknown')}return result}}
  const result=await h.run('control',{object:'message',action,messageId:id,...(action==='edit'?{expectedRevision:1,content:'new context'}:{}),requestId:'native-maintenance-control'})
  assert.equal(result.outcome,scenario.endsWith('throws')?'unknown':'edited')
 }
 h.b.phase={kind:'idle'};h.b.runMaintenance=async fn=>fn(new AbortController().signal)
 if(scenario==='reload-edit'||scenario==='source-conflict'){h.ctx.agents.list=()=>[h.b];h.reload()}
 else for(const fn of h.listeners.get('agent/status')??[])fn({agent:h.b,status:'idle'})
 await new Promise(resolve=>setImmediate(resolve))
 const history=h.b.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===id)
 if(scenario==='withdraw-throws'){assert.equal(history.length,0);assert.equal(h.b.inbox.nextStep.length,0)}
 else if(scenario==='source-conflict'){assert.equal(history.length,0);assert.equal(h.b.inbox.nextStep.length,1)}
 else {assert.equal(history.length,1);assert.equal(history[0].data.content[0].text,'new context');assert.equal(h.b.inbox.nextStep.length,0)}
 }finally{await h.close()}
})

for(const uncertain of [false,true])test('multipart edit drops current reference snapshot and preserves original evidence: '+uncertain,async()=>{
 const h=mounted();try{
 h.b.phase={kind:'running'};h.b.runMaintenance=()=>{throw Error('busy')};h.b.whenIdle=()=>new Promise(()=>{});h.b.send=(m,t)=>h.b.inbox.append(t,m);h.b.inject=m=>h.b.inbox.append('next-step',m)
 h.b.ctx={get:name=>name==='sessionReferenceResolver'?{prepare:async(_agent,content)=>({content,additionalContext:{id:'old-reference',role:'user',source:{kind:'session-reference',version:1,references:[{sessionId:'C',capturedThroughSeq:1}]},content:[{type:'text',text:'obsolete reference evidence'}]}})}:undefined}
 const args={targets:['B'],content:[{type:'text',text:'old first'},{type:'reference',sessionId:'C'},{type:'text',text:'old last'}],delivery:'context',requestId:'multipart-control-send'}
 const sent=await h.run('send',args),id=sent.results[0].messageId,original=structuredClone(h.b.inbox.nextStep[0])
 assert.equal(sent.results[0].admission,'accepted')
 if(uncertain){const replace=h.b.inbox.replace.bind(h.b.inbox);h.b.inbox.replace=(...args)=>{replace(...args);throw Error('native edit receipt lost')}}
 const result=await h.run('control',{object:'message',action:'edit',messageId:id,expectedRevision:1,content:'  replacement only\n',requestId:'multipart-control-edit'})
 assert.equal(result.outcome,uncertain?'unknown':'edited',JSON.stringify(result))
 assert.deepEqual(h.b.inbox.nextStep[0].content,[{type:'text',text:'  replacement only\n'}]);assert.equal(h.b.inbox.nextStep[0].source.contentSnapshot,undefined)
 assert.deepEqual(await h.run('send',args),sent)
 const intent=h.agents.get('A').session.snapshotEvents().map(pluginRecordOf).find(r=>r?.data?.stage==='intent'&&r.data.message?.id===id)
 assert.deepEqual(intent.data.message,original)
 h.b.phase={kind:'idle'};h.b.runMaintenance=async fn=>fn(new AbortController().signal);h.ctx.agents.list=()=>[h.b];h.reload()
 await new Promise(resolve=>setImmediate(resolve))
 const history=h.b.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===id)
 assert.equal(history.length,1);assert.equal(history[0].data.content[0].text,'  replacement only\n');assert.equal(history[0].data.source.contentSnapshot,undefined)
 assert.doesNotMatch(h.env.delivery.modelContext(h.b),/obsolete reference evidence/)
 assert.equal(h.b.inbox.nextStep.length,0)
 }finally{await h.close()}
})
