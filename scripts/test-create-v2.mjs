import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './fixtures/session-tools.mjs'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'

test('uncertain final creation receipt retains identity without a fresh wait target or replay',async()=>{
 const h=fixture();h.human('A')
 h.setFlush(async session=>{
  if(session.id!=='A')return true
  const creation=session.snapshotEvents().map(pluginRecordOf).findLast(record=>record?.type==='plugin:dsh-session-coordinator/creation')
  return creation?.data.receipt.initialMessage.admission!=='accepted'
 })
 const args={requestId:'uncertain-create-receipt',initialMessage:{content:'review',authorizationRequest:{purpose:'review',extent:'message',reply:'once'}}}
 const result=await h.run('create',args)
 assert.equal(result.creationState,'created');assert.equal(result.initialMessage.admission,'unknown')
 assert.equal(result.initialMessage.waitTarget,undefined)
 const effects=h.effects.length
 assert.deepEqual(await h.run('create',args),result)
 assert.equal(h.effects.length,effects)
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1)
 assert.equal(h.effects.filter(e=>e[0]==='send').length,1)
})

test('created first message stays single-purpose when an existing work reply arrives during creation', async()=>{
 const h=fixture();h.human('A');
 const work=await h.run('send',{targets:['B'],content:'review existing work',requestId:'create-with-existing-work',authorizationRequest:{participants:['A','B'],purpose:'existing review',extent:'work'}});
 assert.equal(work.results[0].admission,'accepted');h.human('A');
 const create=h.ctx.agents.create;h.ctx.agents.create=async options=>{
  const made=await create(options);
  const reply=await h.run('send',{targets:['A'],content:'existing work result',requestId:'existing-work-during-create',context:{communicationHandle:work.communicationHandle}},'B');
  assert.equal(reply.results[0].admission,'accepted');return made;
 };
 const result=await h.run('create',{requestId:'new-chat-separate-purpose',initialMessage:{content:'a distinct first message',authorizationRequest:{purpose:'new independent check',extent:'message',reply:'once'}}});
 assert.equal(result.creationState,'created');assert.equal(result.initialMessage.admission,'accepted',JSON.stringify(result));
 const first=h.effects.find(e=>e[0]==='send'&&e[1]===result.sessionId)[2];
 assert.equal(first.source.communicationHandle,undefined);assert.equal(first.content[0].text,'a distinct first message');
 assert.equal(h.approvals.length,2);assert.equal(h.effects.filter(e=>e[0]==='create').length,1);
});

test('empty independent creation has identity and no input or model wakeup', async()=>{
 const h=fixture();h.human('A');const result=await h.run('create',{requestId:'empty-create-01'});
 assert.equal(result.creationState,'created');assert.equal(result.initialMessage.admission,'not_requested');
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1);assert.equal(h.effects.filter(e=>e[0]==='send').length,0);
 const again=await h.run('create',{requestId:'empty-create-01'});assert.equal(again.sessionId,result.sessionId);
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1);
 const second=await h.run('create',{requestId:'empty-create-02'});assert.notEqual(second.sessionId,result.sessionId);
})

test('native registry keeps created chat after plugin disposal and preserves service isolation', async()=>{
 const {Context,getTraceable}=await import('cordis');const {AgentRegistry}=await import('@deepseek-ai/dsh-agent');const {Session}=await import('@deepseek-ai/dsh-session');
 const {createBridgeSession}=await import('../src/session-create.ts');
 const root=new Context();new AgentRegistry(root);const isolated=root.isolate('agents');const registry=new AgentRegistry(isolated);
 const owners=[];registry.setFactory({async createAgent(owner,options){
   owners.push(owner);assert.equal(options.signal,abort.signal);const session=Session.create(options.sessionId,undefined,{version:4,id:options.sessionId,createdAt:1,isSeeded:false,delegationDepth:0,cwd:'/tmp'});
   const agent={id:options.sessionId,ctx:owner,session,status:'idle'};
   await getTraceable(owner,registry).register(agent);return {agent};
 }});
 isolated.provide('workspaceRegistry');isolated.provide('agentPresets');
 isolated.set('workspaceRegistry',{list:()=>[],resolveByPath:async()=>undefined});isolated.set('agentPresets',{composedPreset(){}});
 let pluginCtx;const fork=isolated.plugin({inject:['agents','workspaceRegistry','agentPresets'],apply(ctx){pluginCtx=ctx}});
 await fork;
 const abort=new AbortController();const result=await createBridgeSession(pluginCtx,{record(){}},{sessionId:'independent-native',cwd:'/tmp',signal:abort.signal});
 assert.ok(registry.get(result.sessionId) === result.agent,'created chat must remain registered');assert.equal(root.agents.get(result.sessionId),undefined);
 await fork.dispose();assert.ok(registry.get(result.sessionId) === result.agent,'created chat must remain registered');
 await root.fiber.dispose();assert.equal(registry.get(result.sessionId),undefined);
})

