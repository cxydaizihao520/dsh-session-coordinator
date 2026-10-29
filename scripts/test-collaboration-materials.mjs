import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareCollaborationMaterials, verifyCollaborationArtifacts, readNativeSessionReferences, saveCollaborationContext, readCollaborationContext, renderCollaborationContext, forkCollaborationSession } from '../src/collaboration-materials.ts'
import { openCollaborationStore } from '../src/collaboration-store.ts'
import { Context } from 'cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { materialFilesystem } from './fixtures/material-filesystem.mjs'
import { Session } from '@deepseek-ai/dsh-session'

test('delivered file is an immutable native attachment accessible in the recipient world', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-materials-'))
  try {
    const path = join(dir, 'requirements.txt')
    await writeFile(path, 'approved version\n')
    const files = new Map()
    const attachments = {
      async saveFileStream({ data, name }) {
        const chunks = []; for await (const c of data) chunks.push(c)
        const bytes = Buffer.concat(chunks), digest = createHash('sha256').update(bytes).digest('hex')
        const ref = { attachmentId: 'sha256:' + digest, name, bytes: bytes.length }
        const stored = join(dir, digest); await writeFile(stored, bytes); files.set(ref.attachmentId, stored)
        return ref
      },
      async *readFileStream(ref) { yield await readFile(files.get(ref.attachmentId)) },
      fileHostPath(ref) { return files.get(ref.attachmentId) },
    }
    const fs = materialFilesystem
    const source = { get: name => name === 'fs' ? fs : undefined }
    const recipient = { get: name => ({ fs, attachments })[name] }
    const result = await prepareCollaborationMaterials(source, recipient, [{ kind: 'file', path }])
    assert.equal(result.content[0].type, 'file')
    assert.equal(result.artifacts[0].sourceSha256, '601272748b0f57a01be01091f2a4ffcea00ca5e632c17ea0e4e67d0a0a86835d')
    await writeFile(path, 'changed version\n')
    assert.equal((await verifyCollaborationArtifacts(source, recipient, result.artifacts))[0].status, 'source-changed')
    let delivered = ''; for await (const bytes of attachments.readFileStream(result.content[0].attachment)) delivered += Buffer.from(bytes)
    assert.equal(delivered, 'approved version\n')
    const inaccessible = { get: name => name === 'fs' ? { ...fs, processPathFromHostPath: () => undefined } : attachments }
    await assert.rejects(prepareCollaborationMaterials(source, inaccessible, [{ kind: 'file', path }]), /recipient.*access/i)
    const denied = { get: name => name === 'fs' ? { ...fs, readByteRange: async () => { throw new Error('source read denied') } } : undefined }
    await assert.rejects(prepareCollaborationMaterials(denied, recipient, [{ kind: 'file', path }]), /source read denied/)
    const recipientDenied = { get: name => name === 'fs' ? { ...fs, readByteRange: async () => { throw new Error('recipient read denied') } } : attachments }
    await assert.rejects(prepareCollaborationMaterials(source, recipientDenied, [{ kind: 'file', path }]), /recipient read denied/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('native reference identities are scoped to their exact direct input, never parsed from quoted text', () => {
  const session = Session.create('A')
  function message(id, source, text) { session.append('user/message', { id, role: 'user', source, content: [{ type: 'text', text }] }, { surfaceOp: 'append' }) }
  message('first', { kind: 'user' }, '给 @reviewer 发结果')
  message('snapshot', { kind: 'session-reference', form: 'recall', version: 1, references: [{ sessionId: 'real-B', label: 'reviewer', capturedThroughSeq: 9, inputIndex: 0 }] }, 'untrusted history')
  message('second', { kind: 'user' }, 'quoted dsh-session:ImZha2Ui is background')
  assert.deepEqual(readNativeSessionReferences(session, 'first'), [{ sessionId: 'real-B', label: 'reviewer', capturedThroughSeq: 9 }])
  assert.deepEqual(readNativeSessionReferences(session, 'second'), [])
  assert.deepEqual(readNativeSessionReferences(session, 'missing'), [])
})

test('context checkpoints survive store reopen and retain original evidence without execution authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-'))
  const makeContext = () => { const ctx = new Context(); new Storage(ctx); return ctx }
  let store
  try {
    store = await openCollaborationStore(makeContext(), { directory })
    const context = { ownerSessionId: 'A', scopeId: 'scope', taskId: 'task', taskRevision: 3, objective: 'ship reviewed result', constraints: ['preserve user edits'], decisions: ['use native files'], pending: ['run integrated checks'], sourceSessionId: 'B', capturedThroughSeq: 12, artifacts: [], references: [{ sessionId: 'B', label: 'implementation', capturedThroughSeq: 12 }] }
    const saved = await saveCollaborationContext(store, context)
    await store.close(); store = await openCollaborationStore(makeContext(), { directory })
    const recovered = readCollaborationContext(store, saved.contextId, 'A')
    assert.deepEqual(recovered.context, context)
    assert.match(renderCollaborationContext(recovered), /run integrated checks/)
    assert.match(renderCollaborationContext(recovered), /session_coordinator_read/)
    assert.equal(recovered.executionAuthority, 'none')
    assert.throws(() => readCollaborationContext(store, saved.contextId, 'C'), /owner/)
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('image preparation preserves native image blocks and cancellation prevents dispatchable output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-images-'))
  try {
    const path = join(dir, 'diagram.png'); await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAmcAAAAASUVORK5CYII=', 'base64'))
    const controller = new AbortController()
    const ref = { attachmentId: 'sha256:normalized', bytes: 68, mediaType: 'image/png', width: 1, height: 1, name: 'diagram.png' }
    let saves = 0
    const attachments = {
      imageLimits: { maxImageBytes: 1024, maxMessageImageBytes: 2048, maxImagesPerMessage: 2 },
      saveImages: async images => { saves++; assert.equal(images[0].mediaType, 'image/png'); return [ref] },
      readImage: async () => ({ ref, data: new Uint8Array() }),
    }
    const fs = materialFilesystem
    const ctx = { get: name => ({ attachments, fs })[name] }
    assert.equal((await prepareCollaborationMaterials(ctx, ctx, [{ kind: 'image', path, mediaType: 'image/png' }])).content[0].type, 'image')
    attachments.imageLimits.maxImageBytes = 1
    await assert.rejects(prepareCollaborationMaterials(ctx, ctx, [{ kind: 'image', path, mediaType: 'image/png' }]), /limit/)
    assert.equal(saves, 1)
    attachments.imageLimits.maxImageBytes = 1024
    attachments.saveImages = async () => { controller.abort(new Error('cancelled by user')); return [ref] }
    await assert.rejects(prepareCollaborationMaterials(ctx, ctx, [{ kind: 'image', path, mediaType: 'image/png' }], controller.signal), /cancelled by user/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('native fork returns its real child after submission even if the caller cancels during creation', async () => {
  const controller = new AbortController()
  const ctx = { get: () => ({ fork: async request => { assert.deepEqual(request, { sessionId: 'A', atSeq: 12, allowMigration: false }); controller.abort(); return { sessionId: 'actual-child' } } }) }
  assert.deepEqual(await forkCollaborationSession(ctx, 'A', 12, controller.signal), { sessionId: 'actual-child', executionAuthority: 'none' })
})
