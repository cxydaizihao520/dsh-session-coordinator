// Execute the installed tool executor and loop against controlled calls and native jobs.
import {test} from 'node:test'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {dirname,posix} from 'node:path'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {Context,Service} from 'cordis'
import {LlmError,errorChain} from '@deepseek-ai/dsh-llm'
import {ToolCallRecovery} from '@deepseek-ai/dsh-session'
import {tasksFixture} from './fixtures/session-tasks.mjs'

const tree=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url)
const host=path=>execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/'+path],{cwd:tree,encoding:'utf8'})
const toolsPackage='@deepseek-ai/dsh-tools'
const urls=new Map()
function nativeUrl(path){
 if(urls.has(path))return urls.get(path)
 const source=host(path).replace(/from "([^"]+)"/g,(_,name)=>{
  let url
  if(name.startsWith('.'))url=nativeUrl(posix.join(dirname(path),name))
  else if(name===toolsPackage||name===toolsPackage+'/pipeline')url=nativeUrl(toolsPackage+(name===toolsPackage?'/lib/index.js':'/lib/pipeline.js'))
  else {
   try {
    const resolved=require.resolve(name==='@deepseek-ai/cordis'?'cordis':name)
    url=resolved.startsWith('/')?pathToFileURL(resolved).href:resolved
   } catch {url=nativeUrl(name+'/lib/index.js')}
  }
  return 'from '+JSON.stringify(url)
 })
 const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64')
 urls.set(path,url)
 return url
}
const {ToolRuntime,ToolActivationError,ToolBatchExecutionError}=await import(nativeUrl(toolsPackage+'/lib/index.js'))
const {NativeToolExecutor}=await import(nativeUrl('@deepseek-ai/dsh-tool-executor-native/lib/index.js'))
const {LocalJobRegistry}=await import(nativeUrl('@deepseek-ai/dsh-jobs-local/lib/index.js'))
const src=host('@deepseek-ai/dsh-agent-loop/lib/index.js')
const turnStart=src.indexOf('\tasync turn() {'),turnEnd=src.indexOf('\n\tasync step(decision)',turnStart)
assert.ok(turnStart>=0&&turnEnd>turnStart)
const turn=new Function('ToolCallRecovery','LlmError','errorChain','abortedCancelCause','ToolActivationError',
 'return '+src.slice(turnStart,turnEnd).trim().replace('async turn()','async function()'),
)(ToolCallRecovery,LlmError,errorChain,()=>undefined,ToolActivationError)
const tailStart=src.indexOf('const toolCalls = message.content.filter'),tailEnd=src.indexOf('\n\t\t\t} catch',tailStart)
assert.ok(tailStart>=0&&tailEnd>tailStart)
const stepTail=new Function('ToolBatchExecutionError',
 'return async function(message,turn,step,signal,decision){'+src.slice(tailStart,tailEnd)+'}',
)(ToolBatchExecutionError)
for(const scenario of ['single-call','other-tool','background-job','scoped-background-job','plugin-owned-job','plugin-only-job'])test('native scheduler and turn preserve remaining work: '+scenario,async()=>{
 const h=await tasksFixture();h.human('A');const b=h.agents.get('B'),root=new Context();new(class extends Service{constructor(c){super(c,'systemPrompt')}tools(){}})(root);new(class extends Service{constructor(c){super(c,'agents')}get(id){return h.agents.get(id)}})(root);b.ctx=root;const runtime=new ToolRuntime(root);runtime.setExecutor(new NativeToolExecutor(root));for(const t of h.tools.values())runtime.register(t);
 const jobs=new LocalJobRegistry(root,{maxConcurrentJobsPerOwner:4,retainBytes:4096,settledRetainBytes:4096,pumpPollMs:20});jobs.attachController('probe');const get=h.ctx.get;h.ctx.get=name=>name==='jobs'?jobs:get(name);let finishJob;const jobDone=new Promise(r=>finishJob=r);let job;
 const pluginRoot=new Context();new(class extends Service{constructor(c){super(c,'agents')}get(id){return h.agents.get(id)}})(pluginRoot);const pluginJobs=new LocalJobRegistry(pluginRoot,{maxConcurrentJobsPerOwner:4,retainBytes:4096,settledRetainBytes:4096,pumpPollMs:20});pluginJobs.attachController('other-world');
 if(scenario==='scoped-background-job'||scenario==='plugin-owned-job'||scenario==='plugin-only-job')h.ctx.get=name=>name==='jobs'?pluginJobs:get(name);
 const pluginJob=scenario==='plugin-only-job'||scenario==='plugin-owned-job',jobRegistry=pluginJob?pluginJobs:jobs;const jobOwner=scenario==='plugin-only-job'?'A':'B';if(jobOwner==='A')h.agents.get('A').ctx=pluginRoot;
 try {
 if(['background-job','scoped-background-job','plugin-owned-job','plugin-only-job'].includes(scenario))job=jobRegistry.start({owner:jobOwner,kind:'probe',label:'pending independent work',run(){return {done:jobDone,cancel(){finishJob({status:'killed'})}}}});
 let calls,steps=0,otherDone=false;runtime.register({name:'other_tool',description:'probe',parameters:{},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},async execute(){await new Promise(r=>setImmediate(r));otherDone=true;return 'must inspect this result'}});
 b.phase={kind:'running',turn:0,step:0,abort:new AbortController()};b.inbox.hasPending=false;b.dispatch={serial:async()=>{}};b.throwError=e=>{throw e};
 b.loopCtx={agents:{requireInitiator:()=>b},tools:runtime,agentLoop:{config:{maxParallelToolCalls:{get:()=>4}}}};
 b.preStep=async()=>{const toolSet=await runtime.resolve({agent:b,modelSelection:{provider:'probe',model:'probe'},signal:b.phase.abort.signal});if(calls)return {kind:'enter',messages:[],toolSet};const first=await h.run('send',{targets:['B'],content:'one report',authorizationRequest:{extent:'message',participants:['A','B'],purpose:'return report',reply:'once'}});calls=[{type:'tool-call',id:'reply-call',name:'session_coordinator_send',arguments:JSON.stringify({targets:['A'],content:'result',replyTo:first.results[0].messageId})}];if(scenario==='other-tool')calls.push({type:'tool-call',id:'other-call',name:'other_tool',arguments:'{}'});return {kind:'enter',messages:[b.session.snapshotEvents().findLast(e=>e.type==='user/message').data],toolSet}};
 b.step=async decision=>{steps++;if(steps>1)return {kind:'completed'};b.session.append('assistant/message',{turn:1,step:1,message:{id:'native-plan',role:'assistant',content:calls}},{surfaceOp:'append'});return stepTail.call(b,{content:calls},1,1,b.phase.abort.signal,decision)};
 const continued=await turn.call(b);const jobStatus=job?jobRegistry.list(jobOwner).find(x=>x.id===(typeof job==='string'?job:job.id))?.status:undefined;assert.equal(steps,['single-call','plugin-only-job'].includes(scenario)?1:2);assert.equal(continued,false);if(job)assert.equal(jobStatus,'running');else if(scenario==='other-tool')assert.equal(otherDone,true);
 } finally {await (await h.env.collaboration).close();finishJob({status:'completed'});await new Promise(r=>setImmediate(r));await root.fiber.dispose();await pluginRoot.fiber.dispose()}
})
