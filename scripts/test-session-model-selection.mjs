import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Session} from '@deepseek-ai/dsh-session'
import * as agentApi from '@deepseek-ai/dsh-agent'
import {createBridgeSession} from '../src/session-create.ts'
import {readSessionModelSelection} from '../src/session-model-selection.ts'
import {nativeModelSelection} from './fixtures/native-model.mjs'
import {existsSync} from 'node:fs'

function harness(projection=agentApi.modelSelectionProjectionDefinition) {
 const hooks=new Map(), sessions=new Map();let pending=null
 const ctx={get(name){return name==='llm'?{resolveCallConfig:async x=>x}:name==='sessionProjections'?{stateOf:session=>projection?session.snapshotEvents().reduce((s,e)=>projection.apply(s,e),projection.init()):({pending})}:name==='agentDefaultModel'?{currentSelection:()=>({provider:'global',model:'default'})}:undefined},
  workspaceRegistry:{list:()=>[],resolveByPath:async()=>undefined},agentPresets:{composedPreset(){}},
  agents:{get:id=>sessions.get(id),async create(options){
   const session=Session.create(options.sessionId),agentCtx={get:name=>ctx.get(name),on(name,fn){hooks.set(name,fn);return()=>{}}}
   const append=session.append.bind(session);session.append=(type,data,...rest)=>{const event=append(type,data,...rest);if(type==='model/selection')pending=data;return event}
   const agent={id:options.sessionId,ctx:agentCtx,session,options:options.agentOptions,status:'idle'}
   if(agentApi.AgentModel)agent.model=new agentApi.AgentModel(
    ()=>session.snapshotEvents().reduce(projection.apply,projection.init()),session,agent.options,
   )
   await options.setup?.(agentCtx,agent);sessions.set(agent.id,agent);return {agent}
  }}}
 let agent
 return {ctx,hooks,get agent(){return agent},async create(route={provider:'chosen',model:'vision'}){agent=(await createBridgeSession(ctx,{record(){}},{sessionId:'model-route',cwd:'/tmp',...route})).agent;return agent},
  select(value){agent.session.append('model/selection',value);pending=value},
  async route(duringAssembly){
   // The newer loop captures AgentModel.current() before assembly.
   if(agent.model){
    const request=agent.model.current()
    assert.ok(request, 'the rc.5 loop requires a selected route before assembly')
    await duringAssembly?.()
    return {assembly:{provider:request.provider,model:request.model},request}
   }
   const assembly=await hooks.get('system-prompt/assemble')({}, {},async()=>{await duringAssembly?.();return {variables:{provider:'global',model:'default'}}})
   const request=await hooks.get('agent/request')({},async()=>({provider:'global',model:'default',reasoningEffort:'inherited'}))
   return {assembly:assembly.variables,request}
  }}
}

test('created native model-selection consumer keeps initial override and follows later UI selection',async()=>{
 const h=harness();await h.create()
 assert.deepEqual((await h.route()).request,{provider:'chosen',model:'vision'})
 h.select({provider:'user-selected',model:'next',reasoningEffort:'low'})
 const route=await h.route()
 assert.deepEqual(route.request,{provider:'user-selected',model:'next',reasoningEffort:'low'})
 assert.deepEqual(readSessionModelSelection(h.agent),route.request)
 assert.equal(route.assembly.model,'next')
})

test('route discovery refuses an unprojected selection instead of claiming the old model',()=>{
 const session=Session.create('unknown-selection'),agent={ctx:{get(){}},session,options:{provider:'p',model:'old'}}
 assert.deepEqual(readSessionModelSelection(agent),{provider:'p',model:'old'})
 session.append('model/selection',{provider:'p',model:'new'})
 assert.equal(readSessionModelSelection(agent),undefined)
 assert.equal(readSessionModelSelection({ctx:{get(){}},session:Session.create('no-route')}),undefined)
})

test('an external empty chat with conflicting initial options and changed default has no proven route',()=>{
 let current={provider:'global',model:'M1'}
 const agent={ctx:{get:name=>name==='sessionProjections'?{stateOf:()=>({pending:null})}:name==='agentDefaultModel'?{currentSelection:()=>current}:undefined},session:Session.create('external-empty'),options:{...current}}
 assert.deepEqual(readSessionModelSelection(agent),current)
 current={provider:'global',model:'M2'}
 assert.equal(readSessionModelSelection(agent),undefined)
})

test('creation without an explicit model still uses the native default',async()=>{
 const h=harness();const created=await h.create({})
 assert.deepEqual(readSessionModelSelection(created),{provider:'global',model:'default'})
 assert.deepEqual((await h.route()).request,{provider:'global',model:'default'})
})

test('installed rc.5 native projection and native assembly consume the shared public route', {skip:!existsSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')},async()=>{
 const native=await nativeModelSelection()
 const h=harness(native.projection);await h.create()
 if (native.AgentModel) {
  const {session,options}=h.agent
  const selection=new native.AgentModel(
   ()=>session.snapshotEvents().reduce(native.projection.apply,native.projection.init()),
   session,options,
  )
  const current=selection.current()
  assert.deepEqual(current,{provider:'chosen',model:'vision'})
  selection.select({provider:'ui',model:'native-next'})
  assert.deepEqual(current,{provider:'chosen',model:'vision'})
  assert.deepEqual(selection.current(),{provider:'ui',model:'native-next'})
  assert.deepEqual(readSessionModelSelection(h.agent),selection.current())
  return
 }
 native.installModelSelection(h.agent.ctx,{get current(){return readSessionModelSelection(h.agent)}})
 assert.equal((await h.route()).request.model,'vision')
 const first=await h.route(()=>h.select({provider:'ui',model:'native-next'}))
 assert.equal(first.request.model,'vision');assert.equal(first.assembly.model,'vision')
 const next=await h.route();assert.equal(next.request.model,'native-next');assert.equal(next.assembly.model,'native-next')
 assert.deepEqual(readSessionModelSelection(h.agent),next.request)
})

test('native assembly snapshots one route; a concurrent selection takes effect only on following step',async()=>{
 const h=harness();await h.create()
 const first=await h.route(()=>h.select({provider:'new',model:'after-assembly'}))
 assert.equal(first.assembly.model,'vision');assert.equal(first.request.model,'vision')
 const next=await h.route();assert.equal(next.assembly.model,'after-assembly');assert.equal(next.request.model,'after-assembly')
})
