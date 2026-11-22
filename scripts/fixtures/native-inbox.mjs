// Exercise the installed inbox reducer against the fixture's real Session log.
export function nativeInbox(Inbox, projection, session, dispatch) {
  const readState = () => session.snapshotEvents().reduce(
    (state, event) => projection.apply(state, event), projection.init(),
  )
  // Older constructors received the projection service. rc.5 receives its reader.
  const reader = /constructor\(readState,/.test(Inbox.toString())
    ? readState
    : { stateOf: readState }
  return new Inbox(reader, session, dispatch)
}