test('first message reuses unified exact delivery and one approved reply',async()=>{
 const h=fixture();h.human('A');const content='  exact\n task  ';
 const result=await h.run('create',{requestId:'first-create-01',initialMessage:{content,authorizationRequest:{purpose:'review',extent:'message',reply:'once'}}});
 assert.equal(result.creationState,'created');assert.equal(result.initialMessage.admission,'accepted');
 const entry=h.effects.find(e=>e[0]==='send');assert.equal(entry[2].content[0].text,content);
 const reply=await h.run('send',{targets:['A'],content:'done',replyTo:result.initialMessage.messageId},result.sessionId);
 assert.equal(reply.results[0].admission,'accepted');assert.equal(h.approvals.length,1);
})

test('first-message rejection retries the same created identity and conflicts cannot mutate it',async()=>{
 const h=fixture();h.human('A');const create=h.ctx.agents.create;h.ctx.agents.create=async o=>{const result=await create(o);h.ctx.workspaceRegistry.archivedSessionIds=[o.sessionId];return result};
 const args={requestId:'retry-create-01',initialMessage:{content:'task'}};const first=await h.run('create',args);
 assert.equal(first.creationState,'created');assert.equal(first.initialMessage.admission,'rejected');
 h.ctx.workspaceRegistry.archivedSessionIds=[];const second=await h.run('create',args);
 assert.equal(second.sessionId,first.sessionId);assert.equal(second.initialMessage.admission,'accepted');
 assert.equal(h.effects.filter(e=>e[0]==='create').length,1);assert.equal(h.effects.filter(e=>e[0]==='send').length,1);
 await assert.rejects(h.run('create',{...args,title:'changed'}),/REQUEST_CONFLICT/);
 h.reload();const recovered=await h.run('create',args);assert.equal(recovered.sessionId,first.sessionId);assert.equal(recovered.initialMessage.admission,'accepted');assert.equal(h.effects.filter(e=>e[0]==='send').length,1);
})

test('unknown native admission is never resent and cancellation retains created identity',async()=>{
 const h=fixture();h.human('A');const create=h.ctx.agents.create;h.ctx.agents.create=async o=>{const result=await create(o);result.agent.steer=()=>{h.effects.push(['attempt']);throw Error('transport uncertain')};return result};
 const args={requestId:'unknown-create-1',initialMessage:{content:'task'}};const result=await h.run('create',args);assert.equal(result.initialMessage.admission,'unknown');assert.equal(typeof result.initialMessage.messageId,'string');
 await h.run('create',args);h.reload();await h.run('create',args);assert.equal(h.effects.filter(e=>e[0]==='attempt').length,1);
 const c=fixture(),abort=new AbortController(),original=c.ctx.agents.create;c.ctx.agents.create=async o=>{const made=await original(o);abort.abort({code:'user-stop'});return made};
 const cancelled=await c.run('create',{requestId:'cancel-create-01',initialMessage:{content:'task'}},'A',{signal:abort.signal});
 assert.equal(cancelled.creationState,'created');assert.equal(cancelled.initialMessage.admission,'rejected');assert.equal(c.effects.filter(e=>e[0]==='send').length,0);assert.ok(c.agents.has(cancelled.sessionId));
})

