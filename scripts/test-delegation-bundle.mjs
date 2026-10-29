// Built artifact with host-owned Session instances; isolated home, no DSH process/provider.
import assert from 'node:assert/strict'
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
 const ctx={get:n=>n==='approval'?{request:async()=> 'allowed-once'}:undefined,tools:{register:t=>tools.set(t.name,t)},
 agents:{list:()=>[],get:id=>agents.get(id),create:async o=>({agent:make(o.sessionId)})},
 sessions:{flush:async()=>true},workspaceRegistry:{list:()=>[],archivedSessionIds:[],resolveByPath:async()=>undefined},
 inject(){},on(){},effect(){},setInterval(){return 0},clearInterval(){}}
 make('A');apply(ctx)
 const run=(name,args,id,callId)=>tools.get('session_coordinator_'+name).execute(args,{agent:agents.get(id),callId,signal:new AbortController().signal})
 const sent=await run('create',{prompt:'bundle task'},'A','create-call')
 assert.ok(agents.has(sent.sessionId))
 assert.ok(agents.get('A').session.snapshotEvents().some(e=>pluginRecordOf(e)?.type==='plugin:dsh-session-coordinator/creation'))
 await run('send',{sessionId:'A',message:'bundle answer',replyTo:sent.messageId},sent.sessionId,'reply-call')
 apply(ctx) // Fresh plugin ledger; only owned durable-shaped evidence remains.
 const got=await run('wait',{sessionId:sent.sessionId,requestId:sent.messageId},'A','read-call')
 assert.equal(got.reply.recovered,true);assert.equal(got.reply.message.text,'bundle answer')
 // Allow the existing best-effort label registry writes to settle before deleting the test home.
 await new Promise(r=>setTimeout(r,50))
 console.log('PASS built artifact: host Session identity, creation, first reply, read-only recovery')
} finally {
 if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
 await rm(home,{recursive:true,force:true})
}
