// The launch-handle -> session binding.
//
// The CC mcp-server shim invokes the daemon with no session (CC exposes none to an MCP server),
// but it CAN carry a stable per-launch handle (`AU_MCP_SESSION`) that the hooks share. The hooks
// declare `AdapterInfo.handle` at session-open; the daemon binds `handle -> session id` here, so a
// session-less invoke carrying only the handle resolves to the live session.
//
// The handle is per-PROCESS; the session id is per-CC-session and changes on `/clear` (a fresh id,
// a fresh session-open). So the binding is REFRESHED on every session-open: a `/clear` rebinds the
// same handle to the new session, while the mcp-server keeps sending the unchanged handle. See
// [[decision - 2608070047 - a mandatory per-launch session handle in the env, fail-closed, binds to
// the live CC session]].

/** Maps each live launch handle to its current session id. Tiny (one entry per open launch). */
export class SessionBindings {
  private readonly byHandle = new Map<string, string>()

  /** Bind a handle to a session id, or REBIND it (the `/clear` case: same handle, new session). */
  bind(handle: string, session: string): void {
    this.byHandle.set(handle, session)
  }

  /**
   * Resolve a key to a bound session id, or undefined when it is not a bound handle. The resolve
   * RULE (in the daemon) is `bindings.resolve(request.session) ?? request.session`: a handle maps to
   * its session; a raw session id from a direct caller (never bound) falls through unchanged.
   */
  resolve(key: string): string | undefined {
    return this.byHandle.get(key)
  }

  /**
   * Drop a handle's binding on session-close, but ONLY when it still points at THIS session. On
   * `/clear` the new session-open rebinds the handle BEFORE the old session's close in some
   * orderings; the guard keeps that rebind from being clobbered by the stale close.
   */
  unbind(handle: string, session: string): void {
    if (this.byHandle.get(handle) === session) this.byHandle.delete(handle)
  }
}
