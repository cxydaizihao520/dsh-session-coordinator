import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {environmentFixture,git} from './fixtures/session-environment.mjs'
import {installCollaboration} from '../src/collaboration-tools.ts'
import {registerCollaborationMaterialTools} from '../src/collaboration-material-tools.ts'

test('recovering one task retains both real checkouts and resumes only its current material consumer',async t=>{
 const h=await environmentFixture(t)
 const other=await h.run('task',{communicationHandle:h.communicationHandle,objective:'separate shipping work',members:['C'],requestId:'environment-other-task'})
 const create={action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B'),requestId:'recovery-existing-worktree'}
 const b=await h.material(create)
 const c=await h.material({action:'worktree',taskHandle:other.taskHandle,sessionId:'C',from:h.base,path:join(h.repo,'.agents','C'),requestId:'recovery-other-worktree'})
 await writeFile(join(b.path,'calculate.cjs'),'partial uncommitted implementation\n')
 await writeFile(join(c.path,'unrelated.txt'),'unrelated work stays intact\n')
 const runtime=await h.env.collaboration,store=runtime.store
 await runtime.close();h.listeners.clear();h.reload()
 h.env.collaboration=installCollaboration(h.env,{store});await h.env.collaboration
 registerCollaborationMaterialTools(h.env,h.env.collaboration)
 const count=()=>h.commands.filter(row=>row.argv.includes('worktree')&&row.argv.includes('add')).length
 const creations=count(),approvals=h.approvals.length
 assert.equal((await h.run('status',{taskId:h.task.id})).recoveryRequired,true)
 await assert.rejects(h.material({action:'inspect',sessionId:'B'}),/runtime|unknown/)
 h.human('A')
 const restored=await h.run('control',{object:'task',taskId:h.task.id,action:'resume',expectedRevision:1,reason:'inspect retained checkout and continue only remaining implementation',requestId:'environment-recovery-control'})
 assert.equal(restored.outcome,'applied');assert.equal(h.approvals.length,approvals+1)
 const inspected=await h.material({action:'inspect',taskHandle:restored.taskHandle,sessionId:'B'},'C')
 assert.equal(inspected.headCommit,h.base);assert.equal(inspected.dirty,true)
 assert.match(inspected.workingTreeDiff,/partial uncommitted implementation/)
 await assert.rejects(h.material({...create,taskHandle:restored.taskHandle}),/identity|different/)
 await assert.rejects(h.material({action:'worktree',taskHandle:other.taskHandle,sessionId:'C',from:h.base,requestId:'unrestored-environment-write'}),/runtime|unknown/)
 const checkpoint=await h.material({action:'checkpoint',taskHandle:restored.taskHandle,sourceSessionId:'B',constraints:['preserve the partial checkout'],pending:['complete only remaining implementation'],requestId:'recovered-environment-checkpoint'})
 const read=await h.material({action:'read-context',taskHandle:restored.taskHandle,contextId:checkpoint.contextId},'C')
 assert.equal(read.checkpoint.context.taskId,h.task.id)
 assert.deepEqual(read.checkpoint.context.pending,['complete only remaining implementation'])
 assert.equal(read.checkpoint.executionAuthority,'none')
 assert.equal((await h.run('status',{taskId:other.id})).recoveryRequired,true)
 assert.equal(count(),creations);assert.equal(h.cwd.get('B'),b.path);assert.equal(h.cwd.get('C'),c.path)
 assert.equal(await readFile(join(b.path,'calculate.cjs'),'utf8'),'partial uncommitted implementation\n')
 assert.equal(await readFile(join(c.path,'unrelated.txt'),'utf8'),'unrelated work stays intact\n')
 assert.equal(git(h.repo,'rev-parse','HEAD'),h.base)
})

test('communication revocation does not replace independent approval for active task environment control',async t=>{
 const h=await environmentFixture(t)
 assert.equal((await h.run('control',{object:'communication',action:'revoke',handle:h.communicationHandle,requestId:'environment-communication-revoke'})).communicationState,'revoked')
 assert.equal((await h.run('status',{taskHandle:h.task.taskHandle})).state,'active')
 const approvals=h.approvals.length
 const input={action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B'),requestId:'independently-approved-environment'},commands=h.commands.length
 h.setAnswer(async()=> 'rejected')
 await assert.rejects(h.material(input),/not authorized/)
 assert.equal(h.commands.length,commands)
 h.human('A');h.setAnswer(async()=> 'allowed-once')
 const created=await h.material(input)
 assert.equal(created.baseCommit,h.base)
 assert.equal(h.approvals.length,approvals+2,'an independent native environment approval is still required')
 const rejected=await h.run('send',{targets:['B'],content:'revoked communication stays revoked',context:{communicationHandle:h.communicationHandle,taskHandle:h.task.taskHandle},requestId:'environment-no-new-message'})
 assert.equal(rejected.results[0].admission,'rejected')
})

test('version-bound material adapter creates two pinned real worktrees and permits direct peer inspection',async t=>{
 const h=await environmentFixture(t)
 await writeFile(join(h.repo,'calculate.cjs'),'uncommitted user work\n');await writeFile(join(h.repo,'sentinel.txt'),'preserve original directory\n')
 const creates=['B','C'].map(sessionId=>({action:'worktree',sessionId,from:h.base,path:join(h.repo,'.agents',sessionId),requestId:'create-worktree-'+sessionId}))
 const [b,c]=await Promise.all(creates.map(args=>h.material(args)))
 assert.equal(b.baseCommit,h.base);assert.equal(c.baseCommit,h.base);assert.notEqual(h.cwd.get('B'),h.cwd.get('C'))
 assert.equal(await readFile(join(h.repo,'calculate.cjs'),'utf8'),'uncommitted user work\n');assert.equal(await readFile(join(h.repo,'sentinel.txt'),'utf8'),'preserve original directory\n')
 assert.equal(h.approvals.length,3,'communication approval does not replace two environment control approvals')
 const inspected=await h.material({action:'inspect',sessionId:'B'},'C');assert.equal(inspected.headCommit,h.base)
 const count=h.commands.filter(row=>row.argv.includes('add')&&row.argv.includes('worktree')).length
 assert.deepEqual(await h.material(creates[0],'A',{callId:'different-retry-call'}),b)
 assert.equal(h.commands.filter(row=>row.argv.includes('add')&&row.argv.includes('worktree')).length,count)
 await assert.rejects(h.material({...creates[0],from:'0'.repeat(40)}),/identity|conflict|another/)
 const revised=await h.run('control',{object:'task',action:'revise',taskHandle:h.task.taskHandle,expectedRevision:1,reason:'reviewed new requirements',objective:'updated implementation',requestId:'environment-revise'})
 assert.equal(revised.revision,2)
 await assert.rejects(h.material({action:'inspect',sessionId:'B'}),/revision/)
 assert.equal(git(b.path,'rev-parse','HEAD'),h.base)
})

test('integration rejects source and target drift before mutation and retains explicit failed requests',async t=>{
 const h=await environmentFixture(t),b=await h.material({action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B'),requestId:'drift-create-worktree'})
 await writeFile(join(b.path,'calculate.cjs'),'module.exports=(price,quantity)=>price*quantity*0.9\n');git(b.path,'add','.');git(b.path,'commit','-m','discount implementation')
 const review=await h.material({action:'inspect',sessionId:'B'},'C')
 await writeFile(join(b.path,'coverage.txt'),'review requested zero quantity coverage\n');git(b.path,'add','.');git(b.path,'commit','-m','add requested coverage')
 const before=git(h.repo,'rev-parse','HEAD'),input={action:'integrate',sessionId:'B',expectedSourceCommit:review.headCommit,expectedTargetCommit:before,requestId:'drift-source-merge'}
 await assert.rejects(h.material(input),/reviewed commit/)
 assert.equal(git(h.repo,'rev-parse','HEAD'),before)
 let status=await h.run('status',{taskHandle:h.task.taskHandle})
 assert.equal(Object.values(status.materialOperations).find(op=>op.request.requestId===input.requestId).status,'rejected','preflight proved that merge was never submitted')
 const current=await h.material({action:'inspect',sessionId:'B'},'C')
 await writeFile(join(h.repo,'target-note.txt'),'new integrator context\n');git(h.repo,'add','.');git(h.repo,'commit','-m','target moved')
 const moved=git(h.repo,'rev-parse','HEAD')
 await assert.rejects(h.material({...input,expectedSourceCommit:current.headCommit,requestId:'drift-target-merge'}),/target changed/)
 assert.equal(git(h.repo,'rev-parse','HEAD'),moved)
 status=await h.run('status',{taskHandle:h.task.taskHandle})
 assert.equal(Object.values(status.materialOperations).find(op=>op.request.requestId==='drift-target-merge').status,'rejected')
})


test('direct peer feedback adds real boundary tests and only reviewed commits reach independent business validation',async t=>{
 const h=await environmentFixture(t)
 const [b,c]=await Promise.all(['B','C'].map(sessionId=>h.material({action:'worktree',sessionId,from:h.base,path:join(h.repo,'.agents',sessionId),requestId:'review-create-'+sessionId})))
 const context={communicationHandle:h.communicationHandle,taskHandle:h.task.taskHandle}
 const requests=await Promise.all(['B','C'].map(target=>h.run('send',{targets:[target],content:'Implement your component and directly review the peer before reporting the exact commit',context})))
 await Promise.all([writeFile(join(b.path,'calculate.cjs'),'module.exports=(price,quantity)=>Math.round(price*quantity*(quantity>=10?0.9:1)*100)/100\n'),writeFile(join(c.path,'shipping.cjs'),'module.exports=weight=>weight<=3?5:5+(weight-3)*2\n')])
 for(const environment of [b,c]){git(environment.path,'add','.');git(environment.path,'commit','-m','implement assigned component')}
 const before=await h.material({action:'inspect',sessionId:'B'},'C')
 const reviewRequest=await h.run('send',{targets:['C'],content:'Review discount commit '+before.headCommit,context},'B')
 assert.equal(reviewRequest.results[0].admission,'accepted')
 execFileSync(process.execPath,['-e',`require('node:assert/strict').equal(require(${JSON.stringify(join(b.path,'calculate.cjs'))})(12,10),108)`],{cwd:c.path})
 const feedback=await h.run('send',{targets:['B'],content:'The normal discount check passes. Add executable zero quantity and threshold boundary assertions before final review.',replyTo:reviewRequest.results[0].messageId,context},'C')
 assert.equal(feedback.results[0].admission,'accepted')
 assert.ok((await h.run('read',{sessionId:'B'})).messages.some(m=>m.text.includes('zero quantity')))
 await writeFile(join(b.path,'discount-test.cjs'),"const assert=require('node:assert/strict'),calculate=require('./calculate.cjs');assert.equal(calculate(12,0),0);assert.equal(calculate(12,9),108);assert.equal(calculate(12,10),108)\n")
 execFileSync(process.execPath,['discount-test.cjs'],{cwd:b.path});git(b.path,'add','.');git(b.path,'commit','-m','add peer requested boundary assertions')
 const reviewedB=await h.material({action:'inspect',sessionId:'B'},'C'),reviewedC=await h.material({action:'inspect',sessionId:'C'},'B')
 assert.notEqual(reviewedB.headCommit,before.headCommit)
 execFileSync(process.execPath,[join(b.path,'discount-test.cjs')],{cwd:c.path})
 execFileSync(process.execPath,['-e',`require('node:assert/strict').equal(require(${JSON.stringify(join(c.path,'shipping.cjs'))})(5),9)`],{cwd:b.path})
 for(const [who,review,index] of [['C',reviewedB,1],['B',reviewedC,0]])assert.equal((await h.run('send',{targets:['A'],content:'Peer review and independent checks passed for exact commit '+review.headCommit,replyTo:requests[index].results[0].messageId,context},who)).results[0].admission,'accepted')
 const integration=join(h.repo,'.agents','integration');git(h.repo,'worktree','add','--detach',integration,h.base);h.cwd.set('A',integration)
 await writeFile(join(h.repo,'user-dirty.txt'),'original unrelated work remains\n')
 let target=h.base
 for(const [sessionId,review] of [['B',reviewedB],['C',reviewedC]]){
  const result=await h.material({action:'integrate',sessionId,expectedSourceCommit:review.headCommit,expectedTargetCommit:target,requestId:'review-integrate-'+sessionId})
  assert.equal(result.validation,'required');target=result.integratedCommit
 }
 execFileSync(process.execPath,['-e',"const assert=require('node:assert/strict');assert.equal(require('./calculate.cjs')(12,10)+require('./shipping.cjs')(5),117)"],{cwd:integration})
 execFileSync(process.execPath,['discount-test.cjs'],{cwd:integration})
 assert.equal(await readFile(join(h.repo,'user-dirty.txt'),'utf8'),'original unrelated work remains\n')
 assert.equal(git(h.repo,'rev-parse','HEAD'),h.base)
})

test('real merge conflict is retained, cannot replay under another ID, and resolved output is reviewed and tested',async t=>{
 const h=await environmentFixture(t),context={communicationHandle:h.communicationHandle,taskHandle:h.task.taskHandle}
 const [b,c]=await Promise.all(['B','C'].map(sessionId=>h.material({action:'worktree',sessionId,from:h.base,path:join(h.repo,'.agents',sessionId),requestId:'conflict-create-'+sessionId})))
 await writeFile(join(b.path,'calculate.cjs'),'module.exports=(price,quantity)=>price*quantity*0.9\n')
 await writeFile(join(c.path,'calculate.cjs'),'module.exports=(price,quantity)=>price*quantity*1.2\n')
 for(const environment of [b,c]){git(environment.path,'add','.');git(environment.path,'commit','-m',environment===b?'discount requirement':'tax requirement')}
 const reviews=await Promise.all([h.material({action:'inspect',sessionId:'B'},'C'),h.material({action:'inspect',sessionId:'C'},'B')])
 const integration=join(h.repo,'.agents','integration');git(h.repo,'worktree','add','--detach',integration,h.base);h.cwd.set('A',integration)
 const first=await h.material({action:'integrate',sessionId:'B',expectedSourceCommit:reviews[0].headCommit,expectedTargetCommit:h.base,requestId:'conflict-merge-first'})
 const conflicting={action:'integrate',sessionId:'C',expectedSourceCommit:reviews[1].headCommit,expectedTargetCommit:first.integratedCommit,requestId:'conflict-merge-second'}
 await assert.rejects(h.material(conflicting),error=>error.code==='COLLABORATION_ENVIRONMENT_UNKNOWN')
 assert.equal(git(integration,'rev-parse','MERGE_HEAD'),reviews[1].headCommit)
 assert.match(git(integration,'status','--porcelain'),/UU calculate.cjs/)
 assert.match(await readFile(join(integration,'calculate.cjs'),'utf8'),/<<<<<<</)
 const status=await h.run('status',{taskHandle:h.task.taskHandle})
 assert.equal(Object.values(status.materialOperations).find(op=>op.request.requestId===conflicting.requestId).status,'unknown')
 const approvals=h.approvals.length,merges=h.commands.filter(row=>row.argv.includes('merge')).length
 await assert.rejects(h.material(conflicting),/unknown/)
 await assert.rejects(h.material({...conflicting,requestId:'conflict-new-identity'}),/unknown/)
 assert.equal(h.approvals.length,approvals);assert.equal(h.commands.filter(row=>row.argv.includes('merge')).length,merges)
 // Explicit conflict resolution retains both legitimate requirements; it is not an automatic rollback.
 await writeFile(join(integration,'calculate.cjs'),'module.exports=(price,quantity)=>Math.round(price*quantity*0.9*1.2*100)/100\n')
 git(integration,'add','calculate.cjs');git(integration,'commit','-m','resolve discount and tax composition')
 const resolved=git(integration,'rev-parse','HEAD')
 const request=await h.run('send',{targets:['C'],content:'Re-review resolved integration '+resolved+' at '+integration,context})
 execFileSync(process.execPath,['-e',`const assert=require('node:assert/strict'),calculate=require(${JSON.stringify(join(integration,'calculate.cjs'))});assert.equal(calculate(100,10),1080);assert.equal(calculate(100,0),0)`],{cwd:c.path})
 const evidence=await h.run('send',{targets:['A'],content:'Resolved commit '+resolved+' independently reviewed and discount plus tax checks passed',replyTo:request.results[0].messageId,context},'C')
 const completed=await h.run('control',{object:'task',action:'finish',taskHandle:h.task.taskHandle,expectedRevision:1,reason:'verified resolved current commit with independent checks',evidenceRefs:[evidence.results[0].messageId],requestId:'conflict-finish'})
 assert.equal(completed.state,'completed');assert.equal(git(integration,'status','--porcelain'),'')
 assert.equal(git(b.path,'rev-parse','HEAD'),reviews[0].headCommit);assert.equal(git(c.path,'rev-parse','HEAD'),reviews[1].headCommit)
})

test('a lost completed checkpoint reports unknown after real checkout mutation and never replays it',async t=>{
 const h=await environmentFixture(t),runtime=await h.env.collaboration,update=runtime.store.update.bind(runtime.store)
 let lost=false
 runtime.store.update=async(...args)=>{const result=await update(...args);if(!lost&&Object.values(result.data.tasks).some(task=>Object.values(task.materialOperations??{}).some(op=>op.status==='completed'&&op.request.action==='worktree'))){lost=true;throw Object.assign(new Error('result checkpoint durability is unknown'),{code:'durability-unknown'})}return result}
 const input={action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B'),requestId:'checkpoint-worktree'}
 await assert.rejects(h.material(input),error=>{assert.equal(lost,true);assert.notEqual(h.cwd.get('B'),h.repo);assert.equal(error.code,'COLLABORATION_ENVIRONMENT_UNKNOWN');assert.match(error.cause.message,/checkpoint/);return true})
 const count=h.commands.filter(row=>row.argv.includes('worktree')&&row.argv.includes('add')).length
 await assert.rejects(h.material(input),/recovery|unknown/)
 assert.equal(h.commands.filter(row=>row.argv.includes('worktree')&&row.argv.includes('add')).length,count)
 assert.equal(await readFile(join(input.path,'calculate.cjs'),'utf8'),'module.exports=(price,quantity)=>price*quantity\n')
})

test('environment approval never shows ignored parameters or follows a changed integration directory',async t=>{
 const h=await environmentFixture(t),b=await h.material({action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B'),requestId:'approval-create-worktree'})
 await writeFile(join(b.path,'calculate.cjs'),'module.exports=(price,quantity)=>price*quantity*0.9\n');git(b.path,'add','.');git(b.path,'commit','-m','reviewed source')
 const source=git(b.path,'rev-parse','HEAD'),actual=join(h.repo,'.agents','actual'),other=join(h.repo,'.agents','other')
 for(const path of [actual,other])git(h.repo,'worktree','add','--detach',path,h.base)
 h.cwd.set('A',actual)
 const input={action:'integrate',sessionId:'B',expectedSourceCommit:source,expectedTargetCommit:h.base,requestId:'approval-path-merge'}
 const approvals=h.approvals.length
 await assert.rejects(h.material({...input,path:other}),/not applicable|unsupported.*field/)
 assert.equal(h.approvals.length,approvals);assert.equal(git(actual,'rev-parse','HEAD'),h.base)
 for(const args of [{action:'inspect',sessionId:'B',path:other},{action:'worktree',sessionId:'C',expectedTargetCommit:h.base,requestId:'inapplicable-create'}])await assert.rejects(h.material(args),/not applicable|unsupported.*field/)
 let shown
 h.setAnswer(async()=>{shown=JSON.parse(h.approvals.at(-1).reason);h.cwd.set('A',other);return 'allowed-once'})
 await assert.rejects(h.material(input),/directory changed|target path/)
 assert.equal(shown.targetPath,actual)
 assert.equal(git(actual,'rev-parse','HEAD'),h.base);assert.equal(git(other,'rev-parse','HEAD'),h.base)
 assert.equal(h.commands.filter(row=>row.argv.includes('merge')).length,0)
})

test('pre-cancel and denied environment requests do not mutate, and fresh human approval can retry the same known-unsubmitted identity',async t=>{
 const h=await environmentFixture(t),cancel=new AbortController();cancel.abort(new Error('cancel before allocation'))
 const input={action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B'),requestId:'denied-environment'}
 const approvals=h.approvals.length,commands=h.commands.length
 await assert.rejects(h.material(input,'A',{signal:cancel.signal}),/cancel before allocation/)
 assert.equal(h.approvals.length,approvals);assert.equal(h.commands.length,commands)
 h.setAnswer(async()=> 'rejected')
 await assert.rejects(h.material(input),/not authorized/)
 assert.equal(h.commands.length,commands)
 await assert.rejects(h.material(input),/not authorized|rejected|denied/)
 assert.equal(h.approvals.length,approvals+1,'denial cannot cause automatic repeated approval')
 const status=await h.run('status',{taskHandle:h.task.taskHandle})
 assert.equal(Object.values(status.materialOperations).find(op=>op.request.requestId===input.requestId).status,'rejected')
 await assert.rejects(h.material({...input,from:'0'.repeat(40)}),/identity|another/)
 h.human('A');h.setAnswer(async()=> 'allowed-once')
 const created=await h.material(input)
 assert.equal(created.baseCommit,h.base);assert.equal(h.approvals.length,approvals+2)
})

test('review inspection cannot label a later diff with an earlier clean commit identity',async t=>{
 const h=await environmentFixture(t),b=await h.material({action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B'),requestId:'inspection-race-create'})
 const spawn=h.services.subprocess.spawn
 let changed=false
 h.services.subprocess.spawn=options=>{if(!changed&&options.cwd===b.path&&options.argv.includes('diff')){changed=true;execFileSync(process.execPath,['-e',"require('node:fs').writeFileSync('calculate.cjs','module.exports=()=>17\\n')"],{cwd:b.path});git(b.path,'add','.');git(b.path,'commit','-m','source changed during inspection')}return spawn(options)}
 await assert.rejects(h.material({action:'inspect',sessionId:'B'},'C'),/changed during|changed while/)
 assert.equal(changed,true)
 const fresh=await h.material({action:'inspect',sessionId:'B'},'C')
 assert.equal(fresh.headCommit,git(b.path,'rev-parse','HEAD'));assert.match(fresh.diff,/module.exports=\(\)=>17/)
})

test('legacy coordinates cannot bypass current task reference and independent environment approval for new work',async t=>{
 const h=await environmentFixture(t),runtime=await h.env.collaboration
 const {scopeId,taskId}=runtime.taskCoordinates(h.task.taskHandle,{agent:h.agents.get('A'),callId:'read-task-coordinates',signal:new AbortController().signal})
 const approvals=h.approvals.length
 await assert.rejects(h.run('collaboration_material',{scopeId,taskId,action:'worktree',sessionId:'B',from:h.base,path:join(h.repo,'.agents','B')}),/taskHandle/)
 assert.equal(h.approvals.length,approvals);assert.equal(h.commands.length,0);assert.equal(h.cwd.get('B'),h.repo)
})
