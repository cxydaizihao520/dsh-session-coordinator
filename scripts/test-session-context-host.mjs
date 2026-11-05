// Read installed host code; assemble/serialize scratch inputs, never call a provider.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {Context} from 'cordis'
import {LlmError,contentHasImage} from '@deepseek-ai/dsh-llm'
import {fixture} from './fixtures/session-tools.mjs'
import * as plugin from '../src/index.ts'
const host=path=>execFileSync(process.execPath,['tools/asar.mjs','cat',path],{encoding:'utf8'})
let source=host('/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js')
for(const name of ['@deepseek-ai/cordis','@deepseek-ai/schemastery','@deepseek-ai/dsh-scope'])source=source.replaceAll('"'+name+'"',JSON.stringify(import.meta.resolve(name==='@deepseek-ai/cordis'?'cordis':name)))
const {SystemPrompt,renderContextSnapshot}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
const pi=host('/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),begin=pi.indexOf('//#region lib/types/context.js'),end=pi.indexOf('//#endregion',begin)
assert.ok(begin>=0&&end>begin)
const serialize=new Function('LlmError','contentHasImage',pi.slice(begin,end)+'\nreturn textOnlyContext;')(LlmError,contentHasImage)

test('native runtime-context and actual pi-ai conversion carry exact approved reply data outside business text',async()=>{
 const h=fixture();h.human('A');const root=new Context(),prompt=new SystemPrompt(root,{});
 h.ctx.inject=(_services,fn)=>fn({systemPrompt:prompt});plugin.registerSessionPrompt(h.ctx,h.env.delivery)
 const sent=await h.run('send',{targets:['B'],content:'  preserve business\n',requestId:'actual-context-once',authorizationRequest:{participants:['A','B'],purpose:'return report',extent:'message',reply:'once'}})
 const b=h.agents.get('B'),input=b.session.snapshotEvents().find(e=>e.type==='user/message').data;
 const without=serialize({messages:[input]});assert.equal(JSON.stringify(without).includes(sent.results[0].messageId),false,'negative control: source metadata is not sent by pi-ai');
 const text=renderContextSnapshot(await prompt.assemble({agent:b}));
 const wire=serialize({messages:[input,{role:'user',content:[{type:'text',text}],source:{kind:'runtime-context'}}]});
 assert.equal(wire.messages[0].content,'  preserve business\n');assert.ok(wire.messages[1].content.includes(sent.results[0].messageId));assert.ok(wire.messages[1].content.includes('"senderSessionId":"A"'));assert.ok(wire.messages[1].content.includes('"replyPermission":"once"'));
 await root.fiber.dispose();
})

test('native assembled follow-up retains surfaced reference facts without carrying earlier reply authority',async()=>{
 const h=fixture();h.human('A');const b=h.agents.get('B')
 b.ctx={get:name=>name==='sessionReferenceResolver'?{prepare:async(_agent,content)=>({content,additionalContext:{id:'reference',role:'user',source:{kind:'session-reference',form:'recall',version:1,references:[{sessionId:'C',capturedThroughSeq:4}]},content:[{type:'text',text:'preserve captured constraint'}]}})}:undefined}
 await h.run('send',{targets:['B'],content:[{type:'text',text:'review'},{type:'reference',sessionId:'C'}],authorizationRequest:{participants:['A','B'],purpose:'review',extent:'message',reply:'once'}})
 h.human('B')
 for(const reload of [false,true]){
  if(reload)h.reload()
  const root=new Context(),prompt=new SystemPrompt(root,{})
  h.ctx.inject=(_services,fn)=>fn({systemPrompt:prompt});plugin.registerSessionPrompt(h.ctx,h.env.delivery)
  const text=h.env.delivery.modelContext(b)
  assert.match(text,/preserve captured constraint/);assert.match(text,/"replyPermission":"none"/);assert.doesNotMatch(text,/"replyTo"|"communicationHandle"/)
  const wire=serialize({messages:[{role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:renderContextSnapshot(await prompt.assemble({agent:b}))}]}]})
  assert.match(wire.messages[0].content,/preserve captured constraint/);assert.match(wire.messages[0].content,/"replyPermission":"none"/)
  await root.fiber.dispose()
 }
})

