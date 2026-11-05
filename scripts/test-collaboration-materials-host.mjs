// Installed-host method probes with scratch files and a controlled compaction summary, never a model/profile.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {unlinkSync} from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Session, SessionSeq, SessionLogOffset, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { forkCollaborationSession, prepareCollaborationMaterials, readNativeSessionReferences, verifyCollaborationArtifacts } from '../src/collaboration-materials.ts'
import { prepareSessionContent } from '../src/session-content.ts'
import { materialFilesystem } from './fixtures/material-filesystem.mjs'
import { fixture } from './fixtures/session-tools.mjs'
import { tasksFixture } from './fixtures/session-tasks.mjs'
import {registerCollaborationMaterialTools} from '../src/collaboration-material-tools.ts'

const host = path => execFileSync(process.execPath, ['tools/asar.mjs', 'cat', `/dsh/node_modules/@deepseek-ai/${path}`], { encoding: 'utf8' })
const moduleDir = await mkdtemp(join(tmpdir(), 'dsh-native-modules-'))
after(() => rm(moduleDir, { recursive: true, force: true }))
let moduleIndex = 0
const load = async source => { const path = join(moduleDir, `native-${moduleIndex++}.mjs`); await writeFile(path, source); return import(pathToFileURL(path).href) }
function region(source, name) {
  const start = source.indexOf(`//#region lib/types/${name}.js`)
  assert.ok(start >= 0, `native region ${name} is available`)
  return source.slice(start, source.indexOf('//#endregion', start))
}

