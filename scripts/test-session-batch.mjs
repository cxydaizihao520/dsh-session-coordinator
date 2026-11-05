import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fixture} from './fixtures/session-tools.mjs'

test('one frozen work permission admits a deduplicated group and member-to-member communication',async()=>{
 const h=fixture();h.human('A');h.make('C');const first=await h.run('send',{targets:['C','B','B'],content:'review together',requestId:'group-work-one',authorizationRequest:{participants:['A','B','C','A'],purpose:'implement and review',extent:'work'}});
 assert.equal(first.results.length,2);assert.ok(first.results.every(x=>x.admission==='accepted'));assert.equal(h.approvals.length,1);
 const direct=await h.run('send',{targets:['C'],content:'test feedback',context:{communicationHandle:first.communicationHandle}},'B');assert.equal(direct.results[0].admission,'accepted');assert.equal(h.approvals.length,1);
 assert.equal(h.effects.filter(e=>e[0]==='send'&&e[1]==='B').length,1);
})

test('partial results retry only known unsubmitted peers with the original complete request',async()=>{
 const h=fixture();h.human('A');h.make('C');let reject=true;h.setFlush(async s=>{if(s.id==='A'&&reject&&h.effects.some(e=>e[0]==='send'&&e[1]==='B'))throw Error('checkpoint unavailable');return true});
 const args={targets:['B','C'],content:'same original',requestId:'partial-group-one'};const first=await h.run('send',args);
 assert.deepEqual(first.results.map(x=>x.admission),['unknown','rejected']);reject=false;
 const again=await h.run('send',args);assert.deepEqual(again.results.map(x=>x.admission),['unknown','accepted']);assert.equal(h.effects.filter(e=>e[0]==='send'&&e[1]==='B').length,1);
 await assert.rejects(h.run('send',{...args,targets:['C']}),/REQUEST_CONFLICT/);
})

test('cancel keeps completed receipts and running-only selection never becomes a subscription',async()=>{
 const h=fixture();h.human('A');h.make('C');const controller=new AbortController();const steer=h.agents.get('B').steer.bind(h.agents.get('B'));h.agents.get('B').steer=m=>{steer(m);controller.abort()};
 const cancelled=await h.run('send',{targets:['B','C'],content:'deliver',requestId:'cancel-group-one'},'A',{signal:controller.signal});assert.deepEqual(cancelled.results.map(x=>x.admission),['accepted','rejected']);assert.equal(cancelled.results[1].error.code,'CANCELLED');assert.equal(h.effects.filter(e=>e[0]==='send').length,1);
 const g=fixture();g.human('A');g.agents.get('B').status='running';g.setAnswer(async()=>{g.agents.get('B').status='idle';return 'allowed-once'});const args={targets:['B'],content:'running snapshot',requireRunning:true,requestId:'running-group-one'};
 const skipped=await g.run('send',args);assert.equal(skipped.results[0].skipped,true);assert.equal(g.effects.filter(e=>e[0]==='send').length,0);g.agents.get('B').status='running';assert.deepEqual(await g.run('send',args),skipped);
})

test('a work result permits a separately approved extension, but no once-message escalation or stitched scopes',async()=>{
 const h=fixture();h.human('A');h.make('C');const work=await h.run('send',{targets:['B'],content:'review',authorizationRequest:{participants:['A','B'],purpose:'review',extent:'work'}});await h.run('send',{targets:['A'],content:'needs more help',context:{communicationHandle:work.communicationHandle}},'B');
 const extended=await h.run('send',{targets:['C'],content:'join review',authorizationRequest:{participants:['A','B','C'],purpose:'review',extent:'work'}});assert.equal(extended.results[0].admission,'accepted');assert.equal(h.approvals.length,2);assert.notEqual(work.communicationHandle,extended.communicationHandle);
 const denied=await h.run('send',{targets:['B','C'],content:'not in original set',context:{communicationHandle:work.communicationHandle}});assert.ok(denied.results.every(x=>x.admission==='rejected'));
 const g=fixture();g.human('A');g.make('C');await g.run('send',{targets:['B'],content:'one task',authorizationRequest:{participants:['A','B'],purpose:'one task',extent:'message',reply:'once'}});const upgrade=await g.run('send',{targets:['C'],content:'expand',authorizationRequest:{participants:['B','C'],purpose:'expand',extent:'work'}},'B');assert.equal(upgrade.results[0].admission,'rejected');assert.equal(g.approvals.length,1);
})

test('reload cannot change a group request identity into a different member set',async()=>{
 const h=fixture();h.human('A');h.make('C');h.make('D');const args={targets:['B','C'],content:'fixed group',requestId:'fixed-group-reload'};await h.run('send',args);h.reload();await assert.rejects(h.run('send',{...args,targets:['B','D']}),/REQUEST_CONFLICT/);assert.equal(h.effects.filter(e=>e[0]==='send'&&e[1]==='D').length,0);
})
