import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {surfaceFixture} from './fixtures/session-tool-surface.mjs'
import {SessionToolSurface} from '../src/session-tool-surface.ts'
import {CollaborationRuntime} from '../src/collaboration.ts'
const require=createRequire(import.meta.url)
const {Context}=require('cordis'),{z}=require('zod'),{assembleContextFor}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')).href)
let source=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'],{encoding:'utf8'})
for(const name of ['@deepseek-ai/cordis','@deepseek-ai/schemastery','@deepseek-ai/dsh-scope'])source=source.replaceAll('"'+name+'"',JSON.stringify(pathToFileURL(require.resolve(name==='@deepseek-ai/cordis'?'cordis':name)).href))
const {SystemPrompt,renderContextSections,joinContextSections}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
const loop=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'],{encoding:'utf8'}),start=loop.indexOf('//#region lib/types/inbox.js'),end=loop.indexOf('//#endregion',start)
const {ReactLoopInbox,inboxProjectionDefinition}=new Function('z$1',loop.slice(start,end)+'\nreturn {ReactLoopInbox,inboxProjectionDefinition}')(z)
const preStart=loop.indexOf('\tasync preStep(target, position) {'),preEnd=loop.indexOf('\n\t/** Whether the assembled tool schemas',preStart)
const preStep=new Function('assembleContextFor','renderContextSections','joinContextSections','return '+loop.slice(preStart,preEnd).trim().replace(/^async preStep\(/,'async function('))(assembleContextFor,renderContextSections,joinContextSections)

for(const mixed of [false,true])test('first claimed old input is filtered during native readiness; unrelated input preserved: '+mixed,async t=>{
 const h=await surfaceFixture(t),b=h.agents.get('B'),scope=await h.legacy()
 const task=await h.run('collaboration_task',{scopeId:scope.id,objective:'old business task',members:['B']})
 await h.run('collaboration_send',{scopeId:scope.id,taskId:task.id,taskRevision:1,sessionId:'B',intent:'task',message:'must not execute before explicit recovery'})
 const wire=structuredClone(b.inbox.nextStep[0]??b.inbox.nextTurn[0])
 h.env.toolSurface.dispose();await h.runtime.close()
 let release,entered
 const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>entered=resolve)
 const disposeSentinel=h.ctx.on('agent/pre-step',(_input,next)=>{entered();return next()})
 const ready=CollaborationRuntime.open(h.env,{...h.store,list:()=>gate})
 h.env.collaboration=ready;const surface=new SessionToolSurface(h.env,ready,new Map());h.env.toolSurface=surface
 const promptRoot=new Context(),prompt=new SystemPrompt(promptRoot,{})
 b.status='running';b.phase={kind:'running',turn:1,step:0,abort:new AbortController()};b.loopCtx={systemPrompt:prompt}
 b.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},b.session,{emit(name,payload){h.ctx.emit(b,name,{agent:b,...payload})}})
 b.inbox.append('next-turn',wire)
 if(mixed)b.inbox.append('next-step',{id:'unrelated-input',role:'user',source:{kind:'user'},content:[{type:'text',text:'new independent user question'}]})
 b.dispatch={waterfall:(name,payload,next)=>h.ctx.waterfall(b,name,{agent:b,...payload},next)}
 b.runtimeContext={project:()=>undefined}
 try{
  const pending=preStep.call(b,'next-turn',{turn:1,step:1})
  await waiting;release([...h.records.values()].map(record=>structuredClone(record)))
  const runtime=await ready,decision=await pending
  assert.equal((await runtime.status({scopeId:scope.id},h.exec())).state,'recovery-required')
  assert.equal(decision.kind==='enter'&&decision.messages.some(message=>message.id===wire.id),false,'late registered runtime filter must cover the already-built current pipeline')
  if(mixed){assert.equal(decision.kind,'enter');assert.ok(decision.messages.some(message=>message.id==='unrelated-input'))}else assert.equal(decision.kind,'reject')
 }finally{release?.([]);surface.dispose();disposeSentinel();await(await ready).close();await promptRoot.fiber.dispose()}
})

for(const mixed of [false])test('native pre-step cancellation does not wait for unrelated store initialization',async t=>{
 const h=await surfaceFixture(t),b=h.agents.get('B'),scope=await h.legacy()
 const task=await h.run('collaboration_task',{scopeId:scope.id,objective:'old business task',members:['B']})
 await h.run('collaboration_send',{scopeId:scope.id,taskId:task.id,taskRevision:1,sessionId:'B',intent:'task',message:'must not execute before explicit recovery'})
 const wire=structuredClone(b.inbox.nextStep[0]??b.inbox.nextTurn[0])
 h.env.toolSurface.dispose();await h.runtime.close()
 let release,entered
 const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>entered=resolve)
 const disposeSentinel=h.ctx.on('agent/pre-step',(_input,next)=>{entered();return next()})
 const ready=CollaborationRuntime.open(h.env,{...h.store,list:()=>gate})
 h.env.collaboration=ready;const surface=new SessionToolSurface(h.env,ready,new Map());h.env.toolSurface=surface
 const promptRoot=new Context(),prompt=new SystemPrompt(promptRoot,{})
 b.status='running';b.phase={kind:'running',turn:1,step:0,abort:new AbortController()};b.loopCtx={systemPrompt:prompt}
 b.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},b.session,{emit(name,payload){h.ctx.emit(b,name,{agent:b,...payload})}})
 b.inbox.append('next-turn',wire)
 if(mixed)b.inbox.append('next-step',{id:'unrelated-input',role:'user',source:{kind:'user'},content:[{type:'text',text:'new independent user question'}]})
 b.dispatch={waterfall:(name,payload,next)=>h.ctx.waterfall(b,name,{agent:b,...payload},next)}
 b.runtimeContext={project:()=>undefined}
 try{
  const pending=preStep.call(b,'next-turn',{turn:1,step:1})
  await waiting;b.phase.abort.abort(new Error('native turn cancelled'))
  const cancelled=await Promise.race([pending.then(()=>true,()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),30))])
  release([...h.records.values()].map(record=>structuredClone(record)))
  const runtime=await ready,decision=await pending.catch(error=>({kind:'reject',error}))
  assert.equal(cancelled,true,'native turn cancellation must release its pre-step even while store.list remains unresolved')
  assert.equal((await runtime.status({scopeId:scope.id},h.exec())).state,'recovery-required')
  assert.equal(decision.kind==='enter'&&decision.messages.some(message=>message.id===wire.id),false,'late registered runtime filter must cover the already-built current pipeline')
  if(mixed){assert.equal(decision.kind,'enter');assert.ok(decision.messages.some(message=>message.id==='unrelated-input'))}else assert.equal(decision.kind,'reject')
 }finally{release?.([]);surface.dispose();disposeSentinel();await(await ready).close();await promptRoot.fiber.dispose()}
})
