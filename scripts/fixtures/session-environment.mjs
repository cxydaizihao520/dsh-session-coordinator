import {execFileSync,spawn} from 'node:child_process'
import {mkdtemp,realpath,rm,writeFile,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {tasksFixture} from './session-tasks.mjs'
import {registerCollaborationMaterialTools} from '../../src/collaboration-material-tools.ts'

export const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
export async function environmentFixture(t) {
 const repo=await realpath(await mkdtemp(join(tmpdir(),'session-environment-'))),h=await tasksFixture(['A','B','C']),cwd=new Map([...h.agents.keys()].map(id=>[id,repo]))
 t.after(async()=>{await(await h.env.collaboration).close();await rm(repo,{recursive:true,force:true})})
 git(repo,'init');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid')
 await writeFile(join(repo,'.gitignore'),'.agents/\n');await writeFile(join(repo,'calculate.cjs'),'module.exports=(price,quantity)=>price*quantity\n')
 await writeFile(join(repo,'shipping.cjs'),'module.exports=()=>0\n');git(repo,'add','.');git(repo,'commit','-m','shared baseline')
 const base=git(repo,'rev-parse','HEAD'),commands=[]
 registerCollaborationMaterialTools(h.env,h.env.collaboration)
 let call=0
 const services={fs:{resolve:async(p,{cwd:base=repo,signal}={})=>{signal?.throwIfAborted();return resolve(base,p)},processPath:p=>p,async lstat(p){try{return await lstat(p)}catch(error){if(error.code==='ENOENT')return undefined;throw error}}},workingDirectory:{ensure:async agent=>cwd.get(agent.id),set:async(agent,path)=>{cwd.set(agent.id,path);return path}},sandboxPolicy:{resolve:()=>({mode:'danger-full-access'})},subprocess:{resolveExecutable:async name=>name,spawn(options){
   commands.push(options);let stdout='',stderr=''
   const child=spawn(options.argv[0],options.argv.slice(1),{cwd:options.cwd,env:{...process.env,...options.env},signal:options.signal,stdio:['ignore','pipe','pipe']})
   child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v)
   const exited=new Promise(resolve=>child.once('close',resolve))
   const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}))})
   return {done,collected:{stdout:{readFrom:()=>({text:stdout,lossy:stdout.length>65536})},stderr:{readFrom:()=>({text:stderr,lossy:stderr.length>65536})}},terminate(){if(child.exitCode===null)child.kill()},waitForExit:()=>exited}
 }}}
 for(const agent of h.agents.values())agent.ctx={get:name=>services[name]}
 const task=await h.run('task',{communicationHandle:h.communicationHandle,objective:'independent implementation and direct review',members:['B','C'],requestId:'environment-task'})
 const material=(args,who='A',options)=>h.tools.get('session_coordinator_collaboration_material').execute({taskHandle:task.taskHandle,...args},{agent:h.agents.get(who),callId:options?.callId??'material-call-'+(++call),signal:options?.signal??new AbortController().signal})
 return {...h,repo,base,cwd,commands,services,task,material}
}
