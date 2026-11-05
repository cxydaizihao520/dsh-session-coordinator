import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fixture} from './fixtures/session-tools.mjs'

test('wait consumes only the selected new reply and returns a reusable per-chat cursor',async()=>{
 const h=fixture();h.human('A')
 const sent=await h.run('send',{targets:['B'],content:'request',requestId:'wait-request-one',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 const handle=sent.communicationHandle,replyTo=sent.results[0].messageId,afterCursor=sent.results[0].afterCursor
 assert.equal(typeof afterCursor,'string')
 const other=await h.run('send',{targets:['B'],content:'other request',requestId:'wait-other-request',context:{communicationHandle:handle}})
 await h.run('send',{targets:['A'],content:'unrelated answer',requestId:'wait-unrelated-answer',replyTo:other.results[0].messageId,context:{communicationHandle:handle}},'B')
 const empty=await h.run('wait',{targets:[{sessionId:'B',afterCursor,replyTo}],timeoutMs:1})
 assert.equal(empty.updates.length,0);assert.equal(empty.timedOut,true)
 await h.run('send',{targets:['A'],content:'correct answer',replyTo,requestId:'wait-correct-answer',context:{communicationHandle:handle}},'B')
 const got=await h.run('wait',{targets:[{sessionId:'B',afterCursor:empty.cursors[0].afterCursor,replyTo}],timeoutMs:10})
 assert.equal(got.updates[0].messages[0].text,'correct answer')
 const repeat=await h.run('wait',{targets:[{sessionId:'B',afterCursor:got.cursors[0].afterCursor,replyTo}],timeoutMs:1})
 assert.equal(repeat.updates.length,0);assert.equal(repeat.timedOut,true)
 const render=h.tools.get('session_coordinator_wait').output.render({},got)
 assert.deepEqual(JSON.parse(render[0].text).cursors,got.cursors)
})

test('wait any/all retains per-target failures and cancellation never stops the target',async()=>{
 const h=fixture();h.human('A');h.make('C')
 const b=await h.run('status',{sessionId:'B'}),c=await h.run('status',{sessionId:'C'})
 h.human('B')
 const any=await h.run('wait',{targets:[{sessionId:'B',afterCursor:b.afterCursor},{sessionId:'C',afterCursor:c.afterCursor}],mode:'any',timeoutMs:10})
 assert.equal(any.updates.length,1);assert.equal(any.updates[0].sessionId,'B')
 const all=await h.run('wait',{targets:[{sessionId:'B',afterCursor:b.afterCursor},{sessionId:'C',afterCursor:c.afterCursor}],mode:'all',timeoutMs:1})
 assert.equal(all.updates.length,1);assert.equal(all.timedOut,true)
 const partial=await h.run('wait',{targets:[{sessionId:'B',afterCursor:b.afterCursor},{sessionId:'C',afterCursor:b.afterCursor}],timeoutMs:1})
 assert.equal(partial.updates.length,1);assert.equal(partial.errors[0].sessionId,'C')
 const abort=new AbortController();const pending=h.run('wait',{targets:[{sessionId:'C',afterCursor:c.afterCursor}],timeoutMs:1000},'A',{signal:abort.signal});abort.abort()
 const result=await pending;assert.equal(result.aborted,true);assert.equal(h.effects.length,0)
})

test('work continuation can answer its unique incoming business result without losing correlation',async()=>{
 const h=fixture();h.human('A')
 const first=await h.run('send',{targets:['B'],content:'implement and review stage one',requestId:'work-correlate-first',authorizationRequest:{participants:['A','B'],purpose:'incremental implementation and review',extent:'work'}})
 const context={communicationHandle:first.communicationHandle}
 const report=await h.run('send',{targets:['A'],content:'stage one passed; next stage can begin',requestId:'work-correlate-report',context},'B')
 assert.equal(h.effects.at(-1)[2].source.replyTo,first.results[0].messageId)
 const next=await h.run('send',{targets:['B'],content:'implement stage two using that review',requestId:'work-correlate-next',context})
 assert.equal(next.results[0].admission,'accepted')
 assert.equal(h.effects.at(-1)[2].source.replyTo,report.results[0].messageId)
 const update=await h.run('wait',{targets:[{sessionId:'A',afterCursor:report.results[0].afterCursor,replyTo:report.results[0].messageId}],timeoutMs:10},'B')
 assert.equal(update.updates[0]?.messages[0]?.text,'implement stage two using that review')
 assert.equal(update.timedOut,false)
 assert.equal(h.approvals.length,1)
})

test('two unanswered work inputs still require an explicit reply identity',async()=>{
 const h=fixture();h.human('A')
 const first=await h.run('send',{targets:['B'],content:'review',requestId:'work-ambiguous-first',authorizationRequest:{participants:['A','B'],purpose:'review and refine',extent:'work'}})
 const context={communicationHandle:first.communicationHandle}
 const report=await h.run('send',{targets:['A'],content:'review result',requestId:'work-ambiguous-report',context},'B')
 await h.run('send',{targets:['A'],content:'independent question',requestId:'work-ambiguous-question',context},'B')
 const before=h.effects.length
 const ambiguous=await h.run('send',{targets:['B'],content:'unclear answer',requestId:'work-ambiguous-answer',context})
 assert.equal(ambiguous.results[0].admission,'rejected')
 assert.match(ambiguous.results[0].error.message,/AUTHORIZATION_AMBIGUOUS/)
 assert.equal(h.effects.length,before)
 const explicit=await h.run('send',{targets:['B'],content:'answer that review',requestId:'work-explicit-answer',replyTo:report.results[0].messageId,context})
 assert.equal(explicit.results[0].admission,'accepted')
 assert.equal(h.effects.at(-1)[2].source.replyTo,report.results[0].messageId)
 assert.equal(h.approvals.length,1)
})

test('cursor wait yields for new next-step input without pretending it is the selected reply',async()=>{
 for(const kind of ['user','session-message']){
  const h=fixture(),b=await h.run('status',{sessionId:'B'})
  const message={id:'pending-'+kind,role:'user',source:{kind},content:[{type:'text',text:'new input'}]}
  const pending=h.run('wait',{targets:[{sessionId:'B',afterCursor:b.afterCursor,replyTo:'different-request'}],timeoutMs:150})
  const timer=setTimeout(()=>h.agents.get('A').inbox.nextStep.push(message),10)
  const result=await pending;clearTimeout(timer)
  assert.equal(result.pendingInput,true)
  assert.equal(result.timedOut,false);assert.equal(result.aborted,false)
  assert.deepEqual(result.updates,[])
  assert.deepEqual(h.agents.get('A').inbox.nextStep,[message])
  assert.equal(h.effects.length,0)
 }
})

test('queued next-turn input does not interrupt a cursor wait',async()=>{
 const h=fixture(),b=await h.run('status',{sessionId:'B'})
 const message={id:'queued',role:'user',source:{kind:'user'},content:[{type:'text',text:'after this turn'}]}
 h.agents.get('A').inbox.nextTurn.push(message)
 const result=await h.run('wait',{targets:[{sessionId:'B',afterCursor:b.afterCursor}],timeoutMs:1})
 assert.equal(result.pendingInput,undefined);assert.equal(result.timedOut,true)
 assert.deepEqual(h.agents.get('A').inbox.nextTurn,[message]);assert.equal(h.effects.length,0)
})

test('returned cursors preserve the selected reply when reused after a timeout',async()=>{
 const h=fixture();h.human('A')
 const sent=await h.run('send',{targets:['B'],content:'review this change',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 const first=await h.run('wait',{targets:[{sessionId:'B',afterCursor:sent.results[0].afterCursor,replyTo:sent.results[0].messageId}],timeoutMs:1})
 h.human('B')
 const next=await h.run('wait',{targets:first.cursors,timeoutMs:1})
 assert.deepEqual(next.updates,[],'unrelated activity must not satisfy the selected business reply')
 assert.equal(next.timedOut,true)
 assert.equal(next.cursors[0].replyTo,sent.results[0].messageId)
})

test('send, create and status return complete wait targets without reconstructing identities',async()=>{
 const h=fixture();h.human('A')
 const sent=await h.run('send',{targets:['B'],content:'review',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}})
 const result=sent.results[0]
 assert.deepEqual(result.waitTarget,{sessionId:'B',afterCursor:result.afterCursor,replyTo:result.messageId})
 const first=await h.run('wait',{targets:[result.waitTarget],timeoutMs:1})
 assert.equal(first.timedOut,true)
 await h.run('send',{targets:['A'],content:'review passed',replyTo:result.messageId,context:{communicationHandle:sent.communicationHandle}},'B')
 const reply=await h.run('wait',{targets:first.cursors,timeoutMs:10})
 assert.equal(reply.updates[0].messages[0].text,'review passed')
 const created=await h.run('create',{requestId:'wait-created-chat',initialMessage:{content:'review',authorizationRequest:{purpose:'review',extent:'message',reply:'once'}}})
 assert.deepEqual(created.initialMessage.waitTarget,{sessionId:created.sessionId,afterCursor:created.initialMessage.afterCursor,replyTo:created.initialMessage.messageId})
 const status=await h.run('status',{sessionId:'B'})
 assert.deepEqual(status.waitTarget,{sessionId:'B',afterCursor:status.afterCursor})
})

test('malformed cursor targets fail before observing or changing another chat',async()=>{
 const h=fixture()
 const status=await h.run('status',{sessionId:'B'})
 for(const targets of [[null],[{}],[{sessionId:'B'}],[{sessionId:'B',afterCursor:3}],[{sessionId:'B',afterCursor:status.afterCursor,replyTo:''}]]){
  await assert.rejects(h.run('wait',{targets,timeoutMs:1}),/invalid arguments|wait targets require sessionId, afterCursor/)
 }
 assert.deepEqual(h.effects,[])
})
