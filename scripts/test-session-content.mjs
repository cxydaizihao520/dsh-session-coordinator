import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Session} from '@deepseek-ai/dsh-session'
import {buildForkSeed} from '@deepseek-ai/dsh-session/fork'
import {prepareSessionContent, assertSessionContentModel} from '../src/session-content.ts'
import {fixture} from './fixtures/session-tools.mjs'

test('registered send and create consumers preserve multipart bodies and expose captured references',async()=>{
  const h=fixture();h.human('A')
  const b=h.agents.get('B');b.ctx={get:name=>name==='sessionReferenceResolver'?{prepare:async(_agent,content)=>({content,additionalContext:{id:'captured',role:'user',source:{kind:'session-reference',form:'recall',version:1,references:[{sessionId:'C',capturedThroughSeq:3}]},content:[{type:'text',text:'captured review constraint'}]}})}:undefined}
  const sent=await h.run('send',{targets:['B'],content:[{type:'text',text:'  first\n'},{type:'reference',sessionId:'C'},{type:'text',text:'last'}],requestId:'multipart-send-01'})
  assert.equal(sent.results[0].admission,'accepted',JSON.stringify(sent))
  assert.deepEqual(h.effects.find(e=>e[0]==='send')[2].content,[{type:'text',text:'  first\n'},{type:'text',text:'last'}])
  assert.match(h.env.delivery.modelContext(b),/captured review constraint/)
  assert.deepEqual(await h.run('send',{targets:['B'],content:[{text:'  first\n',type:'text'},{sessionId:'C',type:'reference'},{text:'last',type:'text'}],requestId:'multipart-send-01'}),sent)
  h.reload()
  assert.match(h.env.delivery.modelContext(b),/captured review constraint/)
  assert.match(h.env.delivery.modelContext(b),/"replyPermission":"none"/)
  assert.doesNotMatch(h.env.delivery.modelContext(b),/"communicationHandle"|"replyTo"/)
  h.human('B')
  assert.match(h.env.delivery.modelContext(b),/captured review constraint/)
  const child=h.make('forked-B'),cut=b.session.seq-1
  child.session=Session.create(child.id,buildForkSeed(b.session.snapshotEvents(),cut),{...b.session.header,id:child.id,isSeeded:true},cut+1)
  assert.match(h.env.delivery.modelContext(child),/captured review constraint/)
  assert.match(h.env.delivery.modelContext(child),/"replyPermission":"none"/)
  const incoming=b.session.snapshotEvents().find(event=>event.type==='user/message')
  b.session.append('user/message',{id:'compact',role:'user',source:{kind:'compact-checkpoint'},content:[{type:'text',text:'retained summary'}]},{surfaceOp:{op:'replace',startSeq:incoming.seq,endSeq:incoming.seq},sourceEventSeqs:[incoming.seq]})
  assert.doesNotMatch(h.env.delivery.modelContext(b),/captured review constraint/)
  const created=await h.run('create',{requestId:'multipart-create-01',initialMessage:{content:[{type:'text',text:'  exact first task\n'}]}})
  assert.equal(created.initialMessage.admission,'accepted',JSON.stringify(created))
  assert.equal(h.effects.find(e=>e[0]==='send'&&e[1]===created.sessionId)[2].content[0].text,'  exact first task\n')
})

test('multipart reply recovery retains native content and does not replay either side',async()=>{
  const h=fixture();h.human('A')
  const sent=await h.run('send',{targets:['B'],content:[{type:'text',text:'request'}],authorizationRequest:{participants:['A','B'],purpose:'report',extent:'message',reply:'once'}})
  const id=sent.results[0].messageId
  await h.run('send',{targets:['A'],replyTo:id,content:[{type:'text',text:'  result\n'},{type:'text',text:'tail'}]},'B')
  const before=await h.env.delivery.waitForRequest('A','B',id,1,new AbortController().signal)
  assert.equal(before.message.text,'  result\ntail');assert.equal(before.message.content.length,2)
  h.reload()
  const after=await h.env.delivery.waitForRequest('A','B',id,1,new AbortController().signal)
  assert.equal(after.recovered,true);assert.deepEqual(after.message,before.message)
  assert.equal(h.effects.filter(e=>e[0]==='send').length,2)
})

