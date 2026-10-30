import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { recordDiagnostic, exportDiagnostics, observeDiagnostics } from '../src/diagnostics.ts'
import { createGrants, registerCoordinateCommand } from '../src/coordinate.ts'

function fixture() {
 const session=Session.create('A',undefined,{version:4,id:'A',createdAt:1,isSeeded:false,cwd:'/synthetic'}), listeners=new Map(),commands=new Map()
 const agent={id:'A',session,status:'idle'}, effects=[]
 const ctx={agents:{get:id=>id==='A'?agent:undefined},sessions:{flush:async()=>true},
 on(name,fn){const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list)},
 inject(_names,fn){fn({commands:{register:c=>commands.set(c.name,c)}})}}
 const append=session.append.bind(session)
 session.append=(...args)=>{const seq=append(...args),event=session.snapshotEvents().at(-1);for(const fn of listeners.get('session/event')??[])fn(session,event);return seq}
 const stream=async request=>{for(const fn of listeners.get('llm/stream')??[])for await(const _ of fn(request,async function*(){})) {}}
 return {ctx,session,agent,commands,listeners,effects,stream}
}
test('diagnostic export is bounded, allowlisted and human-command accessible without changing authority',async()=>{
 const h=fixture()
 for(let n=0;n<205;n++)await recordDiagnostic(h.ctx,h.session,{stage:'attempt',attemptedHop:n,message:'PRIVATE-body',error:'PRIVATE-secret',path:'/PRIVATE',scopeId:'scope'})
 registerCoordinateCommand(h.ctx,createGrants())
 const result=await h.commands.get('coordinate').handler({agent:{id:'A'},rawInput:'logs'})
 assert.equal(result.kind,'success')
 const dump=JSON.parse(result.text),row=dump.sessions[0]
 assert.equal(row.total,205);assert.equal(row.records.length,200);assert.equal(row.truncated,true)
 assert.equal(row.records[0].attemptedHop,5);assert.equal(row.records.at(-1).attemptedHop,204)
 assert.ok(!result.text.includes('PRIVATE'));assert.equal(dump.businessContentIncluded,false)
 assert.equal(row.persistence,'flushed')
 assert.equal((await h.commands.get('coordinate').handler({agent:{id:'A'},rawInput:'logs B'})).kind,'success','unavailable peer is explicitly reported')
 assert.equal((await h.commands.get('coordinate').handler({rawInput:'logs'})).kind,'error')
 assert.equal((await h.commands.get('coordinate').handler({agent:{id:'A'},rawInput:'logs /PRIVATE/path'})).kind,'error')
})
test('native history and actual branded model request are separate observations, records never reenter publication',async()=>{
 const h=fixture();observeDiagnostics(h.ctx);observeDiagnostics(h.ctx)
 assert.equal(h.listeners.get('session/event').length,1)
 const message={id:'message',role:'user',source:{kind:'session-collaboration',scopeId:'scope',taskId:'task',taskRevision:1,operationId:'message',senderSessionId:'B',ownerSessionId:'A',intent:'task'},content:[{type:'text',text:'PRIVATE-business-text'}]}
 h.session.append('user/message',message,{surfaceOp:'append'})
 let dump=await exportDiagnostics(h.ctx,'A')
 assert.deepEqual(dump.sessions[0].records.map(r=>r.stage),['native-history'])
 const request={sessionId:'A',provider:'fixture',model:'fixture',messages:[message],signal:new AbortController().signal}
 await h.stream(request)
 dump=await exportDiagnostics(h.ctx,'A')
 assert.equal(dump.sessions[0].records.length,1,'an unbranded probe cannot claim native model inclusion')
 await h.stream(markAgentLoopRequest(request))
 await h.stream(markAgentLoopRequest({...request}))
 dump=await exportDiagnostics(h.ctx,'A')
 assert.deepEqual(dump.sessions[0].records.map(r=>r.stage),['native-history','model-inclusion'])
 assert.equal(dump.sessions[0].records[1].operationId,'message')
 assert.equal(dump.sessions[0].persistence,'flushed')
 assert.ok(!JSON.stringify(dump).includes('PRIVATE'))
})
test('unknown and inherited records cannot masquerade as current diagnostic observations',async()=>{
 const h=fixture();await recordDiagnostic(h.ctx,h.session,{stage:'attempt'})
 const dump=await exportDiagnostics(h.ctx,'A')
 assert.equal(dump.sessions[0].records.length,1)
 const previous=h.session.isOwnSeq.bind(h.session)
 h.session.isOwnSeq=()=>false
 assert.equal((await exportDiagnostics(h.ctx,'A')).sessions[0].records.length,0)
 h.session.isOwnSeq=previous
 assert.equal(pluginRecordOf(h.session.snapshotEvents()[0]).type,'plugin:dsh-session-coordinator/diagnostic')
})

