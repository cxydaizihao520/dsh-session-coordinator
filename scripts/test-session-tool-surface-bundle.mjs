// Actual built plugin + native tool collection/dispatch, with no source implementation imports.
import assert from 'node:assert/strict'
import {Context,Service} from 'cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {Storage} from '@deepseek-ai/dsh-storage'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const artifactHome=await mkdtemp(join(tmpdir(),'session-surface-artifact-'))
const previous=process.env.DSH_HOME;process.env.DSH_HOME=artifactHome
const ctx=new Context(),scopes=[]
try{
 const agents=new Map(),effects=[]
 const service=(name,value)=>new(class extends Service{constructor(){super(ctx,name);Object.assign(this,value)}})()
 new Storage(ctx)
 service('systemPrompt',{tools(){},section(){return()=>{}},context(){return()=>{}}})
 service('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]})
 service('sessions',{async flush(){return true}})
 service('workspaceRegistry',{archivedSessionIds:[],list:()=>[]})
 service('agentPresets',{composedPreset(){},composeFrom(){}})
 service('approval',{async request(){return 'allowed-once'}})
 const runtime=new ToolRuntime(ctx)
 for(const id of ['artifact-A','artifact-B']){
  const session=Session.create(id,undefined,{version:4,id,createdAt:1,isSeeded:false,delegationDepth:0,cwd:artifactHome})
  const agent={id,session,status:'idle',inbox:{nextStep:[],nextTurn:[]},steer(message){this.inbox.nextStep.push(message);effects.push(message)},followup(message){this.inbox.nextTurn.push(message);effects.push(message)}}
  const scope=createScope(ctx,agent);scopes.push(scope);agent.ctx=scope.ctx;agents.set(id,agent)
 }
 const agent=agents.get('artifact-A')
 ctx.tools.register({name:'native_team',description:'Unrelated host capability',parameters:{},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},execute:async()=> 'native preserved'})
 const {apply}=await import('../lib/index.js');apply(ctx)
 await new Promise(resolve=>setTimeout(resolve,30))
 for(const name of ['find','read','create','send','wait','status','control','task','question','schedule','collaboration_material'])assert.ok(runtime.get('session_coordinator_'+name,agent),name)
 for(const name of ['collaboration_start','cancel','collaboration_task','collaboration_send','collaboration_result','collaboration_control','segments','message_status'])assert.equal(runtime.get('session_coordinator_'+name,agent),undefined,name)
 assert.ok(runtime.schemas(agent).some(tool=>tool.name==='native_team'))
 assert.ok(runtime.sdkSchemas(agent).some(tool=>tool.name==='session_coordinator_send'))
 assert.equal(runtime.get('session_coordinator_send',agent).parameters.properties.sessionId,undefined)
 const exec={agent,signal:new AbortController().signal,callId:'artifact-call'}
 assert.equal((await runtime.execute({...exec,name:'native_team',arguments:{}})).value,'native preserved')
 assert.equal((await runtime.execute({...exec,name:'session_coordinator_send',arguments:{sessionId:'artifact-B',message:'legacy constructor bypass'}})).isError,true)
 assert.equal(effects.length,0)
 const deny=agent.ctx.tools.restrict({deny:['session_coordinator_send']})
 assert.equal(runtime.get('session_coordinator_send',agent),undefined)
 assert.equal((await runtime.execute({...exec,name:'session_coordinator_send',arguments:{targets:['artifact-B'],content:'denied'}})).isError,true)
 assert.equal(effects.length,0);deny()
 const sent=await runtime.execute({...exec,name:'session_coordinator_send',arguments:{targets:['artifact-B'],content:' current artifact\n',authorizationRequest:{extent:'message',participants:['artifact-A','artifact-B'],purpose:'artifact delivery',reply:'none'}}})
 assert.equal(sent.isError,false,JSON.stringify(sent));assert.equal(sent.value.results[0].admission,'accepted',JSON.stringify(sent))
 assert.equal(effects[0].content[0].text,' current artifact\n')
 const target=agents.get('artifact-B');target.session.append('user/message',effects[0],{surfaceOp:'append'})
 const receipt=await runtime.execute({...exec,callId:'artifact-receipt',name:'session_coordinator_status',arguments:{sessionId:target.id,messageId:sent.value.results[0].messageId}})
 assert.equal(receipt.isError,false,JSON.stringify(receipt));assert.equal(receipt.value.status,'appended');assert.equal(receipt.value.historical,true)
 target.session.append('assistant/message',{turn:0,step:1,message:{role:'assistant',content:[{type:'text',text:'artifact output'}]}},{surfaceOp:'append'})
 const segments=await runtime.execute({...exec,callId:'artifact-segments',name:'session_coordinator_read',arguments:{sessionId:target.id,view:'segments',limit:1}})
 assert.equal(segments.isError,false,JSON.stringify(segments));assert.equal(segments.value.segments[0].text,'artifact output')
 assert.equal(sent.value.results[0].waitTarget.sessionId,target.id)
 console.log('PASS built native schema/SDK/dispatch: modern defaults, optional discovery, host restrictions, original body')
}finally{
 for(const scope of scopes)await scope.dispose()
 await ctx.fiber.dispose()
 if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
 await rm(artifactHome,{recursive:true,force:true})
}
