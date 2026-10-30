// Explicit local host probe: runs installed rc.3 methods with scratch files, never a model/profile.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Session } from '@deepseek-ai/dsh-session'
import { prepareCollaborationMaterials, readNativeSessionReferences, verifyCollaborationArtifacts } from '../src/collaboration-materials.ts'
import { materialFilesystem } from './fixtures/material-filesystem.mjs'

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
    const path = join(dir, 'result.txt'); await writeFile(path, 'reviewable native artifact\n')
    const prepared = await prepareCollaborationMaterials(ctx, ctx, [{ kind: 'file', path }])
    assert.equal((await verifyCollaborationArtifacts(ctx, ctx, prepared.artifacts))[0].status, 'verified')
    const stored = attachments.fileHostPath(prepared.content[0].attachment)
    assert.equal(await readFile(stored, 'utf8'), 'reviewable native artifact\n')
    let nativeRead = ''; for await (const chunk of attachments.readFileStream(prepared.content[0].attachment)) nativeRead += Buffer.from(chunk)
    assert.equal(nativeRead, 'reviewable native artifact\n')
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
  } finally { await rm(dir, { recursive: true, force: true }) }
})
