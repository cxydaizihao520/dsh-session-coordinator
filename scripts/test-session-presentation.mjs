import assert from 'node:assert/strict'
import {test} from 'node:test'
import {tasksFixture} from './fixtures/session-tasks.mjs'
import {titleOf,sessionEvents} from '../src/core.ts'

test('a received task never becomes the sender name; registered title and exact body survive the reply',async()=>{
 const h=await tasksFixture();h.human('A');h.env.registry.get=async id=>id==='B'?{title:'结算测试'}:undefined;
 const first=await h.run('send',{targets:['B'],content:'  原文\n```js\nreturn 1\n```',authorizationRequest:{participants:['A','B'],purpose:'test',extent:'message',reply:'once'}});
 assert.equal(titleOf(sessionEvents(h.agents.get('B').session)),undefined);
 const reply=await h.run('send',{targets:['A'],content:'  已通过\n',replyTo:first.results[0].messageId},'B');assert.equal(reply.results[0].admission,'accepted');
 const sent=h.effects.filter(e=>e[0]==='send'&&e[1]==='A').at(-1)[2];assert.equal(sent.source.senderLabel,'结算测试');assert.equal(sent.content[0].text,'  已通过\n');
})

test('only an exclusive once reply can conclude the current turn; work or other inputs cannot',async()=>{
 for(const other of [undefined,'user','snapshot','recall','work','pending']){
  const h=await tasksFixture();h.human('A');const b=h.agents.get('B');b.session.append('turn/start',{turn:1});b.ctx.get=name=>name==='jobs'?{list:()=>[]}:undefined;
  const work=other==='work';const first=await h.run('send',{targets:['B'],content:'one requested report',authorizationRequest:{participants:['A','B'],purpose:'test',extent:work?'work':'message',...(!work?{reply:'once'}:{})}});
  if(other==='pending')b.inbox.nextTurn.push({id:'other-pending',role:'user',source:{kind:'user'},content:[]});
  else if(other&&!work)b.session.append('user/message',{id:'other-input',role:'user',source:{kind:other},content:[{type:'text',text:'other work'}]},{surfaceOp:'append'});
  b.session.append('step/start',{turn:1,step:1});b.session.append('assistant/message',{turn:1,step:1,message:{id:'g5-plan',role:'assistant',content:[{type:'tool-call',id:'g5-reply',name:'session_coordinator_send',arguments:'{}'}]}},{surfaceOp:'append'});b.session.append('tool/call',{turn:1,step:1,callId:'g5-reply',name:'session_coordinator_send',arguments:'{}'});
  const reply=await h.run('send',{targets:['A'],content:'actual result',...(work?{context:{communicationHandle:first.communicationHandle}}:{replyTo:first.results[0].messageId})},'B',{callId:'g5-reply'});
  assert.equal(reply.results[0].admission,'accepted',JSON.stringify(reply));assert.equal(h.effects.filter(e=>e[0]==='conclude').length,other===undefined?1:0,String(other));
 }
})

test('automatic conclusion requires native single-call proof and verified absence of background jobs',async()=>{
 for(const scenario of ['other-planned-call','nested-call','missing-execution','missing-plan','running-job','settled-job','unknown-jobs']){
  const h=await tasksFixture();h.human('A');const b=h.agents.get('B');b.session.append('turn/start',{turn:1});b.ctx.get=name=>name==='jobs'?(scenario==='unknown-jobs'?undefined:{list:()=>scenario==='running-job'?[{id:'job-running',status:'running'}]:scenario==='settled-job'?[{id:'job-settled',status:'completed'}]:[]}):undefined;
  const first=await h.run('send',{targets:['B'],content:'one report',authorizationRequest:{extent:'message',participants:['A','B'],purpose:'test',reply:'once'}});
  b.session.append('step/start',{turn:1,step:1});if(scenario!=='missing-plan')b.session.append('assistant/message',{turn:1,step:1,message:{id:'g5-plan',role:'assistant',content:[{type:'tool-call',id:'g5-reply',name:'session_coordinator_send',arguments:'{}'},...(scenario==='other-planned-call'?[{type:'tool-call',id:'other-unstarted',name:'other_tool',arguments:'{}'}]:[])]}},{surfaceOp:'append'});
  if(scenario!=='missing-execution')b.session.append('tool/call',{turn:1,step:1,callId:'g5-reply',name:'session_coordinator_send',arguments:'{}'});
  let conclusions=0;const reply=await h.tools.get('session_coordinator_send').execute({targets:['A'],content:'result',replyTo:first.results[0].messageId},{agent:b,callId:'g5-reply',...(scenario==='nested-call'?{rootCallId:'outer-code',parent:{}}:{}),signal:new AbortController().signal,concludeTurn(){conclusions++}});
  assert.equal(reply.results[0].admission,'accepted',scenario);assert.equal(conclusions,0,scenario);
 }
})
