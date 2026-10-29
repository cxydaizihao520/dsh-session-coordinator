// Independent process fixture: real native storage, native kernel lock, synthetic records only.
import { Context } from 'cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { openCollaborationStore } from '../../src/collaboration-store.ts'

const [directory, mode] = process.argv.slice(2)
const ctx = new Context(); new Storage(ctx)
try {
  const store = await openCollaborationStore(ctx, { directory })
  if (mode === 'hold') {
    if (!store.get('task:child')) await store.create({ id: 'task:child', owner: 'synthetic-A', revision: 1, data: { phase: 'accepted-unknown', operationId: 'stable-operation', revoked: true } })
    process.send({ state: 'ready', records: store.list() })
    process.on('message', async message => {
      if (message === 'close') { await store.close(); process.exit(0) }
    })
  } else {
    process.send({ state: 'opened', records: store.list() })
    await store.close()
    process.exit(0)
  }
} catch (error) {
  process.send({ state: 'error', code: error.code, message: error.message })
  process.exitCode = 1
}
