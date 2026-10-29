import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CollaborationStore, JsonValue } from './collaboration-store.ts'

type FileRef = Extract<ContentBlock, { type: 'file' }>['attachment']
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']
type ImageMediaType = ImageRef['mediaType']

/** Public host service faces, deliberately limited to the capabilities used here. */
export interface MaterialContext { get(name: string): unknown }
interface MaterialFilesystem {
  processPathFromHostPath(path: string): string | undefined
  resolve(path: string, options: { signal?: AbortSignal }): Promise<unknown>
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number; version: string } | undefined>
  readByteRange(target: unknown, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}
interface MaterialFile { fs: MaterialFilesystem; target: unknown; path: string }
interface MaterialAttachments {
  imageLimits: { maxImageBytes: number; maxMessageImageBytes: number; maxImagesPerMessage: number }
  saveFileStream(input: { data: AsyncIterable<Uint8Array>; name: string; signal?: AbortSignal }): Promise<FileRef>
  saveImages(inputs: { data: Uint8Array; name: string; mediaType: ImageMediaType }[]): Promise<ImageRef[]>
  readImage(ref: ImageRef, signal?: AbortSignal): Promise<{ ref: ImageRef; data: Uint8Array }>
  fileHostPath(ref: FileRef): string | undefined
}

export interface CollaborationMaterialInput {
  kind: 'file' | 'image'
  /** Explicit absolute host path; both execution worlds must verify their mapping. */
  path: string
  mediaType?: ImageMediaType
}
export interface CollaborationArtifact {
  sourcePath: string
  sourceSha256: string
  sourceBytes: number
  block: Extract<ContentBlock, { type: 'file' | 'image' }>
}
export interface ArtifactVerification {
  artifact: CollaborationArtifact
  status: 'verified' | 'source-changed' | 'unavailable'
  reason?: string
}

export interface NativeSessionReference {
  sessionId: string
  label: string
  capturedThroughSeq: number | null
}

/** Identity is read from the host-created context paired with this input, never its text. */
export function readNativeSessionReferences(session: Pick<Session, 'snapshotEvents'>, inputMessageId: string): NativeSessionReference[] {
  const events = session.snapshotEvents()
  const index = events.findIndex(event => event.type === 'user/message' && event.data.id === inputMessageId && event.data.source.kind === 'user')
  if (index < 0) return []
  const result: NativeSessionReference[] = []
  for (const event of events.slice(index + 1)) {
    if (event.type !== 'user/message') continue
    const source = event.data.source as unknown as Record<string, unknown>
    if (source.kind !== 'session-reference') break
    if (source.form !== 'recall' || source.version !== 1 || !Array.isArray(source.references)) throw new Error('Invalid native session reference context')
    for (const item of source.references as unknown[]) {
      if (typeof item !== 'object' || item === null) throw new Error('Invalid native session reference identity')
      const ref = item as Record<string, unknown>
      if (typeof ref.sessionId !== 'string' || ref.sessionId === '' || typeof ref.label !== 'string' || ref.capturedThroughSeq !== null && (!Number.isSafeInteger(ref.capturedThroughSeq) || (ref.capturedThroughSeq as number) < 0)) throw new Error('Invalid native session reference identity')
      if (!result.some(known => known.sessionId === ref.sessionId)) result.push({ sessionId: ref.sessionId, label: ref.label, capturedThroughSeq: ref.capturedThroughSeq as number | null })
    }
  }
  return result
}

export interface CollaborationContext {
  ownerSessionId: string
  scopeId: string
  taskId: string
  taskRevision: number
  objective: string
  constraints: string[]
  decisions: string[]
  pending: string[]
  sourceSessionId: string
  capturedThroughSeq: number | null
  artifacts: CollaborationArtifact[]
  references: NativeSessionReference[]
}
export interface CollaborationContextCheckpoint {
  contextId: string
  context: CollaborationContext
  previousContextId?: string
  executionAuthority: 'none'
}

function validateContext(context: CollaborationContext): void {
  if (['ownerSessionId', 'scopeId', 'taskId', 'objective', 'sourceSessionId'].some(key => typeof context[key as keyof CollaborationContext] !== 'string' || context[key as keyof CollaborationContext] === '')) throw new Error('Context requires an owner, task, objective and source identity')
  if (!Number.isSafeInteger(context.taskRevision) || context.taskRevision < 1 || context.capturedThroughSeq !== null && (!Number.isSafeInteger(context.capturedThroughSeq) || context.capturedThroughSeq < 0)) throw new Error('Invalid context revision or source boundary')
  for (const items of [context.constraints, context.decisions, context.pending]) if (!Array.isArray(items) || !items.every(item => typeof item === 'string')) throw new Error('Context summary sections must contain text')
  if (!Array.isArray(context.artifacts) || !Array.isArray(context.references)) throw new Error('Context requires explicit artifacts and references')
}