test('concurrent same request creates once; reload preserves empty identity without new approval',async()=>{
 const h=fixture();h.human('A');let release;h.setAnswer(()=>new Promise(r=>{release=r}));
 const args={requestId:'concurrent-create'};const a=h.run('create',args),b=h.run('create',args);
 while(!release) await new Promise(r=>setImmediate(r));release('allowed-once');
 const [first,second]=await Promise.all([a,b]);assert.equal(first.sessionId,second.sessionId);assert.equal(h.approvals.length,1);assert.equal(h.effects.filter(e=>e[0]==='create').length,1);
 h.reload();assert.equal((await h.run('create',args)).sessionId,first.sessionId);assert.equal(h.approvals.length,1);
})

test('approval rejection, durability failure and uncertain creation never spawn a replacement',async()=>{
 const denied=fixture();denied.setAnswer(async()=> 'rejected');await assert.rejects(denied.run('create',{requestId:'denied-create-01'}),/not authorized/);assert.equal(denied.effects.length,0);
 const disk=fixture();disk.setFlush(async()=>false);const args={requestId:'disk-create-01'};await assert.rejects(disk.run('create',args),/durability/);assert.equal(disk.effects.length,0);disk.reload();assert.equal((await disk.run('create',args)).creationState,'unknown');assert.equal(disk.effects.length,0);
 const unknown=fixture();unknown.ctx.agents.create=async()=>{unknown.effects.push(['attempt']);throw Error('native completion unknown')};const input={requestId:'native-create-01',initialMessage:{content:'task'}};
 const result=await unknown.run('create',input);assert.equal(result.creationState,'unknown');await unknown.run('create',input);unknown.reload();await unknown.run('create',input);assert.equal(unknown.effects.length,1);
 const wrong=fixture();const create=wrong.ctx.agents.create;wrong.ctx.agents.create=o=>create({...o,sessionId:'different-native-id'});const mismatch=await wrong.run('create',{requestId:'wrong-create-01',initialMessage:{content:'task'}});assert.equal(mismatch.creationState,'unknown');assert.equal(wrong.effects.filter(e=>e[0]==='send').length,0);
})

test('request identity is independent of object key order',async()=>{
 const h=fixture();h.human('A');const first=await h.run('create',{requestId:'ordered-create-01',title:'named',initialMessage:{content:'task',delivery:'message'}});
 const next=await h.run('create',{initialMessage:{delivery:'message',content:'task'},title:'named',requestId:'ordered-create-01'});assert.equal(next.sessionId,first.sessionId);assert.equal(h.effects.filter(e=>e[0]==='send').length,1);
})

test('known pre-create cancellation can retry its identity after new human input; denial cannot reopen approval',async()=>{
 const h=fixture();h.human('A');const args={requestId:'pre-cancel-create'},abort=new AbortController();abort.abort({code:'user-stop'});
 await assert.rejects(h.run('create',args,'A',{signal:abort.signal}),/cancelled/);assert.equal(h.effects.length,0);
 h.human('A');const retried=await h.run('create',args);assert.equal(retried.creationState,'created');assert.equal(h.effects.filter(e=>e[0]==='create').length,1);
 const denied=fixture();denied.human('A');denied.setAnswer(async()=> 'rejected');const deniedArgs={requestId:'denied-retry-create'};
 await assert.rejects(denied.run('create',deniedArgs),/not authorized/);await assert.rejects(denied.run('create',deniedArgs),/rejected|reject/i);assert.equal(denied.approvals.length,1);assert.equal(denied.effects.length,0);
 denied.human('A');denied.setAnswer(async()=> 'allowed-once');assert.equal((await denied.run('create',deniedArgs)).creationState,'created');assert.equal(denied.approvals.length,2);
})

test('v2 create names only actual conflicting keys and supplies the independent wait cursor',async()=>{
 const h=fixture();h.human('A');const args={requestId:'clear-create-01',title:'retain title',cwd:'/tmp/probe',initialMessage:{content:'task'},waitForReply:true};
 await assert.rejects(h.run('create',args),error=>error.message.includes('waitForReply')&&!error.message.includes('title')&&!error.message.includes('cwd'));
 delete args.waitForReply;const created=await h.run('create',args);assert.equal(typeof created.initialMessage.afterCursor,'string');assert.equal(created.initialMessage.replyPermission,'none');
})