test('installed controller forks the exact inclusive prefix without starting an agent', async () => {
  const source = host('dsh-api-session-controller/lib/types/commands.js')
  const repair = host('dsh-session/lib/types/repair.js')
    .replace("'@deepseek-ai/dsh-brand'",JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-brand')))
    .replace("'@deepseek-ai/dsh-util-values'",JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-util-values')))
    .replace('"./types.js"',JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-session')))
  const {buildForkSeed} = await load(repair+'\n'+host('dsh-session/lib/types/fork.js').replace(/^import .*;\n/gm,''))
  const start = source.indexOf('    async fork(request) {'), end = source.indexOf('    /**\n     * Admit one prompt', start)
  assert.ok(start >= 0 && end > start)
  const nativeFork = new Function('SessionSeq','SessionLogOffset','buildForkSeed','brandString','randomUUID','RemoteError','SessionQueryError',
    source.slice(0,source.indexOf('import ')) + '\nreturn ' + source.slice(start,end).trim().replace(/^async fork\(/,'async function fork('))(
      SessionSeq,SessionLogOffset,buildForkSeed,value=>value,randomUUID,Error,Error)
  const session = Session.create('fork-source')
  session.append('turn/start',{turn:1})
  const before = session.append('user/message',{id:'before',role:'user',source:{kind:'user'},content:[{type:'text',text:'before-cut sentinel'}]},{surfaceOp:'append'})
  session.append('user/message',{id:'after',role:'user',source:{kind:'user'},content:[{type:'text',text:'after-cut sentinel'}]},{surfaceOp:'append'})
  session.append('turn/end',{turn:1,reason:{kind:'completed'}})
  let created, observedDisposals = 0, calls = 0
  const command = {
    ctx:{sessionQuery:{observeSession:async()=>({header:session.header,events:session.snapshotEvents(),[Symbol.dispose](){observedDisposals++}})},
      agentDefaultModel:{currentSelection:()=>({provider:'selected',model:'model'})},
      agents:{create:async options=>{created=options}}},
    agents:{presetForObservation:()=>undefined,composeAgent:async()=>({})},forkWorkspace:async()=>undefined,
  }
  const ctx = {get:name=>name==='sessionController'?{fork:async request=>{calls++;return nativeFork.call(command,request)}}:undefined}
  const result = await forkCollaborationSession(ctx,session.id,before.seq)
  assert.equal(result.executionAuthority,'none');assert.equal(result.sessionId,created.sessionId)
  assert.equal(created.inheritedEventCount,before.seq+1);assert.equal(created.meta.parentSession,session.id)
  const child = Session.create(created.sessionId,created.seed,{...session.header,id:created.sessionId,isSeeded:true},created.inheritedEventCount)
  const childText = child.snapshotEvents().filter(e=>e.type==='user/message').flatMap(e=>e.data.content).map(p=>p.text??'').join('\n')
  assert.match(childText,/before-cut sentinel/);assert.doesNotMatch(childText,/after-cut sentinel/)
  assert.equal(child.snapshotEvents().filter(e=>e.type==='turn/start'&&child.isOwnSeq(e.seq)).length,0)
  assert.equal(observedDisposals,1)
  const abort = new AbortController();abort.abort(new Error('cancel fork before submit'))
  await assert.rejects(forkCollaborationSession(ctx,session.id,before.seq,abort.signal),/cancel fork/)
  assert.equal(calls,1)
})

test('installed compaction transaction replaces the surface and retains original audit evidence', async () => {
  const native = host('dsh-compaction-basic/lib/index.js')
  const pairing = await load(host('dsh-compaction/lib/types/tool-pairing.js'))
  const checkpoint = await load(host('dsh-compaction/lib/types/checkpoint.js'))
  const contract = host('dsh-compaction/lib/types/index.js')
  const errorClass = contract.slice(contract.indexOf('export class ManualCompactionError'),contract.indexOf('/**\n * Abstract compaction'))
  const ManualCompactionError = new Function(errorClass.replace('export class','class')+'\nreturn ManualCompactionError')()
  const compact = new Function('createUserMessage','errorChain','SessionSeq','randomUUID','isDeepStrictEqual','ManualCompactionError','CompactionId','compactCheckpointSource','toolPairingBalancedBefore','toolPairingBalancedAfter',
    region(native,'summarizer')+'\n'+region(native,'region')+'\nreturn compactSurfaceRegion')(
      createUserMessage,errorChain,SessionSeq,randomUUID,isDeepStrictEqual,ManualCompactionError,value=>value,checkpoint.compactCheckpointSource,pairing.toolPairingBalancedBefore,pairing.toolPairingBalancedAfter)
  const session = Session.create('compact-source')
  const original = session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Keep the review constraint. '+ 'old detailed evidence '.repeat(200)}]}),{surfaceOp:'append'})
  const tail = session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Continue only the remaining work.'}]}),{surfaceOp:'append'})
  let replay, flushes=0
  const dependencies = {meter:{measure:s=>({nodes:s.surface.nodes.map(seq=>({seq,tokens:1000,heuristicTokens:1000}))}),estimateMessage:()=>100},
    summarize:async input=>{replay=input;return {summary:[{type:'text',text:'Keep the review constraint.'}],provider:'probe',model:'controlled-summary'}},recover:()=>false}
  const result = await compact(dependencies,session,original.seq,original.seq,{session},{owner:null,stability:'selected-span',flush:async()=>{flushes++}},new AbortController().signal)
  assert.equal(flushes,1);assert.deepEqual(result.shadowedSeqs,[original.seq])
  assert.match(replay.messages[0].content[0].text,/old detailed evidence/)
  assert.ok(!session.surface.nodes.includes(original.seq));assert.ok(session.surface.nodes.includes(tail.seq))
  assert.equal(session.eventAt(original.seq),original)
  const events=session.snapshotEvents(),summary=events.find(e=>e.type==='user/message'&&e.data.source.kind==='compact-checkpoint')
  assert.ok(summary);assert.match(summary.data.content.map(p=>p.text??'').join('\n'),/Keep the review constraint/)
  assert.deepEqual(events.filter(e=>e.type.startsWith('compaction/')).map(e=>e.type),['compaction/start','compaction/summary','compaction/end'])
  const stop=new AbortController();stop.abort(new Error('cancel before compaction'))
  const count=events.length
  await assert.rejects(compact(dependencies,session,tail.seq,tail.seq,{session},{owner:null,stability:'selected-span'},stop.signal),/cancel before/)
  assert.equal(session.snapshotEvents().length,count)
})

test('installed native attachment store durably delivers exact files and refuses corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-materials-'))
  try {
    const nativeSource = host('dsh-attachment-local/lib/index.js')
    const native = await load(`
      import { dirname, join, parse, resolve } from 'node:path';
      import { createHash, randomUUID } from 'node:crypto';
      import { constants, createReadStream } from 'node:fs';
      import { chmod, link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
      class AttachmentError extends Error { constructor(message, code, options) { super(message, options); this.code = code } }
      const AttachmentId = value => value;
      ${region(nativeSource, 'store')}
      ${region(nativeSource, 'file-store')}
      export { saveFileStreamVerbatim, readFileStreamVerbatim, storedFilePath };
    `)
    const root = join(dir, 'attachments', 'v1')
    const attachments = {
      saveFileStream: input => native.saveFileStreamVerbatim(root, input),
      readFileStream: (ref, signal) => native.readFileStreamVerbatim(root, ref, signal),
      fileHostPath: ref => native.storedFilePath(root, ref),
    }
    const fs = materialFilesystem
    const ctx = { get: name => ({ attachments, fs })[name] }
    const missingPath=join(dir,'partial-material.txt'),group=fixture()
    group.make('C');group.human('A');for(const peer of group.agents.values())peer.ctx=ctx
    await writeFile(missingPath,'original remaining material\n')
    const receive=group.agents.get('B').steer.bind(group.agents.get('B'))
    group.agents.get('B').steer=message=>{receive(message);unlinkSync(missingPath)}
    const missingRequest={targets:['B','C'],content:[{type:'file',path:missingPath}],requestId:'missing-material-original'}
    const partial=await group.run('send',missingRequest)
    assert.deepEqual(partial.results.map(result=>result.admission),['accepted','rejected'])
    assert.match(partial.results[1].error.message,/ENOENT|no such file|not found/i)
    await writeFile(missingPath,'original remaining material\n')
    const remaining=await group.run('send',missingRequest)
    assert.deepEqual(remaining.results.map(result=>result.admission),['accepted','accepted'])
    assert.deepEqual(remaining.results.map(result=>result.messageId),partial.results.map(result=>result.messageId))
    assert.equal(group.effects.filter(effect=>effect[0]==='send'&&effect[1]==='B').length,1)
    assert.equal(group.effects.filter(effect=>effect[0]==='send'&&effect[1]==='C').length,1)
    assert.equal(partial.results[1].admission,'rejected','the original failure remains available')
    const path = join(dir, 'result.txt'); await writeFile(path, 'reviewable native artifact\n')
    const prepared = await prepareCollaborationMaterials(ctx, ctx, [{ kind: 'file', path }])
    assert.equal((await verifyCollaborationArtifacts(ctx, ctx, prepared.artifacts))[0].status, 'verified')
    const stored = attachments.fileHostPath(prepared.content[0].attachment)
    assert.equal(await readFile(stored, 'utf8'), 'reviewable native artifact\n')
    let nativeRead = ''; for await (const chunk of attachments.readFileStream(prepared.content[0].attachment)) nativeRead += Buffer.from(chunk)
    assert.equal(nativeRead, 'reviewable native artifact\n')
    const agent={id:'file-target',session:Session.create('file-target'),options:{},ctx}
    const message=await prepareSessionContent(agent,agent,[{type:'text',text:'review\n'},{type:'file',path},{type:'text',text:'  end'}])
    assert.deepEqual(message.content.map(part=>part.type),['text','file','text'])
    const deferred=await tasksFixture();for(const peer of deferred.agents.values())peer.ctx=ctx
    try {
      const task=await deferred.run('task',{communicationHandle:deferred.communicationHandle,objective:'review deferred material',members:['B'],requestId:'deferred-native-material-task'})
      await deferred.run('schedule',{taskHandle:task.taskHandle,sessionId:'B',message:'  review this file\n',notBefore:0,operationId:'deferred-native-material',materials:[{kind:'file',path}]})
      const delivered=deferred.effects.filter(row=>row[0]==='send').at(-1)[2]
      assert.deepEqual(delivered.content.map(part=>part.type),['text','file'])
      assert.equal(delivered.content[0].text,'  review this file\n')
      assert.equal(await readFile(attachments.fileHostPath(delivered.content[1].attachment),'utf8'),'reviewable native artifact\n')
      assert.equal(delivered.source.contentSnapshot.artifacts.length,1)
    } finally { await (await deferred.env.collaboration).close() }
    const h=fixture();h.human('A');for(const peer of h.agents.values())peer.ctx=ctx
    const request={requestId:'native-file-retry-01',targets:['B'],content:[{type:'text',text:'review\n'},{type:'file',path}]}
    let fail=true,saves=0;const save=attachments.saveFileStream
    attachments.saveFileStream=input=>{saves++;return save(input)}
    h.setFlush(async session=>{if(fail&&session.id==='A'&&session.snapshotEvents().some(e=>pluginRecordOf(e)?.data?.stage==='intent')){fail=false;throw Error('intent flush interrupted')}return true})
    assert.equal((await h.run('send',request)).results[0].admission,'rejected')
    assert.equal(h.effects.filter(e=>e[0]==='send').length,0)
    await writeFile(path,'new version requires new review\n')
    const retried=await h.run('send',request);assert.equal(retried.results[0].admission,'accepted',JSON.stringify(retried));assert.equal(saves,1)
    const delivered=h.effects.find(e=>e[0]==='send')[2]
    assert.equal(await readFile(attachments.fileHostPath(delivered.content[1].attachment),'utf8'),'reviewable native artifact\n')
    const status=await h.run('status',{sessionId:'B'});assert.equal(status.materials[0].artifacts[0].status,'source-changed')
    const b=h.agents.get('B');b.followup=m=>b.inbox.nextTurn.push(m)
    b.inbox.replace=(id,message)=>{const index=b.inbox.nextTurn.findIndex(m=>m.id===id);if(index<0)return false;b.inbox.nextTurn.splice(index,1,message);return true}
    const editRequest={requestId:'native-file-edit-send',targets:['B'],delivery:'queue',content:[{type:'file',path}]}
    const editSent=await h.run('send',editRequest),editId=editSent.results[0].messageId,oldFile=b.inbox.nextTurn[0].content[0].attachment
    const editResult=await h.run('control',{object:'message',action:'edit',messageId:editId,expectedRevision:1,content:'replacement text',requestId:'native-file-edit-control'})
    assert.equal(editResult.outcome,'edited');assert.equal(b.inbox.nextTurn[0].source.contentSnapshot,undefined)
    assert.deepEqual(b.inbox.nextTurn[0].content,[{type:'text',text:'replacement text'}]);assert.deepEqual(await h.run('send',editRequest),editSent)
    assert.equal(editSent.results[0].artifacts.length,1);assert.equal(await readFile(attachments.fileHostPath(oldFile),'utf8'),'new version requires new review\n')
    assert.equal((await h.run('status',{sessionId:'B'})).materials.some(row=>row.messageId===editId),false)
    h.reload();assert.equal((await h.run('status',{sessionId:'B'})).materials[0].artifacts[0].status,'source-changed')
    assert.equal((await verifyCollaborationArtifacts(ctx,ctx,message.artifacts))[0].status,'source-changed')
    assert.equal(await readFile(attachments.fileHostPath(message.content[1].attachment),'utf8'),'reviewable native artifact\n')
    // The same registered task/finish consumer verifies the current version,
    // while native attachment storage and historical send receipts stay immutable.
    for(const scenario of ['request-file','reply-file','edited-to-text']) {
      const taskHarness=await tasksFixture();for(const peer of taskHarness.agents.values())peer.ctx=ctx
      registerCollaborationMaterialTools(taskHarness.env,taskHarness.env.collaboration)
      const material=args=>taskHarness.tools.get('session_coordinator_collaboration_material').execute(args,{agent:taskHarness.agents.get('A'),callId:'material-'+scenario,signal:new AbortController().signal})
      const task=await taskHarness.run('task',{communicationHandle:taskHarness.communicationHandle,objective:'review current shipping evidence',members:['B'],requestId:'material-task-'+scenario})
      const taskPath=join(dir,scenario+'.txt');await writeFile(taskPath,'approved evidence '+scenario)
      const taskContext={communicationHandle:taskHarness.communicationHandle,taskHandle:task.taskHandle},target=taskHarness.agents.get('B')
      target.followup=message=>target.inbox.nextTurn.push(message)
      target.inbox.replace=(id,message)=>{const index=target.inbox.nextTurn.findIndex(row=>row.id===id);if(index<0)return false;target.inbox.nextTurn.splice(index,1,message);return true}
      const content=[{type:'text',text:'review current evidence'},{type:'file',path:taskPath}]
      const sentArgs={requestId:'material-send-'+scenario,targets:['B'],context:taskContext,...(scenario==='edited-to-text'?{delivery:'queue'}:{}),content:scenario==='reply-file'?'produce shipping evidence':content}
      const taskSent=await taskHarness.run('send',sentArgs);assert.equal(taskSent.results[0].admission,'accepted',JSON.stringify(taskSent))
      if(scenario==='edited-to-text') {
        await writeFile(taskPath,'changed source must not remain required after replacement')
        let edited
        const stat=materialFilesystem.stat,canonical=await realpath(taskPath)
        materialFilesystem.stat=async(...args)=>{if(!edited&&args[0]===canonical)edited=await taskHarness.run('control',{object:'message',action:'edit',messageId:taskSent.results[0].messageId,expectedRevision:1,content:'approved text replaces the file requirement',requestId:'material-task-edit'});return stat(...args)}
        try {await assert.rejects(material({taskHandle:task.taskHandle,action:'verify',operationId:taskSent.results[0].messageId}),/changed during verification/)}finally{materialFilesystem.stat=stat}
        assert.equal(edited.outcome,'edited',JSON.stringify(edited))
        target.session.append('user/message',target.inbox.nextTurn.shift(),{surfaceOp:'append'})
      }
      const replied=await taskHarness.run('send',{requestId:'material-reply-'+scenario,targets:['A'],context:taskContext,replyTo:taskSent.results[0].messageId,content:scenario==='reply-file'?content:'review finished'},'B')
      assert.equal(replied.results[0].admission,'accepted',JSON.stringify(replied))
      const operationId=scenario==='reply-file'?replied.results[0].messageId:taskSent.results[0].messageId
      const verify={taskHandle:task.taskHandle,action:'verify',operationId}
      if(scenario==='edited-to-text')await assert.rejects(material(verify),/no.*artifact/)
      else assert.equal((await material(verify)).artifacts[0].status,'verified','new task verify reads the actual v2 wire snapshot')
      const checkpoint=await material({taskHandle:task.taskHandle,action:'checkpoint',requestId:'current-checkpoint-'+scenario})
      const checkpointRead=await material({taskHandle:task.taskHandle,action:'read-context',contextId:checkpoint.contextId})
      assert.equal(checkpointRead.checkpoint.context.artifacts.length,scenario==='edited-to-text'?0:1,'checkpoint follows current wire, never removed receipt artifacts')
      if(scenario!=='edited-to-text')await writeFile(taskPath,'changed after the actual delivered snapshot')
      const finished=await taskHarness.run('control',{object:'task',action:'finish',taskHandle:task.taskHandle,expectedRevision:1,reason:'accept actual reply evidence',evidenceRefs:[replied.results[0].messageId],requestId:'material-finish-'+scenario})
      if(scenario!=='edited-to-text'){assert.equal(finished.outcome,'rejected',scenario+': current material version must be verified');assert.match(finished.error.message,/artifact version changed/)}
      else {
        assert.equal(finished.state,'completed',JSON.stringify(finished))
        assert.deepEqual(await taskHarness.run('send',sentArgs),taskSent,'original request retry remains the original receipt')
        const status=await taskHarness.run('status',{taskHandle:task.taskHandle}),operation=status.operations.find(row=>row.id===taskSent.results[0].messageId)
        assert.equal(operation.wire.source.contentSnapshot,undefined)
        assert.equal(operation.wireHistory[0].source.contentSnapshot.artifacts.length,1)
        const artifact=operation.wireHistory[0].content.find(part=>part.type==='file').attachment
        assert.equal(await readFile(attachments.fileHostPath(artifact),'utf8'),'approved evidence '+scenario)
        const visible=await taskHarness.run('read',{sessionId:'B'}),message=visible.messages.find(row=>row.messageId===taskSent.results[0].messageId)
        assert.equal(message.text,'approved text replaces the file requirement')
      }
    }
    const { chmod } = await import('node:fs/promises'); await chmod(stored, 0o600); await writeFile(stored, 'corrupt')
    assert.equal((await verifyCollaborationArtifacts(ctx, ctx, prepared.artifacts))[0].status, 'unavailable')
    await assert.rejects(async () => { for await (const _chunk of attachments.readFileStream(prepared.content[0].attachment)) {} }, /integrity/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('installed native mention preparation exposes true identity and readable context without changing @ serialization', async () => {
  let source = host('dsh-session-reference/lib/index.js')
  const retention = host('dsh-output-retention/lib/index.js').replace(/^export \{.*\};?$/m, '')
  // Only service/decorator/compaction imports are adapted; URI/projection/pre-step methods are unmodified.
  source = source.replace(/^import .*;\n/gm, '')
  const native = await load(`
    import z from ${JSON.stringify(import.meta.resolve('@deepseek-ai/schemastery'))};
    import { LlmError, createUserMessage, freezeMessage } from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-llm'))};
    import { SessionSeq } from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-session'))};
    const Remote = () => value => value;
    class TypertRemoteService { constructor(ctx) { this.ctx = ctx } }
    const brandString = value => value;
    const isCompactCheckpointSource = () => false;
    const assertNever = () => { throw new Error('Unexpected surface event') };
    ${retention}
    ${source}
  `)
  const events = [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'prior decision' }] } }]
  const ctx = { on() {}, get() {}, sessionQuery: { readSurface: async id => ({ session: { id, cwd: '/project', version: 4 }, capturedThroughSeq: 0, events }) } }
  const resolver = new native.SessionReferenceResolver(ctx, { maxReferenceBytes: 65536 })
  const session = Session.create('A')
  const agent = {id:'A',session,options:{},ctx:{get:name=>name==='sessionReferenceResolver'?resolver:undefined}}
  const prepared = await prepareSessionContent(agent,agent,[{type:'text',text:'  review this\n'},{type:'reference',sessionId:'real-B',label:'reviewer'}])
  assert.deepEqual(prepared.content,[{type:'text',text:'  review this\n'}])
  assert.equal(prepared.referenceContext.source.kind,'session-reference')
  assert.equal(prepared.referenceContext.source.references[0].capturedThroughSeq,0)
  assert.match(prepared.referenceContext.content[0].text,/prior decision/)
  const mention = native.formatSessionReferenceMention({ sessionId: 'real-B', label: 'reviewer' })
  const messages = await resolver.prepareDirectMessages({ id: 'A', session: { id: 'A' }, options: {} }, [{ id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `给 ${mention} 发送结论` }] }])
  assert.equal(messages[0].content[0].text, '给 @reviewer 发送结论')
  assert.match(messages[1].content[0].text, /"sessionId":"real-B"/)
  for (const message of messages) session.append('user/message', message, { surfaceOp: 'append' })
  assert.deepEqual(readNativeSessionReferences(session, 'input'), [{ sessionId: 'real-B', label: 'reviewer', capturedThroughSeq: 0 }])
})