/** Immutable, durable evidence checkpoint. It contains no grants, scheduled actions or executable goal. */
export async function saveCollaborationContext(store: CollaborationStore, context: CollaborationContext, previousContextId?: string): Promise<CollaborationContextCheckpoint> {
  validateContext(context)
  if (previousContextId !== undefined) {
    const previous = readCollaborationContext(store, previousContextId, context.ownerSessionId)
    if (previous.context.scopeId !== context.scopeId || previous.context.taskId !== context.taskId || previous.context.taskRevision > context.taskRevision) throw new Error('Context lineage must remain in the same task and cannot reverse its objective revision')
  }
  const checkpoint: CollaborationContextCheckpoint = { contextId: `context:${randomUUID()}`, context: structuredClone(context), ...(previousContextId === undefined ? {} : { previousContextId }), executionAuthority: 'none' }
  await store.create({ id: checkpoint.contextId, owner: context.ownerSessionId, revision: 1, data: { kind: 'collaboration-context', version: 1, checkpoint: checkpoint as unknown as JsonValue } })
  return checkpoint
}

/** Context access uses its recorded owner; task participation/communication is checked separately. */
export function readCollaborationContext(store: CollaborationStore, contextId: string, ownerSessionId: string): CollaborationContextCheckpoint {
  const record = store.get(contextId)
  if (record === undefined || record.data.kind !== 'collaboration-context' || record.data.version !== 1) throw new Error('Context checkpoint is unavailable')
  if (record.owner !== ownerSessionId) throw new Error('Only the context owner may recover this checkpoint')
  const checkpoint = record.data.checkpoint as unknown as CollaborationContextCheckpoint
  if (checkpoint.contextId !== contextId || checkpoint.executionAuthority !== 'none' || checkpoint.context.ownerSessionId !== ownerSessionId) throw new Error('Context checkpoint identity is invalid')
  validateContext(checkpoint.context)
  return structuredClone(checkpoint)
}

/** The checkpoint id and exact source boundaries remain readable after model context compaction. */
export function renderCollaborationContext(checkpoint: CollaborationContextCheckpoint): string {
  validateContext(checkpoint.context)
  const context = checkpoint.context
  return [
    `Collaboration context ${checkpoint.contextId}; task ${context.taskId}, objective revision ${context.taskRevision}.`,
    'This read-only checkpoint does not authorize execution or restore a running goal. Recheck current task state before acting.',
    JSON.stringify({ objective: context.objective, constraints: context.constraints, decisions: context.decisions, pending: context.pending, artifacts: context.artifacts, references: context.references }),
    `Original evidence: session_coordinator_read(sessionId=${JSON.stringify(context.sourceSessionId)}) through event ${String(context.capturedThroughSeq)}.`,
  ].join('\n')
}

/** Use the native cold-readable fork lifecycle; never copy collaboration authority or start a model. */
export async function forkCollaborationSession(ctx: MaterialContext, sessionId: string, atSeq?: number, signal?: AbortSignal): Promise<{ sessionId: string; executionAuthority: 'none' }> {
  if (!sessionId || atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new Error('Fork requires a source identity and valid event boundary')
  signal?.throwIfAborted()
  const controller = ctx.get('sessionController') as { fork(request: { sessionId: string; atSeq?: number; allowMigration: false }): Promise<{ sessionId: string }> } | undefined
  if (controller === undefined) throw new Error('Native session fork capability is unavailable')
  // Native fork has no cancellation parameter. Once submitted, always return its child identity.
  const child = await controller.fork({ sessionId, ...(atSeq === undefined ? {} : { atSeq }), allowMigration: false })
  if (typeof child.sessionId !== 'string' || child.sessionId === '') throw new Error('Native session fork did not return a child identity; reconcile before retrying')
  return { sessionId: child.sessionId, executionAuthority: 'none' }
}

function attachments(ctx: MaterialContext): MaterialAttachments {
  const store = ctx.get('attachments') as MaterialAttachments | undefined
  if (store === undefined) throw new Error('Native attachment storage is unavailable')
  return store
}

async function accessiblePath(ctx: MaterialContext, path: string, who: string, signal?: AbortSignal): Promise<MaterialFile> {
  signal?.throwIfAborted()
  if (!isAbsolute(path)) throw new Error('Material path must be absolute')
  const fs = ctx.get('fs') as MaterialFilesystem | undefined
  const mapped = fs?.processPathFromHostPath(path)
  if (fs === undefined || mapped === undefined) throw new Error(`${who} cannot access material path`)
  const target = await fs.resolve(mapped, { signal })
  signal?.throwIfAborted()
  return { fs, target, path }
}

async function fileInfo(file: MaterialFile, signal?: AbortSignal): Promise<{ size: number; version: string }> {
  const stat = await file.fs.stat(file.target, signal)
  if (stat?.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size! < 0) throw new Error('Material must be a regular file with a known byte size')
  return { size: stat.size!, version: stat.version }
}

async function* readFileChunks(file: MaterialFile, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const before = await fileInfo(file, signal)
  let offset = 0
  do {
    signal?.throwIfAborted()
    const length = Math.min(65536, before.size - offset)
    const bytes = await file.fs.readByteRange(file.target, { offset, length }, signal)
    if (bytes.byteLength !== length) throw new Error('Material changed during its read')
    offset += bytes.byteLength
    if (bytes.byteLength > 0) yield bytes
  } while (offset < before.size)
  const after = await fileInfo(file, signal)
  if (after.version !== before.version || after.size !== before.size) throw new Error('Material changed during its read')
}

async function digestFile(file: MaterialFile, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of readFileChunks(file, signal)) { hash.update(chunk); bytes += chunk.byteLength }
  return { sha256: hash.digest('hex'), bytes }
}

