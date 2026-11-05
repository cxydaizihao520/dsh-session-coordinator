import assert from 'node:assert/strict'
import {Context,Service} from 'cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {registerBridgeTools} from '../../src/tools.ts'
import {installCollaboration} from '../../src/collaboration-tools.ts'
import {createGrants} from '../../src/coordinate.ts'

export async function surfaceFixture(t,seed=[]) {
 const ctx=new Context(),agents=new Map(),records=new Map(seed.map(record=>[record.id,structuredClone(record)])),approvals=[],effects=[],scopes=[];let call=0
 const service=(name,value)=>new(class extends Service{constructor(){super(ctx,name);Object.assign(this,value)}})()
 service('systemPrompt',{tools(){}});service('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]})
 service('sessions',{async flush(){return true}});service('workspaceRegistry',{archivedSessionIds:[],list:()=>[]});service('agentPresets',{composedPreset(){},composeFrom(){}})
 service('approval',{async request(args){approvals.push(args);return 'allowed-once'}})
 const tools=new ToolRuntime(ctx)
 const make=id=>{const session=Session.create(id,undefined,{version:4,id,createdAt:1,isSeeded:false,delegationDepth:0,cwd:'/tmp/i13-surface'});const agent={id,session,status:'idle',inbox:{nextStep:[],nextTurn:[]},steer(message){this.inbox.nextStep.push(message);effects.push({id,message})},followup(message){this.inbox.nextTurn.push(message);effects.push({id,message})},cancel(){}};const scope=createScope(ctx,agent);scopes.push(scope);agent.ctx=scope.ctx;agents.set(id,agent);return agent}
 for(const id of ['A','B','C'])make(id)
 const store={list:()=>[...records.values()].map(x=>structuredClone(x)),get:id=>structuredClone(records.get(id)),async create(record){assert.ok(!records.has(record.id));records.set(record.id,structuredClone(record));return structuredClone(record)},async update(id,revision,mutate){const previous=records.get(id);assert.equal(previous.revision,revision);const next=mutate(structuredClone(previous));records.set(id,structuredClone(next));return structuredClone(next)},async close(){}}
 const env={ctx,registry:{touch(){},record(){}},grants:createGrants(),monitor:{list:()=>[]}}
 env.collaboration=installCollaboration(env,{store});registerBridgeTools(env);const runtime=await env.collaboration
 const exec=(who='A')=>({agent:agents.get(who),callId:'surface-'+(++call),signal:new AbortController().signal})
 const invoke=(name,args,who='A')=>tools.execute({...exec(who),name:name.startsWith('session_')?name:'session_coordinator_'+name,arguments:args})
 const run=async(name,args,who='A')=>{const result=await invoke(name,args,who);assert.equal(result.isError,false,JSON.stringify(result));return result.value}
 // Historical producer only: not registered in the current model surface.
 const legacy=async(members=['B'])=>runtime.start({objective:'Existing legacy work',members},exec())
 t?.after(async()=>{env.toolSurface?.dispose();await runtime.close();for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose()})
 return {ctx,env,tools,agents,records,store,runtime,approvals,effects,exec,invoke,run,legacy}
}
