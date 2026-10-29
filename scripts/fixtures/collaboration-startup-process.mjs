// Separate process keeps the real user home untouched while exercising install-owned storage.
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { openCollaborationStore } from '../../src/collaboration-store.ts'
import { installCollaboration } from '../../src/collaboration-tools.ts'

const [directory, mode] = process.argv.slice(2)
process.env.DSH_HOME = directory
const ctx = new Context(); new Storage(ctx)
ctx.tools = { register() {} }
const disposers = []
ctx.effect = setup => { const dispose = setup(); disposers.push(dispose); if (mode === 'dispose') dispose() }
if (mode === 'invalid') {
  const store = await openCollaborationStore(ctx)
  await store.create({ id: 'collab-invalid', owner: 'A', revision: 1, data: { invalid: true } })
  await store.close()
}
const ready = installCollaboration({ ctx })
try {
  await assert.rejects(ready, mode === 'invalid' ? /invalid persisted collaboration collab-invalid/ : /disposed|abort|closed/i)
  for (const dispose of disposers) dispose()
  const successor = await openCollaborationStore(ctx)
  await successor.close()
  process.send({ state: 'released' })
} catch (error) {
  process.send({ state: 'error', message: error.message, code: error.code })
  process.exitCode = 1
}
