// Built artifact with host-owned Session instances; isolated home, no DSH process/provider.
import assert from 'node:assert/strict'
import {Context} from 'cordis'
import {Storage} from '@deepseek-ai/dsh-storage'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, pluginRecordOf } from '@deepseek-ai/dsh-session'
const home=await mkdtemp(join(tmpdir(),'coordinator-bundle-'))
const previous=process.env.DSH_HOME;process.env.DSH_HOME=home
try {
 const duplicate = await import(import.meta.resolve('@deepseek-ai/dsh-session') + '?duplicate-for-probe')
 assert.throws(() => duplicate.appendPluginRecord(Session.create('negative-control'), 'plugin:probe/record', {}), /private|class/)
 const {apply}=await import('../lib/index.js')
 const agents=new Map(),tools=new Map()
 const make=id=>{const session=Session.create(id,undefined,{id,version:4,createdAt:1,isSeeded:false,delegationDepth:0,cwd:home});session.append('turn/start',{turn:0})
 const a={id,session,ctx:{},status:'idle',steer(m){session.append('user/message',m,{surfaceOp:'append'})},followup(m){this.steer(m)},inbox:{nextStep:[],nextTurn:[]}};agents.set(id,a);return a}
 const ctx={get:n=>n==='approval'?{request:async()=> 'allowed-once'}:undefined,tools:{register:t=>{tools.set(t.name,t);return()=>tools.delete(t.name)}},
 agents:{list:()=>[],get:id=>agents.get(id),create:async o=>({agent:make(o.sessionId)})},
 agentPresets:{composedPreset:()=>undefined,composeFrom:()=>undefined},
 sessions:{flush:async()=>true},workspaceRegistry:{list:()=>[],archivedSessionIds:[],resolveByPath:async()=>undefined},
 inject(){},on(){return()=>{}},effect(){},setInterval(){return 0},clearInterval(){}}
 make('A');apply(ctx)
 const run=(name,args,id,callId)=>tools.get('session_coordinator_'+name).execute(args,{agent:agents.get(id),callId,signal:new AbortController().signal})
 const sent=await run('create',{requestId:'bundle-create-task',initialMessage:{content:'bundle task',authorizationRequest:{purpose:'bundle task',extent:'message',reply:'once'}}},'A','create-call')
 assert.ok(agents.has(sent.sessionId))
 assert.ok(agents.get('A').session.snapshotEvents().some(e=>pluginRecordOf(e)?.type==='plugin:dsh-session-coordinator/creation'))
 await run('send',{targets:['A'],content:'bundle answer',replyTo:sent.initialMessage.messageId},sent.sessionId,'reply-call')
 apply(ctx) // Fresh plugin ledger; only owned durable-shaped evidence remains.
 const got=await run('wait',{targets:[{sessionId:sent.sessionId,afterCursor:sent.initialMessage.afterCursor,replyTo:sent.initialMessage.messageId}],timeoutMs:10},'A','read-call')
 assert.equal(got.updates[0].messages[0].text,'bundle answer')
 make('C');make('D')
 const current=await run('send',{targets:['D'],content:'  bundle v2\n',requestId:'bundle-v2-request',authorizationRequest:{participants:['C','D'],purpose:'check once',extent:'message',reply:'once'}},'C','v2-call')
 assert.equal(current.results[0].admission,'accepted',JSON.stringify(current))
 const response=await run('send',{targets:['C'],content:' verified\n',replyTo:current.results[0].messageId,requestId:'bundle-v2-response'},'D','v2-reply')
 assert.equal(response.results[0].admission,'accepted',JSON.stringify(response))
 const readArgs={sessionId:'C',limit:1}
 const read=await run('read',readArgs,'C','v2-read')
 const rendered=JSON.parse(tools.get('session_coordinator_read').output.render(readArgs,read)[0].text)
 assert.equal(rendered.messages[0].text,' verified\n');assert.ok(rendered.nextCursor)
 apply(ctx)
 const recovered=await run('wait',{targets:[{sessionId:'D',afterCursor:current.results[0].afterCursor,replyTo:current.results[0].messageId}],timeoutMs:10},'C','v2-recover')
 assert.equal(recovered.updates[0].messages[0].text,' verified\n')
 make('E');make('F')
 let work=await run('send',{targets:['F'],content:'Review shipping implementation',requestId:'bundle-work-first',authorizationRequest:{participants:['E','F'],purpose:'Implement and test shipping',extent:'work'}},'E','work-first')
 assert.equal(work.results[0].admission,'accepted');assert.ok(work.communicationHandle)
 const handle=work.communicationHandle,waitAnchor=work.results[0].afterCursor,waitReplyTo=work.results[0].messageId
 for(let i=0;i<5;i++){
  const caller=i%2===0?'F':'E',target=caller==='F'?'E':'F'
  work=await run('send',{targets:[target],content:'Verified stage '+i,context:{communicationHandle:handle},replyTo:work.results[0].messageId,requestId:'bundle-work-stage-'+i},caller,'work-stage-'+i)
  assert.equal(work.results[0].admission,'accepted',JSON.stringify(work))
 }
 const waited=await run('wait',{targets:[{sessionId:'F',afterCursor:waitAnchor,replyTo:waitReplyTo}],timeoutMs:10},'E','wait-work-reply')
 assert.equal(waited.updates[0].messages[0].text,'Verified stage 0')
 const exhausted=await run('wait',{targets:[{sessionId:'F',afterCursor:waited.cursors[0].afterCursor,replyTo:waitReplyTo}],timeoutMs:1},'E','wait-work-next')
 assert.equal(exhausted.updates.length,0);assert.equal(exhausted.timedOut,true)
 const received=agents.get('E').session.snapshotEvents().filter(e=>e.type==='user/message').at(-1)
 assert.equal(received.data.source.communicationHandle,handle)
 apply(ctx)
 const stale=await run('send',{targets:['F'],content:'Must not restore work permission',context:{communicationHandle:handle},requestId:'bundle-work-expired'},'E','work-expired')
 assert.equal(stale.results[0].admission,'rejected')
 make('G')
 const empty=await run('create',{requestId:'bundle-empty-create'},'G','empty-create');assert.equal(empty.creationState,'created');assert.equal(empty.initialMessage.admission,'not_requested');assert.equal(agents.get(empty.sessionId).session.snapshotEvents().filter(e=>e.type==='user/message').length,0)
 const initial=await run('create',{requestId:'bundle-first-create',initialMessage:{content:' exact initial\n',authorizationRequest:{purpose:'once',extent:'message',reply:'once'}}},'G','first-create');assert.equal(initial.initialMessage.admission,'accepted',JSON.stringify(initial))
 const initialReply=await run('send',{targets:['G'],content:'done',replyTo:initial.initialMessage.messageId},initial.sessionId,'initial-reply');assert.equal(initialReply.results[0].admission,'accepted',JSON.stringify(initialReply))
 apply(ctx);const recoveredEmpty=await run('create',{requestId:'bundle-empty-create'},'G','empty-retry');assert.equal(recoveredEmpty.sessionId,empty.sessionId)
 make('H');const controlled=make('I');controlled.followup=message=>controlled.inbox.nextTurn.push(message)
 controlled.inbox.replace=(id,message)=>{const index=controlled.inbox.nextTurn.findIndex(m=>m.id===id);if(index<0)return false;controlled.inbox.nextTurn.splice(index,1,message);return true}
 controlled.inbox.remove=id=>{const index=controlled.inbox.nextTurn.findIndex(m=>m.id===id);if(index<0)return false;controlled.inbox.nextTurn.splice(index,1);return true}
 const controlSend=await run('send',{targets:['I'],content:'original',delivery:'queue',requestId:'bundle-control-send',authorizationRequest:{participants:['H','I'],purpose:'check control',extent:'work'}},'H','control-send')
 const controlledId=controlSend.results[0].messageId
 const edit=await run('control',{object:'message',action:'edit',messageId:controlledId,expectedRevision:1,content:' changed\n',requestId:'bundle-control-edit'},'H','control-edit');assert.equal(edit.outcome,'edited');assert.equal(controlled.inbox.nextTurn[0].content[0].text,' changed\n')
 const withdrawal=await run('control',{object:'message',action:'withdraw',messageId:controlledId,requestId:'bundle-control-withdraw'},'H','control-withdraw');assert.equal(withdrawal.outcome,'withdrawn');assert.equal(controlled.inbox.nextTurn.length,0)
 const revoked=await run('control',{object:'communication',action:'revoke',handle:controlSend.communicationHandle,requestId:'bundle-control-revoke'},'H','control-revoke');assert.equal(revoked.communicationState,'revoked');assert.equal(revoked.inFlight[0].admission,'accepted')
 assert.equal(tools.has('session_coordinator_cancel'),false)
 // Mount the actual artifact task consumer with the native durable domain service.
 const storageContext=new Context();new Storage(storageContext)
 const cleanups=[]
 ctx.storage=storageContext.storage;ctx.emit=()=>{};ctx.logger=console
 ctx.effect=setup=>{const cleanup=setup();if(typeof cleanup==='function')cleanups.push(cleanup)}
 make('J');make('K');apply(ctx)
 const taskWork=await run('send',{targets:['K'],content:'independent shipping',authorizationRequest:{extent:'work',participants:['J','K'],purpose:'shipping'}},'J','bundle-task-work')
 const task=await run('task',{communicationHandle:taskWork.communicationHandle,objective:'shipping',members:['K'],requestId:'bundle-declare-task',budget:{maxOperations:4}},'J','bundle-task-declare')
 assert.equal(task.revision,1);assert.equal(task.budget.maxOperations,4)
 const taskMessage=await run('send',{targets:['K'],content:'compute shipping',context:{communicationHandle:taskWork.communicationHandle,taskHandle:task.taskHandle}},'J','bundle-task-send')
 assert.equal(taskMessage.results[0].admission,'accepted',JSON.stringify(taskMessage))
 assert.equal(agents.get('K').session.snapshotEvents().filter(e=>e.type==='user/message').at(-1).data.source.taskId,task.id)
 const checkpointArgs={taskHandle:task.taskHandle,action:'checkpoint',requestId:'bundle-task-checkpoint'}
 const checkpoint=await run('collaboration_material',checkpointArgs,'J','bundle-task-checkpoint-call')
 assert.equal(checkpoint.outcome,'completed');assert.equal(checkpoint.executionAuthority,'none')
 const readCheckpoint=await run('collaboration_material',{taskHandle:task.taskHandle,action:'read-context',contextId:checkpoint.contextId},'K','bundle-task-context-read')
 assert.equal(readCheckpoint.checkpoint.context.taskId,task.id)
 assert.deepEqual(await run('collaboration_material',checkpointArgs,'J','bundle-task-checkpoint-retry'),checkpoint)
 const taskPaused=await run('control',{object:'task',action:'pause',taskHandle:task.taskHandle,expectedRevision:1,reason:'user paused shipping',requestId:'bundle-task-pause'},'J','bundle-task-pause-call')
 assert.equal(taskPaused.state,'paused');assert.notEqual(taskPaused.workStopped,true)
 const lateTask=await run('send',{targets:['K'],content:'late shipping',context:{communicationHandle:taskWork.communicationHandle,taskHandle:task.taskHandle}},'J','bundle-task-late')
 assert.equal(lateTask.results[0].admission,'rejected')
 assert.equal((await run('status',{taskHandle:task.taskHandle},'J','bundle-task-status')).state,'paused')
 for(const cleanup of cleanups.reverse())cleanup()
 console.log('PASS built artifact: optional task/native storage, trusted source, independent pause and late dispatch refusal')
 // Allow the existing best-effort label registry writes to settle before deleting the test home.
 await new Promise(r=>setTimeout(r,50))
 console.log('PASS built artifact: host Session identity, creation, replies, recovery, work, exact edit/withdraw/revoke and removed legacy cancel')
} finally {
 if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
 await rm(home,{recursive:true,force:true})
}
