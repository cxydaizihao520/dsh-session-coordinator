import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export async function nativeModelSelection() {
  const tools = fileURLToPath(new URL('../../tools/asar.mjs', import.meta.url))
  const read = path => execFileSync(process.execPath, [tools, 'cat', '/dsh/node_modules/@deepseek-ai/' + path], { encoding: 'utf8' })
  const load = source => import('data:text/javascript;base64,' + Buffer.from(
    source.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, name) => 'from ' + JSON.stringify(import.meta.resolve(name))),
  ).toString('base64'))
  const model = await load(read('dsh-agent/lib/types/model-selection.js'))
  if (model.modelSelectionProjectionDefinition) return { ...model, projection: model.modelSelectionProjectionDefinition }
  const { installModelSelectionProjection } = await load(read('dsh-api-session-controller/lib/types/model-selection-projection.js'))
  let projection
  installModelSelectionProjection({ sessionProjections: { register: value => { projection = value } } })
  return { ...model, projection }
}
