import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { registerBridgeTools } from '../../src/tools.ts'
import { createGrants } from '../../src/coordinate.ts'
export function fixture(){
 const agents=new Map(),tools=new Map(),listeners=new Map(),effects=[],approvals=[],durable=new Map()
 let answer=async()=> 'allowed-once',flush=async()=>true,call=0
 const blank=()=>new Proxy({}, {get:(o,k)=>k==='then'?undefined:o[k]??=()=>undefined})
 const make=id=>{
  const session=Session.create(id,undefined,{version:4,id,createdAt:1,isSeeded:false,delegationDepth:0,cwd:'/tmp/probe'})
  session.append('turn/start',{turn:0})
  const append=session.append.bind(session);session.append=(...args)=>{const e=append(...args);for(const f of listeners.get('session/event')??[])f(session,e);return e}
  const a={id,ctx:blank(),session,status:'idle',inbox:{nextStep:[],nextTurn:[]},
   steer(m){effects.push(['send',id,m]);session.append('user/message',m,{surfaceOp:'append'})},
   followup(m){this.steer(m)},cancel(){throw Error('unexpected cancel')}}
  agents.set(id,a);return a
 }
 const ctx={get:name=>name==='approval'?{request:async req=>{approvals.push(req);return answer(req)}}:undefined,
  on(name,fn){const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list);return()=>{const index=list.indexOf(fn);if(index>=0)list.splice(index,1)}},
  tools:{register(t){tools.set(t.name,t);return()=>{if(tools.get(t.name)===t)tools.delete(t.name)}}},sessions:{async flush(s){const ok=await flush(s);if(ok)durable.set(s.id,{header:s.header,events:structuredClone(s.snapshotEvents()),inheritedEventCount:s.inheritedEventCount});return ok}},
  sessionPersistence:{async open(id,mode){assert.equal(mode,'read');const d=durable.get(id);if(!d)throw Error('missing log');return {...d,read:async()=>({events:d.events}),close:async()=>{effects.push(['close',id])}}}},
  agents:{get:id=>agents.get(id),list:()=>[],async create(o){effects.push(['create',o.sessionId]);return {agent:make(o.sessionId)}}},
  workspaceRegistry:{archivedSessionIds:[],list:()=>[],resolveByPath:async()=>undefined},agentPresets:{composedPreset(){},composeFrom(){}}
 }
 const grants=createGrants(),registry={touch(){},record(){}}
 const env={ctx,grants,registry};registerBridgeTools(env)
 make('A');make('B')
 const run=(name,args,who='A',options={})=>tools.get('session_coordinator_'+name).execute(args,{agent:agents.get(who),callId:options.callId??'call-'+(++call),signal:options.signal??new AbortController().signal,concludeTurn(){effects.push(['conclude',who])}})
 return {ctx,env,agents,tools,listeners,effects,approvals,durable,grants,run,make,async scopeStatus(args={},who='A'){const value=await (await env.collaboration).status(args,{agent:agents.get(who),callId:'fixture-readonly-scope',signal:new AbortController().signal});return Array.isArray(value)?{scopes:value}:value},setAnswer(fn){answer=fn},setFlush(fn){flush=fn},human(id){const a=agents.get(id);a.session.append('user/message',{id:'human-'+(++call),role:'user',source:{kind:'user'},content:[{type:'text',text:'new request'}]},{surfaceOp:'append'})},reload(){env.delivery=undefined;env.grants=createGrants();registerBridgeTools(env)}}
}