async function verifyStored(recipient: MaterialContext, block: CollaborationArtifact['block'], signal?: AbortSignal): Promise<void> {
  const store = attachments(recipient)
  if (block.type === 'image') {
    await store.readImage(block.attachment, signal)
    return
  }
  const hostPath = store.fileHostPath(block.attachment)
  if (hostPath === undefined) throw new Error('Recipient cannot access stored file in its execution world')
  const stored = await accessiblePath(recipient, hostPath, 'Recipient', signal)
  const version = await digestFile(stored, signal)
  if (`sha256:${version.sha256}` !== block.attachment.attachmentId || version.bytes !== block.attachment.bytes) throw new Error('Stored artifact integrity mismatch')
}

/** Commit immutable native attachments before dispatch; failure returns no sendable message. */
export async function prepareCollaborationMaterials(
  source: MaterialContext,
  recipient: MaterialContext,
  inputs: readonly CollaborationMaterialInput[],
  signal?: AbortSignal,
): Promise<{ content: ContentBlock[]; artifacts: CollaborationArtifact[] }> {
  const store = inputs.length === 0 ? undefined : attachments(recipient)
  const artifacts: CollaborationArtifact[] = []
  // The host validates an entire image batch before publishing any of its members.
  const images: { index: number; data: Uint8Array; name: string; mediaType: ImageMediaType; sourcePath: string }[] = []
  let imageBytes = 0
  for (const [index, input] of inputs.entries()) {
    const file = await accessiblePath(source, input.path, 'Source', signal)
    const sourcePath = file.path
    const stat = await fileInfo(file, signal)
      if (input.kind === 'image') {
        if (input.mediaType === undefined) throw new Error('Image material requires its media type')
        const limits = store!.imageLimits
        if (limits === undefined) throw new Error('Native image admission limits are unavailable')
        imageBytes += stat.size
        if (stat.size > limits.maxImageBytes || imageBytes > limits.maxMessageImageBytes || images.length >= limits.maxImagesPerMessage) throw new Error('Image materials exceed native admission limits')
        const data = await file.fs.readBytes(file.target, signal, limits.maxImageBytes)
        if ((await fileInfo(file, signal)).version !== stat.version || data.byteLength !== stat.size) throw new Error('Image material changed during its read')
        images.push({ index, data, name: basename(sourcePath), mediaType: input.mediaType, sourcePath })
      } else {
        if (input.kind !== 'file') throw new Error('Unsupported material kind')
        const hash = createHash('sha256'); let bytes = 0
        async function* data() {
          for await (const chunk of readFileChunks(file, signal)) { hash.update(chunk); bytes += chunk.byteLength; yield chunk }
        }
        const attachment = await store!.saveFileStream({ data: data(), name: basename(sourcePath), signal })
        const sha256 = hash.digest('hex')
        if (attachment.attachmentId !== `sha256:${sha256}` || attachment.bytes !== bytes) throw new Error('Native file storage changed material bytes')
        artifacts[index] = { sourcePath, sourceSha256: sha256, sourceBytes: bytes, block: { type: 'file', attachment } }
      }
  }
  signal?.throwIfAborted()
  if (images.length > 0) {
    const refs = await store!.saveImages(images.map(({ data, name, mediaType }) => ({ data, name, mediaType })))
    signal?.throwIfAborted()
    if (refs.length !== images.length) throw new Error('Native image admission returned an incomplete batch')
    for (const [position, image] of images.entries()) {
      artifacts[image.index] = { sourcePath: image.sourcePath, sourceSha256: createHash('sha256').update(image.data).digest('hex'), sourceBytes: image.data.byteLength, block: { type: 'image', attachment: refs[position]! } }
    }
  }
  for (const artifact of artifacts) await verifyStored(recipient, artifact.block, signal)
  signal?.throwIfAborted()
  return { content: artifacts.map(item => item.block), artifacts }
}

/** Revalidate both original version and delivered immutable object before accepting evidence. */
export async function verifyCollaborationArtifacts(
  source: MaterialContext,
  recipient: MaterialContext,
  artifacts: readonly CollaborationArtifact[],
  signal?: AbortSignal,
): Promise<ArtifactVerification[]> {
  const results: ArtifactVerification[] = []
  for (const artifact of artifacts) {
    signal?.throwIfAborted()
    try {
      await verifyStored(recipient, artifact.block, signal)
      const path = await accessiblePath(source, artifact.sourcePath, 'Source', signal)
      const version = await digestFile(path, signal)
      results.push({ artifact, status: version.sha256 === artifact.sourceSha256 && version.bytes === artifact.sourceBytes ? 'verified' : 'source-changed' })
    } catch (error) {
      signal?.throwIfAborted()
      results.push({ artifact, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