test('denied approval does not prepare content and cancellation during reference capture does not submit',async()=>{
  const h=fixture();h.human('A');let preparations=0
  const stop=new AbortController()
  h.agents.get('B').ctx={get:name=>name==='sessionReferenceResolver'?{prepare:async()=>{preparations++;stop.abort(new Error('cancel captured reference'));return {additionalContext:{id:'ref',role:'user',source:{kind:'session-reference'},content:[]}}}}:undefined}
  h.setAnswer(async()=> 'rejected')
  const input={targets:['B'],content:[{type:'reference',sessionId:'C'}]}
  assert.equal((await h.run('send',input)).results[0].admission,'rejected');assert.equal(preparations,0)
  h.human('A');h.setAnswer(async()=> 'allowed-once')
  const cancelled=await h.run('send',input,'A',{signal:stop.signal})
  assert.equal(cancelled.results[0].error.code,'CANCELLED');assert.equal(preparations,1)
  assert.equal(h.effects.filter(e=>e[0]==='send').length,0)
})

function target(services = {}) {
  return {id:'B',session:Session.create('B'),options:{provider:'chosen',model:'vision'},ctx:{get:name=>services[name]}}
}
test('text stays exact and native reference context remains separate from the business body',async()=>{
  let received
  const context={id:'native-reference',role:'user',source:{kind:'session-reference',form:'recall',version:1,references:[{sessionId:'C',label:'review',capturedThroughSeq:9}]},content:[{type:'text',text:'untrusted captured evidence'}]}
  const b=target({sessionReferenceResolver:{async prepare(agent,content,refs){received={agent,content,refs};return {content,additionalContext:context}}}})
  const result=await prepareSessionContent(b,b,[{type:'text',text:'  exact\n'},{type:'reference',sessionId:'C',label:'review'},{type:'text',text:'tail'}])
  assert.deepEqual(result.content,[{type:'text',text:'  exact\n'},{type:'text',text:'tail'}]);assert.deepEqual(result.referenceContext,context)
  assert.equal(received.agent,b);assert.deepEqual(received.refs,[{sessionId:'C',label:'review'}]);assert.equal(result.artifacts.length,0)
  assert.deepEqual((await prepareSessionContent(b,b,' \ntext\n ')).content,[{type:'text',text:' \ntext\n '}])
  await assert.rejects(prepareSessionContent(b,b,[{type:'image',attachment:{attachmentId:'forged'}}]),/path|material/)
  await assert.rejects(prepareSessionContent(b,b,[{type:'reasoning',text:'hidden'}]),/content|type/)
  await assert.rejects(prepareSessionContent(b,b,[]),/empty|content/)
})
test('missing reference support and cancellation never produce a prepared message',async()=>{
  const b=target();await assert.rejects(prepareSessionContent(b,b,[{type:'reference',sessionId:'C'}]),/reference.*unavailable/i)
  const stop=new AbortController();stop.abort(new Error('cancel material preparation'))
  await assert.rejects(prepareSessionContent(b,b,'business',stop.signal),/cancel material/)
})
test('image admission rejects unsupported or unknown selected routes before storing bytes',async()=>{
  let saves=0
  for(const info of [{inputModalities:['text']},{},undefined]){
    const b=target({llm:{resolveModelInfo:async()=>info},attachments:{saveImages(){saves++}}})
    await assert.rejects(prepareSessionContent(b,b,[{type:'image',path:'/not-read.png',mediaType:'image/png'}]),/image|capability/i)
  }
  assert.equal(saves,0)
})
test('the final synchronous model check observes pending selection ahead of a saved header',()=>{
  let pending={provider:'chosen',model:'vision'}
  const b=target({sessionProjections:{stateOf:()=>({pending})}})
  assert.doesNotThrow(()=>assertSessionContentModel(b,{modelRoute:{provider:'chosen',model:'vision'}}))
  pending={provider:'chosen',model:'text-only'}
  assert.throws(()=>assertSessionContentModel(b,{modelRoute:{provider:'chosen',model:'vision'}}),/model.*changed/i)
})
