// Installed native worktree service, actual scratch Git/files, no desktop/provider.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {join} from 'node:path'
import {readFile,writeFile} from 'node:fs/promises'
import {Context} from 'cordis'
import {environmentFixture,git} from './fixtures/session-environment.mjs'
const require=createRequire(import.meta.url),tree=fileURLToPath(new URL('..',import.meta.url))
const urls=new Map()
function nativeModuleUrl(name){
 if(urls.has(name))return urls.get(name)
 const original=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/'+name+'/lib/index.js'],{cwd:tree,encoding:'utf8'})
 const body=original.replace(/from "([^"]+)"/g,(_,name)=>{let resolved;try{resolved=require.resolve(name==='@deepseek-ai/cordis'?'cordis':name)}catch{resolved=nativeModuleUrl(name)}return 'from '+JSON.stringify(resolved.startsWith('/')?pathToFileURL(resolved).href:resolved)})
 const url='data:text/javascript;base64,'+Buffer.from(body).toString('base64');urls.set(name,url);return url
}
const {WorktreeService}=await import(nativeModuleUrl('@deepseek-ai/dsh-experimental-worktree'))
function mount(h,t){const ctx=new Context();for(const [key,value] of Object.entries(h.services))Object.defineProperty(ctx,key,{value,configurable:true});const service=new WorktreeService(ctx,{directory:'.agents/worktrees',namePrefix:'worktree-',gitCommand:'git',nodeCommand:process.execPath,timeoutMs:60000,graceMs:3000,maxOutputBytes:65536});h.services.worktrees=service;t.after(()=>ctx.fiber.dispose());return service}

test('registered task consumer uses installed native worktrees and preserves dirty source',async t=>{
 const h=await environmentFixture(t);mount(h,t)
 await writeFile(join(h.repo,'calculate.cjs'),'unrelated uncommitted source\n')
 const input={action:'worktree',sessionId:'B',from:h.base,name:'native-reviewed-B',requestId:'native-worktree-create'}
 const created=await h.material(input)
 assert.equal(created.baseCommit,h.base);assert.equal(h.cwd.get('B'),created.path)
 assert.equal(await readFile(join(created.path,'calculate.cjs'),'utf8'),'module.exports=(price,quantity)=>price*quantity\n')
 assert.equal(await readFile(join(h.repo,'calculate.cjs'),'utf8'),'unrelated uncommitted source\n')
 assert.equal(git(created.path,'branch','--show-current'),'native-reviewed-B')
 assert.equal((await h.material({action:'inspect',sessionId:'B'},'C')).headCommit,h.base)
 assert.deepEqual(await h.material(input),created)
})

test('native allocation is retained when task cancellation prevents working-directory publication',async t=>{
 const h=await environmentFixture(t);mount(h,t)
 const other=await h.run('task',{communicationHandle:h.communicationHandle,objective:'independent other checkout',members:['C'],requestId:'native-other-task'})
 let entered,release
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),set=h.services.workingDirectory.set
 h.services.workingDirectory.set=async(agent,path,signal)=>{if(agent.id==='B'){entered(path);await gate;signal.throwIfAborted()}return set(agent,path,signal)}
 const input={action:'worktree',sessionId:'B',from:h.base,name:'native-cancelled-B',requestId:'native-cancel-create'}
 const pending=h.material(input),path=await started
 await h.run('control',{object:'task',action:'cancel',taskHandle:h.task.taskHandle,expectedRevision:1,reason:'cancel only this environment task',requestId:'native-cancel-task'})
 release()
 await assert.rejects(pending,error=>error.code==='COLLABORATION_ENVIRONMENT_UNKNOWN')
 assert.equal(h.cwd.get('B'),h.repo);assert.equal(git(path,'rev-parse','HEAD'),h.base)
 assert.equal(await readFile(join(path,'calculate.cjs'),'utf8'),'module.exports=(price,quantity)=>price*quantity\n')
 assert.equal((await h.run('status',{taskHandle:h.task.taskHandle})).state,'cancelled')
 const approvals=h.approvals.length
 await assert.rejects(h.material(input),/active|cancelled/);assert.equal(h.approvals.length,approvals)
 const created=await h.material({taskHandle:other.taskHandle,action:'worktree',sessionId:'C',from:h.base,name:'native-other-C',requestId:'native-other-create'})
 assert.equal(created.baseCommit,h.base);assert.equal(h.cwd.get('C'),created.path)
})

test('native effect and failed unknown-outcome checkpoint retain both causes without reporting rejection',async t=>{
 const h=await environmentFixture(t),native=mount(h,t),runtime=await h.env.collaboration,update=runtime.store.update.bind(runtime.store)
 let attempts=0,lost=false
 h.services.worktrees={async create(...args){attempts++;await native.create(...args);throw new Error('native reply lost after directory publication')}}
 runtime.store.update=async(...args)=>{const result=await update(...args);if(!lost&&Object.values(result.data.tasks).some(task=>Object.values(task.materialOperations??{}).some(op=>op.status==='unknown'))){lost=true;throw Object.assign(new Error('unknown checkpoint durability lost'),{code:'durability-unknown'})}return result}
 const input={action:'worktree',sessionId:'B',from:h.base,name:'native-lost-response',requestId:'native-checkpoint-lost'}
 await assert.rejects(h.material(input),error=>{assert.equal(error.code,'COLLABORATION_ENVIRONMENT_UNKNOWN');assert.equal(lost,true);assert.notEqual(h.cwd.get('B'),h.repo);return true})
 await assert.rejects(h.material(input),/recovery|unknown/);assert.equal(attempts,1)
 assert.equal(git(h.cwd.get('B'),'rev-parse','HEAD'),h.base)
})