test('create first work scope binds the actual new identity and permits further rounds with one approval',async()=>{
 const h=fixture();h.human('A');const result=await h.run('create',{requestId:'create-work-rounds',initialMessage:{content:'implement and review',authorizationRequest:{purpose:'implement and review',extent:'work'}}});
 assert.equal(result.initialMessage.admission,'accepted');assert.equal(result.initialMessage.replyPermission,'work');assert.ok(result.initialMessage.communicationHandle);assert.equal(h.approvals.length,1);
 const reply=await h.run('send',{targets:['A'],content:'review result',context:{communicationHandle:result.initialMessage.communicationHandle}},result.sessionId);assert.equal(reply.results[0].admission,'accepted');assert.equal(h.approvals.length,1);
 assert.match(h.env.delivery.modelContext(h.agents.get(result.sessionId)),new RegExp(result.sessionId));
})

test('created control scope approves the actual new identity once and never restores a historical control handle',async()=>{
 const h=fixture();h.human('A');const create=h.ctx.agents.create
 h.ctx.agents.create=async options=>{const made=await create(options),agent=made.agent;agent.followup=message=>agent.inbox.nextTurn.push(message);agent.inbox.remove=id=>{const index=agent.inbox.nextTurn.findIndex(message=>message.id===id);if(index<0)return false;agent.inbox.nextTurn.splice(index,1);return true};return made}
 const args={requestId:'create-with-bound-controls',initialMessage:{content:'independent review',delivery:'queue',authorizationRequest:{purpose:'independent review',extent:'work',controls:{actions:['message.withdraw']}}}}
 const result=await h.run('create',args)
 assert.equal(result.initialMessage.admission,'accepted');assert.equal(typeof result.initialMessage.controlHandle,'string');assert.equal(h.approvals.length,1)
 const approved=JSON.parse(h.approvals[0].reason).initialMessage.authorizationRequest.controls
 assert.deepEqual(approved.controllers,['A']);assert.deepEqual(approved.targets,['A',result.sessionId].sort())
 assert.equal((await h.run('control',{object:'message',action:'withdraw',messageId:result.initialMessage.messageId,controlHandle:result.initialMessage.controlHandle,requestId:'created-approved-withdraw'})).outcome,'withdrawn');assert.equal(h.approvals.length,1)
 h.reload();const recovered=await h.run('create',args)
 assert.equal(recovered.sessionId,result.sessionId);assert.equal(recovered.historical,true);assert.equal(recovered.initialMessage.controlHandle,undefined);assert.equal(recovered.initialMessage.communicationHandle,undefined);assert.equal(h.approvals.length,1)
})

test('create passes queue and context to the same native sender and never relaxes strict steer',async()=>{
 for(const delivery of ['queue','context','steer']){
  const h=fixture();h.human('A');const create=h.ctx.agents.create;h.ctx.agents.create=async options=>{const out=await create(options);out.agent.inbox.remove=()=>false;out.agent.send=()=>{};out.agent.whenIdle=()=>new Promise(()=>{});out.agent.runMaintenance=async fn=>{h.effects.push(['context',out.agent.id]);return fn(new AbortController().signal)};out.agent.followup=m=>{h.effects.push(['queue',out.agent.id,m])};out.agent.inject=m=>{h.effects.push(['context',out.agent.id,m]);out.agent.session.append('user/message',m,{surfaceOp:'append'})};return out};
  const result=await h.run('create',{requestId:'create-mode-'+delivery,initialMessage:{content:'retained body',delivery,...(delivery==='steer'?{expectedExecution:'stale-execution'}:{})}});
  assert.equal(result.creationState,'created');assert.equal(result.initialMessage.admission,delivery==='steer'?'rejected':'accepted',JSON.stringify(result));assert.equal(h.effects.filter(e=>e[0]==='send').length,0);assert.equal(h.effects.filter(e=>e[0]===delivery).length,delivery==='steer'?0:1);
 }
})