test('free-form reasons, invalid routing paths and forged metadata are never exported',async()=>{
 const {diagnosticCall}=await import('../src/diagnostics.ts');const h=fixture()
 await diagnosticCall(h.ctx,h.agent,'session_coordinator_collaboration_control',{scopeId:'/PRIVATE/local/workdir',reason:'PRIVATE-credential /PRIVATE/path',action:'cancel',tool:'PRIVATE-forged',stage:'accepted',attemptId:'PRIVATE-forged'},'actual-call',undefined,async()=>({state:'paused',reason:'PRIVATE-output-secret',observedTokens:1200,budget:{maxObservedTokens:2000}}))
 const dump=await exportDiagnostics(h.ctx,'A'),rows=dump.sessions[0].records
 assert.ok(!JSON.stringify(dump).includes('PRIVATE'))
 assert.ok(rows.every(r=>r.tool==='session_coordinator_collaboration_control'))
 assert.deepEqual(rows.map(r=>r.stage),['attempt','returned'])
 assert.equal(rows[1].observedTokens,1200);assert.equal(rows[1].maxObservedTokens,2000)
})
test('stalled diagnostics never block native model dispatch; queue is capped and export reports pending/dropped',async()=>{
 const h=fixture();let release;h.ctx.sessions.flush=()=>new Promise(resolve=>{release=resolve})
 observeDiagnostics(h.ctx)
 const message={id:'m',role:'user',source:{kind:'session-message',senderSessionId:'B',messageId:'m',rootMessageId:'m',hopCount:1},content:[{type:'text',text:'PRIVATE'}]}
 await h.stream(markAgentLoopRequest({sessionId:'A',messages:[message],signal:new AbortController().signal}))
 for(let n=0;n<160;n++)void recordDiagnostic(h.ctx,h.session,{stage:'attempt'})
 const dump=await exportDiagnostics(h.ctx,'A')
 assert.equal(dump.sessions[0].persistence,'pending')
 assert.ok(dump.sessions[0].droppedInProcess>=33);assert.equal(dump.sessions[0].incomplete,true)
 h.ctx.sessions.flush=async()=>true;release(true)
 const done=await exportDiagnostics(h.ctx,'A')
 assert.equal(done.sessions[0].persistence,'flushed')
 assert.ok(done.sessions[0].total<=128)
})

test('related export discovers only direct peers from own native diagnostics without scanning or recursive expansion', async () => {
 const h=fixture()
 await recordDiagnostic(h.ctx,h.session,{stage:'accepted',targetSessionId:'B',message:'C'})
 await recordDiagnostic(h.ctx,h.session,{stage:'native-history',senderSessionId:'B',ownerSessionId:'A'})
 registerCoordinateCommand(h.ctx,createGrants())
 const result=await h.commands.get('coordinate').handler({agent:{id:'A'},rawInput:'logs-related'})
 assert.equal(result.kind,'success')
 const dump=JSON.parse(result.text)
 assert.deepEqual(dump.sessions.map(s=>s.sessionId),['A','B'])
 assert.equal(dump.discovery.recursive,false)
 assert.equal(dump.sessions[1].persistence,'unavailable')
 assert.equal(dump.sessions[1].incomplete,true)
})

test('related export excludes a peer’s other operations even within the same scope and reports missing matches', async () => {
 const h=fixture(),b=Session.create('B',undefined,{version:4,id:'B',createdAt:1,isSeeded:false,cwd:'/synthetic'})
 h.ctx.agents.get=id=>id==='A'?h.agent:id==='B'?{id:'B',session:b,status:'idle'}:undefined
 await recordDiagnostic(h.ctx,h.session,{stage:'accepted',targetSessionId:'B',scopeId:'shared',operationId:'AB'})
 await recordDiagnostic(h.ctx,b,{stage:'native-history',senderSessionId:'A',scopeId:'shared',operationId:'AB'})
 await recordDiagnostic(h.ctx,b,{stage:'accepted',targetSessionId:'C',scopeId:'shared',operationId:'BC'})
 const {exportRelatedDiagnostics}=await import('../src/diagnostics.ts')
 let dump=await exportRelatedDiagnostics(h.ctx,'A')
 assert.equal(dump.sessions[1].records.length,1)
 assert.equal(dump.sessions[1].total,1)
 assert.ok(!JSON.stringify(dump).includes('BC'))
 assert.ok(!JSON.stringify(dump).includes('"C"'))
 b.isOwnSeq=()=>false
 dump=await exportRelatedDiagnostics(h.ctx,'A')
 assert.equal(dump.sessions[1].total,0)
 assert.equal(dump.sessions[1].incomplete,true)
})