const {z}=await import('zod'),{assembleContextFor}=await import('@deepseek-ai/dsh-agent'),{canonicalHeader,headerEquals}=await import('@deepseek-ai/dsh-session'),{deepFreeze}=await import('@deepseek-ai/dsh-util-values'),{markAgentLoopRequest,createDeveloperMessage}=await import('@deepseek-ai/dsh-llm');
const loop=host('/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js');
const inboxStart=loop.indexOf('//#region lib/types/inbox.js'),inboxEnd=loop.indexOf('//#endregion',inboxStart);
const {ReactLoopInbox,inboxProjectionDefinition}=new Function('z$1',loop.slice(inboxStart,inboxEnd)+'\nreturn {ReactLoopInbox,inboxProjectionDefinition}')(z);
const preStart=loop.indexOf('\tasync preStep(target, position) {'),preEnd=loop.indexOf('\n\t/** Whether the assembled tool schemas',preStart);
const {renderContextSections,joinContextSections,renderPrompt}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const preStep=new Function('assembleContextFor','renderContextSections','joinContextSections','return '+loop.slice(preStart,preEnd).trim().replace(/^async preStep\(/,'async function('))(assembleContextFor,renderContextSections,joinContextSections);
const stepStart=loop.indexOf('\tasync step(decision) {'),stepEnd=loop.indexOf('\n\t/** Resolve request config',stepStart);
const nativeStep=new Function('renderPrompt','renderContextSections','joinContextSections','assembleContextFor','return '+loop.slice(stepStart,stepEnd).trim().replace(/^async step\(/,'async function('))(renderPrompt,renderContextSections,joinContextSections,assembleContextFor);
const buildStart=loop.indexOf('\tbuildRequest(config, preparedCall, tools, position, startsRequestSeries, signal) {'),buildEnd=loop.indexOf('\n};',buildStart);
const nativeBuild=new Function('canonicalHeader','headerEquals','createDeveloperMessage','deepFreeze','markAgentLoopRequest','return '+loop.slice(buildStart,buildEnd).trim().replace(/^buildRequest\(/,'function('))(canonicalHeader,headerEquals,createDeveloperMessage,deepFreeze,markAgentLoopRequest);

test('native first claim → assembly → refresh → append → request exposes only actual current inputs',async()=>{
 const h=fixture();h.human('A');const root=new Context(),prompt=new SystemPrompt(root,{});h.ctx.inject=(_names,fn)=>fn({systemPrompt:prompt});plugin.registerSessionPrompt(h.ctx,h.env.delivery);
 const b=h.agents.get('B');b.status='idle';b.phase={kind:'running',turn:1,step:1,abort:new AbortController()};b.loopCtx={systemPrompt:prompt};
 b.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},b.session,{emit(name,payload){for(const fn of h.listeners.get(name)??[])fn({agent:b,...payload})}});
 b.steer=m=>b.inbox.append('next-step',m);b.followup=m=>b.inbox.append('next-turn',m);
 b.dispatch={waterfall:async(name,payload,next)=>(h.listeners.get(name)??[]).reduceRight((tail,fn)=>()=>fn({agent:b,...payload},tail),next)()};
 b.runtimeContext={project:text=>text?{id:'runtime-context-first-step',role:'user',source:{kind:'runtime-context'},content:[{type:'text',text}]}:undefined};
 const queued=await h.run('send',{targets:['B'],content:'future turn',delivery:'queue',requestId:'native-future-context'});
 const first=await h.run('send',{targets:['B'],content:'  exact first business\n',requestId:'native-first-context',authorizationRequest:{participants:['A','B'],purpose:'return report',extent:'message',reply:'once'}});
 assert.equal(b.session.snapshotEvents().filter(e=>e.type==='user/message').length,0);assert.doesNotMatch(h.env.delivery.modelContext(b),/"replyPermission"|"communicationHandle"|"replyTo"/,'pending input is not model context');
 b.status='running';const decision=await preStep.call(b,'next-step',{turn:1,step:1});
 assert.equal(b.session.snapshotEvents().filter(e=>e.type==='user/message').length,0,'native assembly precedes input history');
 assert.equal(first.results[0].admission,'accepted',JSON.stringify(first));assert.ok(h.env.delivery.modelContext(b).includes(first.results[0].messageId),'claimed context missing');
 b.prepareRequest=async()=>({config:{provider:'probe',model:'probe'}});b.systemPrompt={project:()=>[]};b.toolsChanged=()=>false;b.frozenMessages=new WeakSet();let request;
 const stop=Error('captured actual request without provider');b.buildRequest=function(...args){request=nativeBuild.call(this,...args);throw stop};
 await assert.rejects(nativeStep.call(b,decision),e=>e===stop);
 const wire=serialize(request),serialized=JSON.stringify(wire);assert.ok(serialized.includes(first.results[0].messageId));assert.ok(serialized.includes('replyPermission'));assert.equal(serialized.includes(queued.results[0].messageId),false);assert.ok(wire.messages.some(m=>m.content==='  exact first business\n'));assert.equal(b.inbox.nextTurn.length,1);
 await root.fiber.dispose();
})

test('native queued steering releases cursor wait and remains available for the next model step',async()=>{
 const h=fixture();h.human('A');const b=h.agents.get('B');b.status='running'
 b.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},b.session,{emit(name,payload){for(const fn of h.listeners.get(name)??[])fn({agent:b,...payload})}})
 b.steer=m=>b.inbox.append('next-step',m);b.followup=m=>b.inbox.append('next-turn',m)
 b.session.append('turn/start',{turn:1})
 for(const fn of h.listeners.get('agent/pre-step')??[])await fn({agent:b,turn:1,step:1,signal:new AbortController().signal,messages:[]},async()=>({kind:'enter',messages:[]}))
 const target=await h.run('status',{sessionId:'A'},'B')
 const waiting=h.run('wait',{targets:[{sessionId:'A',afterCursor:target.afterCursor,replyTo:'not-this-request'}],timeoutMs:500},'B')
 const sent=await h.run('send',{targets:['B'],content:'next business stage',requestId:'native-wait-steering',authorizationRequest:{participants:['A','B'],purpose:'business stages',extent:'work'}})
 assert.equal(sent.results[0].admission,'accepted',JSON.stringify(sent))
 const result=await waiting
 assert.equal(result.pendingInput,true);assert.equal(result.timedOut,false);assert.equal(result.aborted,false)
 assert.deepEqual(result.updates,[],'pending input is not a correlated business reply')
 assert.equal(b.inbox.nextStep.length,1);assert.equal(b.inbox.nextStep[0].id,sent.results[0].messageId)
 assert.equal(b.session.snapshotEvents().filter(e=>e.type==='user/message').length,0,'wait must not claim native input')
 assert.equal(b.inbox.nextTurn.length,0)
})
