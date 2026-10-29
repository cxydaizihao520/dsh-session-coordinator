import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { createHash } from 'node:crypto'
import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface StoredCollaborationRecord {
  id: string
  owner: string
  revision: number
  data: Record<string, JsonValue>
}

// Validate JSON descriptors too: ordinary schema records discard __proto__ keys and can invoke getters.
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return
  if (typeof value !== 'object' || ancestors.has(value)) throw new CollaborationStoreError('invalid-record', 'Collaboration records must contain finite, acyclic JSON values.')
  const array = Array.isArray(value)
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new CollaborationStoreError('invalid-record', 'Collaboration data must use plain JSON objects.')
  const keys = Reflect.ownKeys(value)
  if (array && keys.length !== value.length + 1) throw new CollaborationStoreError('invalid-record', 'Collaboration arrays must have every index and no additional properties.')
  ancestors.add(value)
  for (const key of keys) {
    if (array && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new CollaborationStoreError('invalid-record', 'Collaboration JSON fields must be enumerable data properties.')
    assertJson(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
}

const recordSchema = z.unknown().transform(value => { assertJson(value); return structuredClone(value) }).pipe(z.object({
  id: z.string().min(1), owner: z.string().min(1), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  data: z.custom<Record<string, JsonValue>>(value => value !== null && typeof value === 'object' && !Array.isArray(value)),
}).strict()).transform(record => { freeze(record); return record })
const spec = defineDomain({ name: 'collaboration', version: 1, layout: 'single', tables: { tasks: domainTable(recordSchema) } })

export interface CollaborationStore {
  get(id: string): StoredCollaborationRecord | undefined
  list(owner?: string): StoredCollaborationRecord[]
  create(record: StoredCollaborationRecord): Promise<StoredCollaborationRecord>
  update(id: string, expectedRevision: number, mutate: (current: StoredCollaborationRecord) => StoredCollaborationRecord): Promise<StoredCollaborationRecord>
  close(): Promise<void>
}

export class CollaborationStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CollaborationStoreError'
    this.code = code
  }
}

function immutableRecord(value: unknown): StoredCollaborationRecord {
  return recordSchema.parse(value)
}

/** The caller owns close(). Submitted native writes drain before the kernel lease is released. */
export async function openCollaborationStore(ctx: Context, options: { directory?: string; signal?: AbortSignal } = {}): Promise<CollaborationStore> {
  if (!ctx.storage?.backend) throw new CollaborationStoreError('unavailable', 'Collaboration requires the native storage service.')
  options.signal?.throwIfAborted()
  const directory = resolve(options.directory ?? dshHomePath('collaboration'))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await realpath(directory)
  const lease = await open(join(root, 'writer.lock'), 'a', 0o600)
  try {
    await tryLockExclusive(lease.fd)
    const held = await lease.stat({ bigint: true })
    const current = await stat(join(root, 'writer.lock'), { bigint: true })
    if (held.ino !== current.ino || held.dev !== current.dev) throw new CollaborationStoreError('already-owned', 'Collaboration writer lock changed; reopen the store.')
    options.signal?.throwIfAborted()
  } catch (error) {
    await lease.close()
    if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
      throw new CollaborationStoreError('already-owned', 'Collaboration records are owned by another live writer.', { cause: error })
    }
    throw error
  }
  const backend = new JsonStorageBackend(root)
  let unregister: (() => void) | undefined
  try {
    const backendName = 'session_coordinator_' + createHash('sha256').update(root).digest('hex')
    unregister = ctx.storage.backend.register(backendName, backend)
    const domain = await new DomainFacility(ctx, { backend: backendName }).open(spec)
    const tasks = domain.table('tasks')
    for (const [key, value] of tasks.entries()) {
      if (key !== value.id) throw new CollaborationStoreError('invalid-record', 'Collaboration record key and identity disagree.')
    }
    let disposal: Promise<void> | undefined
    let fault: CollaborationStoreError | undefined
    let writes = Promise.resolve()
    const assertReadable = () => {
      if (disposal) throw new CollaborationStoreError('closed', 'Collaboration store is closed.')
      if (fault) throw fault
    }
    // This admission queue fences later operations after an uncertain native write; native update still owns revision CAS.
    const write = <T>(operation: () => Promise<T>): Promise<T> => {
      assertReadable()
      const result = writes.then(() => {
        if (fault) throw fault
        options.signal?.throwIfAborted()
        return operation()
      })
      writes = result.then(() => {}, () => {})
      return result
    }
    const unknownWrite = (cause: unknown): never => {
      fault ??= new CollaborationStoreError('durability-unknown', 'Collaboration write durability is unknown; close and reopen for reconciliation before continuing.', { cause })
      throw fault
    }
    const onAbort = () => { void store.close().catch(error => { console.warn('[dsh-session-coordinator] collaboration close failed:', error) }) }
    const store: CollaborationStore = {
      get(id) { assertReadable(); return structuredClone(tasks.get(id)) },
      list(owner) {
        assertReadable()
        return [...tasks.entries()].map(([, record]) => structuredClone(record)).filter(record => owner === undefined || record.owner === owner)
      },
      async create(value) {
        assertReadable()
        const record = immutableRecord(value)
        return write(async () => {
          if (record.revision !== 1) throw new CollaborationStoreError('invalid-record', 'A new collaboration record must start at revision 1.')
          if (tasks.get(record.id)) throw new CollaborationStoreError('duplicate', 'Collaboration record already exists.')
          try { await tasks.put(record.id, record) } catch (error) { unknownWrite(error) }
          return structuredClone(record)
        })
      },
      async update(id, expectedRevision, mutate) {
        return write(async () => {
          let prepared = false
          try {
            const next = await tasks.update(id, current => {
              if (current.revision !== expectedRevision) throw new CollaborationStoreError('revision-mismatch', 'Collaboration revision changed; read the current record before retrying.')
              const next = immutableRecord(mutate(structuredClone(current)))
              if (next.id !== id) throw new CollaborationStoreError('invalid-record', 'Collaboration identity cannot change.')
              if (next.owner !== current.owner) throw new CollaborationStoreError('invalid-record', 'Collaboration owner cannot change.')
              if (next.revision !== current.revision + 1) throw new CollaborationStoreError('invalid-record', 'Collaboration revision must advance by exactly one.')
              prepared = true
              return next
            })
            return structuredClone(next)
          } catch (error) {
            if (prepared) unknownWrite(error)
            throw error
          }
        })
      },
      close() {
        disposal ??= (async () => {
          options.signal?.removeEventListener('abort', onAbort)
          await writes
          await domain.close()
          await backend.close()
          unregister?.()
          // Keep the lock file: deleting it would allow another writer to lock a different inode.
          await lease.close()
        })()
        return disposal
      },
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      await store.close()
      options.signal.throwIfAborted()
    }
    return store
  } catch (error) {
    await backend.close()
    unregister?.()
    await lease.close()
    throw error
  }
}