test('installed image normalization produces a model-readable native image attachment', async () => {
  const nativeSource = host('dsh-attachment-local/lib/index.js')
  const index = JSON.parse(await readFile(new URL('../tools/.cache/asar-index.json', import.meta.url), 'utf8'))
  const packages = ['sharp/', '@img/colour/', 'semver/', 'detect-libc/', `@img/sharp-${process.platform}-${process.arch}/`, `@img/sharp-libvips-${process.platform}-${process.arch}/`]
  const selected = index.files.map(([path]) => path).filter(path => packages.some(pkg => path.startsWith('/dsh/node_modules/' + pkg)))
  const nativePaths = selected.filter(path => /\.(node|dylib|so)$/u.test(path))
  execFileSync(process.execPath, ['tools/asar.mjs', 'extract', ...selected.filter(path => !nativePaths.includes(path)), '--out', moduleDir], { stdio: 'ignore' })
  for (const path of nativePaths) {
    const target = join(moduleDir, path)
    await mkdir(dirname(target), { recursive: true })
    await symlink(index.asarPath + '.unpacked' + path, target)
  }
  const require = createRequire(join(moduleDir, 'dsh', 'node_modules', 'sharp', 'package.json'))
  const sharpPath = require.resolve('sharp')
  const native = await load(`
    import { dirname, join, parse, resolve } from 'node:path';
    import { createHash, randomUUID } from 'node:crypto';
    import { constants, createReadStream } from 'node:fs';
    import { chmod, link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    class AttachmentError extends Error { constructor(message, code, options) { super(message, options); this.code = code } }
    const AttachmentId = value => value;
    const requireSharp = () => createRequire(import.meta.url)(${JSON.stringify(sharpPath)});
    ${region(nativeSource, 'encoding')}
    ${region(nativeSource, 'image')}
    ${region(nativeSource, 'normalization')}
    ${region(nativeSource, 'store')}
    export { prepareImageFile, commitPreparedImageFile, readImageFile };
  `)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-image-'))
  try {
    const path = join(dir, 'diagram.png')
    const png = await require('sharp')({ create: { width: 4, height: 3, channels: 3, background: '#247' } }).png().toBuffer()
    await writeFile(path, png)
    const root = join(dir, 'attachments', 'v1')
    const limits = { maxImageBytes: 1024 * 1024, maxImagesPerMessage: 3, maxMessageImageBytes: 1024 * 1024, maxImagePixels: 64e6, maxImageDimension: 8192, mediaTypes: ['image/png'] }
    const policy = { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 }
    const attachments = { imageLimits: limits,
      saveImages: async inputs => { const prepared = await Promise.all(inputs.map(input => native.prepareImageFile(input, limits, policy))); return Promise.all(prepared.map(image => native.commitPreparedImageFile(root, image))) },
      readImage: (ref, signal) => native.readImageFile(root, ref, signal),
    }
    const fs = materialFilesystem
    const ctx = { get: name => ({ attachments, fs })[name] }
    const result = await prepareCollaborationMaterials(ctx, ctx, [{ kind: 'image', path, mediaType: 'image/png' }])
    assert.equal(result.content[0].type, 'image')
    assert.equal(result.content[0].attachment.width, 4); assert.equal(result.content[0].attachment.height, 3)
    assert.equal((await verifyCollaborationArtifacts(ctx, ctx, result.artifacts))[0].status, 'verified')
    const services = {attachments,fs,llm:{resolveModelInfo:async()=>({inputModalities:['text','image']})}}
    const agent={id:'image-target',session:Session.create('image-target'),options:{provider:'selected',model:'vision'},ctx:{get:name=>services[name]}}
    const content=[{type:'text',text:'  inspect\n'},{type:'image',path,mediaType:'image/png'},{type:'text',text:'tail'}]
    const message=await prepareSessionContent(agent,agent,content)
    assert.deepEqual(message.content.map(part=>part.type),['text','image','text'])
    assert.equal(message.content[0].text,'  inspect\n');assert.equal(message.content[2].text,'tail')
    assert.equal(message.content[1].attachment.width,4)
    const saveImages=attachments.saveImages
    attachments.saveImages=async inputs=>{const refs=await saveImages(inputs);agent.options.model='text-only';return refs}
    await assert.rejects(prepareSessionContent(agent,agent,content),/model changed/)
    attachments.saveImages=saveImages
    const h=fixture();h.human('A');for(const peer of h.agents.values()){peer.ctx=agent.ctx;peer.options={provider:'selected',model:'vision'}}
    let change=true
    h.setFlush(async session=>{if(change&&session.id==='A'&&session.snapshotEvents().some(e=>pluginRecordOf(e)?.data?.stage==='intent')){change=false;h.agents.get('B').options.model='text-only'}return true})
    const request={targets:['B'],requestId:'native-image-model-race',content}
    const refused=await h.run('send',request);assert.equal(refused.results[0].admission,'rejected');assert.match(refused.results[0].error.message,/model changed/)
    assert.equal(h.effects.filter(e=>e[0]==='send').length,0)
    h.agents.get('B').options.model='vision'
    const accepted=await h.run('send',request);assert.equal(accepted.results[0].admission,'accepted',JSON.stringify(accepted))
    assert.equal(h.effects.find(e=>e[0]==='send')[2].content[1].type,'image')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
