// Actual desktop Inbox and SDK SessionStore; controlled durability, no provider or desktop run.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {Context} from 'cordis'
import {SessionStore,pluginRecordOf} from '@deepseek-ai/dsh-session'
import {z} from 'zod'
import {fixture} from './fixtures/session-tools.mjs'

const source=execFileSync(process.execPath,['tools/asar.mjs','cat','/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'],{encoding:'utf8'})
const start=source.indexOf('//#region lib/types/inbox.js'),end=source.indexOf('//#endregion',start)
assert.ok(start>=0&&end>start)
const {ReactLoopInbox,inboxProjectionDefinition}=new Function('z$1',source.slice(start,end)+'\nreturn {ReactLoopInbox,inboxProjectionDefinition}')(z)

function mounted(){
  const h=fixture(),root=new Context(),sessions=new SessionStore(root),leave=[]
  root.on('session/event',(s,e)=>{for(const fn of h.listeners.get('session/event')??[])fn(s,e)})
  for(const id of ['A','B']){
    const a=h.agents.get(id),session=sessions.prepare(id)
    leave.push(sessions.enter(session));sessions.announce(session);a.session=session
    a.inbox=new ReactLoopInbox({stateOf:s=>s.snapshotEvents().reduce((state,event)=>inboxProjectionDefinition.apply(state,event),inboxProjectionDefinition.init())},session,{emit(name,payload){for(const fn of h.listeners.get(name)??[])fn({agent:a,...payload})}})
    a.steer=m=>a.inbox.append('next-step',m);a.followup=m=>a.inbox.append('next-turn',m)
  }
  h.human('A')
  return {...h,async close(){for(const done of leave.reverse())done();await root.fiber.dispose()}}
}

async function exchange(h,editRoot=false){
  const first=await h.run('send',{targets:['B'],content:'original task',delivery:'queue',requestId:'recovery-host-original',authorizationRequest:{participants:['A','B'],purpose:'one report',extent:'message',reply:'once'}})
  assert.equal(first.results[0].admission,'accepted')
  const id=first.results[0].messageId
  if(editRoot)assert.equal((await h.run('control',{object:'message',action:'edit',messageId:id,expectedRevision:1,content:'revised task',requestId:'recovery-host-edit-root'})).outcome,'edited')
  const b=h.agents.get('B'),claimed=b.inbox.claim('next-turn',1)
  b.session.append('user/message',claimed[0],{surfaceOp:'append'})
  const reply=await h.run('send',{targets:['A'],content:'original result',replyTo:id,requestId:'recovery-host-reply'},'B')
  assert.equal(reply.results[0].admission,'accepted')
  return {id,replyId:reply.results[0].messageId}
}

const wait=(h,id)=>h.env.delivery.waitForRequest('A','B',id,1,new AbortController().signal)

test('edited original request reconciles its actual reply after reload without replay',async()=>{
  const h=mounted()
  try{
    const {id}=await exchange(h,true),events=h.agents.get('B').session.snapshotEvents().length
    h.reload()
    const result=await wait(h,id)
    assert.equal(result.message.text,'original result');assert.equal(result.recovered,true)
    assert.equal(h.agents.get('B').session.snapshotEvents().length,events)
  }finally{await h.close()}
})

test('pending reply edit is read at its current version before and after reload',async()=>{
  const h=mounted()
  try{
    const {id,replyId}=await exchange(h)
    assert.equal((await h.run('control',{object:'message',action:'edit',messageId:replyId,expectedRevision:1,content:'revised result',requestId:'recovery-host-edit-reply'},'B')).outcome,'edited')
    assert.equal((await wait(h,id)).message.text,'revised result')
    h.reload();assert.equal((await wait(h,id)).message.text,'revised result')
  }finally{await h.close()}
})

test('withdrawn pending reply is not returned from a cached or recovered answer',async()=>{
  const h=mounted()
  try{
    const {id,replyId}=await exchange(h)
    assert.equal((await h.run('control',{object:'message',action:'withdraw',messageId:replyId,requestId:'recovery-host-withdraw'},'B')).outcome,'withdrawn')
    await assert.rejects(wait(h,id),/reply|evidence/)
    h.reload();await assert.rejects(wait(h,id),/reply|evidence/)
  }finally{await h.close()}
})

test('changed native source identity cannot pass as a legitimate pending edit',async()=>{
  const h=mounted()
  try{
    const {id,replyId}=await exchange(h),a=h.agents.get('A')
    const reply=structuredClone(a.inbox.nextStep.find(message=>message.id===replyId))
    reply.source.senderSessionId='forged-sender'
    a.inbox.replace(replyId,reply)
    h.reload();await assert.rejects(wait(h,id),/evidence/)
  }finally{await h.close()}
})

test('native claim is readable before publication, but is not resurrected across runtime replacement',async()=>{
  const h=mounted()
  try{
    const {id,replyId}=await exchange(h),a=h.agents.get('A')
    assert.equal(a.inbox.claim('next-step',1)[0].id,replyId)
    assert.equal(a.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===replyId),false)
    assert.equal((await wait(h,id)).message.text,'original result')
    h.listeners.clear();h.reload()
    await assert.rejects(wait(h,id),/evidence/)
  }finally{await h.close()}
})

test('a claim observed after replacement can reconcile a historical request without restoring authority',async()=>{
  const h=mounted()
  try{
    const {id,replyId}=await exchange(h),a=h.agents.get('A')
    h.listeners.clear();h.reload()
    assert.equal(a.inbox.claim('next-step',1)[0].id,replyId)
    assert.equal((await wait(h,id)).message.text,'original result')
    assert.equal(h.approvals.length,1)
  }finally{await h.close()}
})

for(const failure of ['none','target-flush','sender-receipt-flush'])test('historical send reconciliation requires the native target durability barrier: '+failure,async()=>{
  const h=mounted()
  try{
    h.setFlush(async session=>{
      if(failure==='target-flush'&&session.id==='B')throw Error('target durability unknown')
      if(failure==='sender-receipt-flush'&&session.id==='A'&&session.snapshotEvents().some(event=>pluginRecordOf(event)?.data?.stage==='delivered'))throw Error('receipt persistence unknown')
      return true
    })
    const args={targets:['B'],content:'original business work',requestId:'recovery-history-send'}
    const first=await h.run('send',args)
    assert.equal(first.results[0].admission,failure==='none'?'accepted':'unknown')
    const events=h.agents.get('B').session.snapshotEvents().length,approvals=h.approvals.length
    h.listeners.clear();h.reload()
    const recovered=await h.run('send',args)
    assert.equal(recovered.historical,true)
    assert.equal(recovered.communicationHandle,undefined)
    assert.equal(recovered.results[0].messageId,first.results[0].messageId)
    assert.equal(recovered.results[0].admission,failure==='target-flush'?'unknown':'accepted')
    assert.equal(h.agents.get('B').session.snapshotEvents().length,events)
    assert.equal(h.approvals.length,approvals)
  }finally{await h.close()}
})
