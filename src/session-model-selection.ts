import type { LiveAgentLike } from './core.ts'

export interface SessionModelSelection { provider: string; model: string; reasoningEffort?: string }

function exact(value: unknown): SessionModelSelection | undefined {
  const selection = value as Partial<SessionModelSelection> | undefined
  if (!selection || typeof selection.provider !== 'string' || !selection.provider || typeof selection.model !== 'string' || !selection.model) return undefined
  return { provider: selection.provider, model: selection.model, ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}) }
}

/** Read native pending intent before the last request; never read a host-private selection cache. */
export function readSessionModelSelection(agent: LiveAgentLike): SessionModelSelection | undefined {
  const projections = agent.ctx.get?.('sessionProjections') as { stateOf(session: unknown, key: string): { pending: unknown } | undefined } | undefined
  const state = projections?.stateOf?.(agent.session, 'modelSelection')
  if (state?.pending != null) return exact(state.pending)
  if (!state && agent.session.snapshotEvents().some(event => (event.type as string) === 'model/selection')) return undefined
  const header = agent.session.requestHeader?.()
  if (header) {
    const selected = exact(header.config)
    if (!selected) return undefined
    if (header.adapterDefaults?.reasoningEffort === true) delete selected.reasoningEffort
    return selected
  }
  const initial = exact(agent.options)
  const defaults = agent.ctx.get?.('agentDefaultModel') as { currentSelection(): unknown } | undefined
  const fallback = exact(defaults?.currentSelection?.())
  // A controller-owned blank chat reads the current default, while a headless agent may
  // retain its options. Without a durable intent/header, conflicting routes are ambiguous.
  if (state && initial && fallback && (initial.provider !== fallback.provider || initial.model !== fallback.model || initial.reasoningEffort !== fallback.reasoningEffort)) return undefined
  return initial ?? fallback
}

/** Publish initial/explicit selection through the same durable intent consumed by the native controller. */
export function recordSessionModelSelection(agent: LiveAgentLike, selection: unknown): boolean {
  const selected = exact(selection)
  if (!selected) return false
  const projections = agent.ctx.get?.('sessionProjections') as { stateOf(session: unknown, key: string): unknown } | undefined
  if (!projections?.stateOf?.(agent.session, 'modelSelection')) return false
  // Controller-owned event is public at runtime but not declared by the peer-floor agent package.
  const session = agent.session as unknown as { append(type: 'model/selection', data: SessionModelSelection): unknown }
  session.append('model/selection', selected)
  return true
}
