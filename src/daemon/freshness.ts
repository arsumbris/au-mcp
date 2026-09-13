// Session FRESHNESS (Mechanism 3 of the durable-session design): one held `changes` subscription
// keeps each session's read-views (`readView`, `servedView`) honest against change the session did
// not make.
//
// The mechanism is a HASH COMPARE, not an origin correlation. On a change to file P the daemon
// re-reads P's current engine hash once and compares it against each session's STORED hash for P:
// - stored != current -> the session is stale -> invalidate that view entry + advise the agent.
// - stored == current -> not stale -> skip. This is echo-suppression FOR FREE: the writer holds the
//   post-write hash (the write-bump), so it matches current and is skipped; every other holder has a
//   stale hash and is invalidated. Coalescing-proof (compares the FINAL hash) and topology-blind (a
//   peer daemon / human write simply matches no held hash).
//
// ADVISORY, never a floor: the hard write floor stays the engine CAS. A missed/lagged/dropped event
// degrades to today's behaviour (caught at write), never worse. See
// [[spec - session freshness - the daemon keeps each session's read-views honest against external
// change over one changes subscription]].

import type { Session } from './session.ts'
import type { ChangesHandlers } from './broker.ts'

export interface FreshnessDeps {
  /**
   * Subscribe to the engine `changes` feed (the broker's held connection). Undefined when the broker
   * cannot subscribe (no engine, or a test fake) — freshness then stays inert.
   */
  subscribeChanges?: (handlers: ChangesHandlers) => () => void
  /** Every live session, evaluated fresh per event (sessions open and close between events). */
  sessions: () => Iterable<Session>
  /** A path's CURRENT engine content hash, or null when gone / unreadable / no engine. */
  currentHash: (path: string) => Promise<string | null>
  /** Advise a session that these paths changed under it, on its next tool result. */
  notify: (session: string, paths: string[]) => void
}

export interface FreshnessManager {
  /** Stop the held subscription. Idempotent. */
  stop(): void
}

/**
 * Wire the freshness hash-compare to the `changes` feed. Starts the ONE subscription immediately (if
 * the broker supports it) and returns a handle to stop it. All processing is best-effort and async
 * off the event; a throwing check never propagates to the subscription.
 */
export function createFreshness(deps: FreshnessDeps): FreshnessManager {
  const { subscribeChanges, sessions, currentHash, notify } = deps

  // Re-validate a set of candidate paths against every session's views. `paths` is the changed set on
  // a live event; on a reconnect it is each session's own view keys (the gap missed events, so the
  // whole view is suspect). One current-hash read per candidate path, shared across all holders.
  const revalidate = async (paths: Iterable<string>): Promise<void> => {
    const stale = new Map<string, string[]>() // session id -> invalidated paths
    for (const path of new Set(paths)) {
      const holders: Session[] = []
      for (const s of sessions()) {
        if (s.readView.has(path) || s.servedView.has(path)) holders.push(s)
      }
      if (holders.length === 0) continue
      const current = await currentHash(path) // null (gone/unreadable) never equals a stored string -> invalidates
      for (const s of holders) {
        let invalidated = false
        if (s.readView.has(path) && s.readView.get(path) !== current) {
          s.readView.delete(path)
          invalidated = true
        }
        if (s.servedView.has(path) && s.servedView.get(path) !== current) {
          s.servedView.delete(path)
          invalidated = true
        }
        if (invalidated) {
          const list = stale.get(s.id) ?? []
          list.push(path)
          stale.set(s.id, list)
        }
      }
    }
    for (const [session, invalidated] of stale) notify(session, invalidated)
  }

  const onChange: ChangesHandlers['onChange'] = (delta) => {
    // A modified path may be stale; a removed path a session holds is stale too (currentHash -> null).
    // An added path cannot be in a view (a session cannot have read it before it existed).
    void revalidate([...delta.modified, ...delta.removed]).catch(() => {})
  }

  const onReconnect: ChangesHandlers['onReconnect'] = () => {
    // The channel has no initial value, so a reconnect gap missed events. Re-validate every session's
    // whole view (the union of all view keys), applying the same compare.
    const keys = new Set<string>()
    for (const s of sessions()) {
      for (const k of s.readView.keys()) keys.add(k)
      for (const k of s.servedView.keys()) keys.add(k)
    }
    void revalidate(keys).catch(() => {})
  }

  const stopSub = subscribeChanges?.({ onChange, onReconnect })

  return {
    stop: () => stopSub?.(),
  }
}
