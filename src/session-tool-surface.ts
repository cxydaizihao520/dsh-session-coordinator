/** Compatibility uses native inherited tools and subtractive scoped filters. */
import { once } from 'node:events'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BridgeEnv } from './tools.ts'
import type { CollaborationRuntime } from './collaboration.ts'
import type { LiveAgentLike } from './core.ts'
import { getLiveAgent } from './core.ts'
import { withFilteredStepInputs } from './session-delivery-state.ts'

export class SessionToolSurface {
  private runtime?: CollaborationRuntime
  private active = true
  private readonly registrations = new Map<LiveAgentLike, {denied:string[]; dispose:()=>void}>()
  private readonly disposers: Array<() => unknown> = []
  private readonly env: BridgeEnv
  private readonly legacy: ReadonlyMap<string,ToolDefinition>
  constructor(env: BridgeEnv, ready: Promise<CollaborationRuntime>, legacy: ReadonlyMap<string, ToolDefinition>) {
    this.env=env;this.legacy=legacy
    for(const definition of legacy.values())this.disposers.push(env.ctx.tools.register({...definition,execute:async(args,exec)=>{
      const caller=exec.agent as unknown as LiveAgentLike
      if(!this.active||getLiveAgent(env.ctx,caller.id)!==caller||!this.wanted(caller).has(definition.name))throw new Error('Legacy compatibility is unavailable for this caller or current task state')
      return definition.execute(args,exec)
    }}))
    this.refresh()
    void ready.then(runtime => { if(this.active){this.runtime=runtime;this.refresh()} }).catch(()=>{})
    const on=env.ctx.on.bind(env.ctx) as (...args:any[])=>()=>void
    this.disposers.push(on('agent/created',({agent}:{agent:LiveAgentLike})=>this.refresh(agent)))
    this.disposers.push(on('agent/disposed',({agent}:{agent:LiveAgentLike})=>this.remove(agent)))
    this.disposers.push(on('agent/pre-step',async({agent,turn,signal}:any,next:()=>Promise<any>)=>{
      const decision=await next()
      if(!this.active||decision.kind!=='enter')return decision
      const bound=(message:any)=>message.source?.kind==='session-collaboration'||message.source?.kind==='session-message'&&message.source?.taskId
      if(!decision.messages.some(bound)){this.refresh(agent);return decision}
      let runtime:CollaborationRuntime
      try{signal.throwIfAborted();const stop=new AbortController();try{runtime=await Promise.race([ready,once(signal,'abort',{signal:stop.signal}).then(()=>{signal.throwIfAborted();throw new Error('step cancelled')})])}finally{stop.abort()}}catch{return withFilteredStepInputs(agent,turn,decision,decision.messages.filter((message:any)=>!bound(message)))}
      if(!this.active)return withFilteredStepInputs(agent,turn,decision,decision.messages.filter((message:any)=>!bound(message)))
      this.refresh(agent)
      return runtime.filterTaskInputs(agent,turn,signal,decision)
    }))
    env.ctx.effect?.(()=>()=>this.dispose())
  }
  private wanted(agent:LiveAgentLike):Map<string,ToolDefinition> {
    const result=new Map<string,ToolDefinition>(),access=this.runtime?.legacyToolAccess(agent)
    for(const [name,definition] of this.legacy) {
      if(name==='status'||name==='wait'?access?.read:name==='result'?access?.continue||access?.lateResult:access?.continue)result.set(definition.name,definition)
    }
    return result
  }
  private safely(action:()=>void):boolean {try{action();return true}catch(error){console.warn('[session-coordinator] compatibility surface refresh failed:', error instanceof Error?error.message:String(error));return false}}
  refresh(one?:LiveAgentLike):void {
    if(!this.active)return
    const agents=one?[one]:this.env.ctx.agents.list() as unknown as LiveAgentLike[]
    for(const agent of agents) {
      if(getLiveAgent(this.env.ctx,agent.id)!==agent){this.remove(agent);continue}
      const desired=this.wanted(agent),denied=[...this.legacy.values()].map(definition=>definition.name).filter(name=>!desired.has(name))
      if (!this.runtime?.legacyToolAccess(agent).read && !this.env.delivery?.hasLegacyExchange?.(agent)) denied.push(...['session_coordinator_segments', 'session_coordinator_message_status'].filter(name=>this.env.ctx.tools.get?.(name)))
      const current=this.registrations.get(agent)
      if(current&&JSON.stringify(current.denied)===JSON.stringify(denied))continue
      const tools=agent.ctx?.tools
      if(typeof tools?.restrict!=='function')continue
      // Install the next restriction first; failures can only leave a narrower surface.
      this.safely(()=>{
        const dispose=tools.restrict({deny:denied})
        if(current&&!this.safely(current.dispose)){dispose();return}
        this.registrations.set(agent,{denied,dispose})
      })
    }
  }
  private remove(agent:LiveAgentLike):void {const current=this.registrations.get(agent);if(current&&this.safely(current.dispose))this.registrations.delete(agent)}
  dispose():void {if(!this.active)return;this.active=false;for(const agent of this.registrations.keys())this.remove(agent);for(const dispose of this.disposers.splice(0))dispose()}
}

/** Cached old calls reuse the original validator only with real legacy context. */
export function registerCurrentSessionTool(env:BridgeEnv,definition:ToolDefinition,legacyFields:readonly string[]):void {
  const schema=definition.parameters as {properties?:Record<string,unknown>;required?:string[]}
  env.ctx.tools.register({...definition,parameters:{...schema,properties:Object.fromEntries(Object.entries(schema.properties??{}).filter(([key])=>!legacyFields.includes(key))),...(schema.required?{required:schema.required.filter(key=>!legacyFields.includes(key))}:{})},execute:async(args,exec)=>{
    const oldFields=args&&typeof args==='object'?legacyFields.filter(field=>(args as Record<string,unknown>)[field]!==undefined):[]
    if(oldFields.length&&!env.delivery?.hasLegacyExchange(exec.agent as unknown as LiveAgentLike))throw new Error('Legacy arguments '+oldFields.join(', ')+' require the original in-flight compatibility context; use the current session tool contract')
    return definition.execute(args,exec)
  }})
}
