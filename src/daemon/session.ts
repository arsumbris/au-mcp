// Per-session state and the session registry.
//
// State splits two ways (decision 2606110011): WORKSPACE-SHARED state (the
// plugin/tool registry, the engine connection) lives on the daemon; PER-SESSION
// state (this session's live event log + active mode set) lives here, one
// `Session` per open adapter session.

import type { AdapterInfo, SessionEvent } from '@arsumbris/au-mcp-sdk'

/** One open agent session. The daemon owns its live in-memory event log (P5). */
export interface Session {
  /** Opaque per-session id (from AdapterInfo.session). */
  readonly id: string
  /** What the adapter declared at open: harness, workspace, native tool surface. */
  readonly info: AdapterInfo
  /** The live in-memory event log. The daemon assigns each event's seq on append. */
  readonly log: SessionEvent[]
  /**
   * The read-view: `absolute path -> engine content hash` AT READ TIME (P6-O6,
   * [[decision - 2606222008 ...]]). Populated when the session reads a file through
   * the gate (the daemon resolves the engine hash on the read's observe); consulted
   * by the read-before-write guard at write-mediate so a write carries the hash the
   * session SAW (the engine CAS then rejects a stale overwrite). Per-session by
   * construction — the hash is bound to THIS session's own read, so a concurrent
   * session's read cannot launder a stale write. Reaped with the session on close.
   */
  readonly readView: Map<string, string>
  /**
   * The served-view: canonical absolute paths of files a tool SERVED this session (e.g.
   * `au_guide {scenario}` served its guide), computed at observe from the observed tool
   * name + input + the tool's typed `serves-files-meta` contract ([[decision - 2607030037
   * - au_guide satisfies a read-precondition via a declarative typed serves-contract, not a
   * text sentinel::au-harness]]). SEPARATE from `readView`: a served VIEW satisfies a read-
   * PRECONDITION (a knowledge gate) but must NOT satisfy read-before-WRITE (a safety gate on
   * the exact current bytes) — so the write floor consults `readView` only. Reaped on close.
   *
   * Maps each served path to its SERVE-TIME engine content hash (session FRESHNESS): the hash lets
   * the freshness compare re-open a served precondition when its file changes, uniformly with
   * `readView`. The hash is a freshness comparison value only; it never makes `servedView` a write
   * floor. A path present with an empty hash was served when its hash could not be resolved.
   */
  readonly servedView: Map<string, string>
  /**
   * The set of `dedupeKey`s seen this session (observe idempotency, decision 2609131240). A
   * `dedupeKey`-carrying event whose key is already here is a no-op at observe (not appended, not
   * fanned). Populated on a first observe of each key AND seeded from a resume's replayed keys, so a
   * re-lift after `--resume` dedupes without any ledger read. In-memory, reaped with the session on
   * close. Empty for events with no key (live fire-once events), which are never deduped.
   */
  readonly seenKeys: Set<string>
  /**
   * CONTINUITY LOST: the adapter asserted a RESUME but the kernel held no durable record for the id
   * (retired/wiped) — so the state a continuity-needing capability relied on is gone. Set at the
   * fresh open; drives the continuity-requirements response (hide optional tools / block a required
   * capability's writes). Default false (a fresh session, or a normal resume with the store intact).
   */
  continuityLost: boolean
  /**
   * The PRIOR run index on a resume (the run before this open bumped it), or undefined for a
   * first-ever / non-resumed open. Set at the fresh open. Used to STAMP `run` on observable events
   * an adapter replays via `session-rehydrate`: the replayed conversation belongs to the prior run,
   * and the adapter's transcript carries no `(run, seq)`, so the kernel supplies the run here.
   */
  priorRun?: number
  /**
   * The COMPUTED session-start inject blocks (decision 2609020302): the output of every
   * `session-start` hook, collected once at the fresh open (a live-broker graph query, e.g.
   * "N instances of type T"). The adapter fetches it via `session-start-context` and emits it
   * into the session-start slot. Absent until the fresh-open session-start phase runs; empty
   * when no session-start hook produced any.
   */
  sessionStartInject?: string[]
  /**
   * The active agent-profile's typed `hookConfig`, keyed by hook manifest id (decision 2609021429),
   * resolved from the graph once at the fresh open. The session-start phase consumes it per-instance;
   * a MEDIATOR reads its single config lazily at decide/review via `MediationContext.hookConfig`.
   * Absent until the fresh-open phase runs; empty when the profile configures no hooks.
   */
  hookConfigs?: Map<string, unknown[]>
  /**
   * The active agent-profile's `tools` allowlist as agent-facing tool NAMES, resolved once at the
   * fresh open — the SAME reduction `ctx.scope.tools.active` uses, so visibility and scope share one
   * source (decision 2609071712). Tri-state, replacing the retired per-request `allowed`:
   * `undefined` = unrestricted (every mounted tool advertised + callable); `[]` = none; `[names]` =
   * exactly those. Gates `list-capabilities` + `invoke`. Absent until the fresh-open phase runs; a
   * session-less call has none and falls back to the request. See the tool-visibility spec.
   */
  toolAllowlist?: string[]
  /**
   * The active agent-profile's `nativeToolAllowlist` (native-tool whitelist), resolved daemon-side
   * from the profile graph once at the fresh open — the native twin of `toolAllowlist`, replacing the
   * retired `AU_MCP_NATIVE_TOOLS` env transit. Tri-state: `undefined` = every native tool allowed
   * (the hard default); `[]` = none; `[names]` = exactly those. The `mcp.native-tool-redirect`
   * mediator reads it via `SessionLaunch.nativeToolAllowlist`. Absent until the fresh-open phase runs.
   */
  nativeToolAllowlist?: string[]
}

/**
 * Holds the open sessions, keyed by their opaque id. A session PERSISTS across
 * connections (a CC hook is a short-lived process: connect, one request, exit;
 * many such connections share one logical session). It is closed only explicitly
 * (`session-close`), like the engine daemon — never on a connection dropping.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>()
  private readonly seq = new Map<string, number>()
  // The per-session RUN index. A session is a durable identity spanning many runs (one open->close
  // episode each); the kernel stamps `run` on every event so ledger-stable identity is `(run, seq)`.
  // In-memory here: a fresh session's first run is 1. Durable persistence across close + resume
  // (bumping `run` on a resumed open) lands with the durable-store phase. See [[spec - session run
  // lifecycle - a durable session is a series of runs keyed by run-seq and rehydrated from a minimal
  // un-forgeable store]].
  private readonly run = new Map<string, number>()

  /**
   * Idempotent: re-opening an existing id returns it unchanged (keeps the log + read-view).
   * `run` seeds the RUN index for a NEW session (the daemon computes it from the durable record —
   * fresh -> 1, resume -> prior+1); a re-open ignores it, keeping the live run.
   */
  open(info: AdapterInfo, run?: number): Session {
    const existing = this.sessions.get(info.session)
    if (existing) return existing
    const session: Session = {
      id: info.session,
      info,
      log: [],
      readView: new Map<string, string>(),
      servedView: new Map<string, string>(),
      seenKeys: new Set<string>(),
      continuityLost: false,
    }
    this.sessions.set(info.session, session)
    if (!this.seq.has(info.session)) this.seq.set(info.session, 0)
    if (!this.run.has(info.session)) this.run.set(info.session, run ?? 1)
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /** The current run index for a session (0 if unknown). */
  runOf(id: string): number {
    return this.run.get(id) ?? 0
  }

  close(id: string): boolean {
    this.seq.delete(id)
    this.run.delete(id)
    return this.sessions.delete(id)
  }

  get size(): number {
    return this.sessions.size
  }

  /** Every live session, for a workspace-wide sweep (session FRESHNESS intersects each session's views). */
  all(): Iterable<Session> {
    return this.sessions.values()
  }

  /**
   * Append one event to a session's live log, stamping the daemon's authoritative
   * monotonic `(run, seq)` (P5: the daemon owns the live log, so it owns sequencing — the
   * incoming event's run + seq are advisory and get overwritten). Returns the stamped event.
   */
  append(id: string, event: SessionEvent): SessionEvent | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const next = (this.seq.get(id) ?? 0) + 1
    this.seq.set(id, next)
    const run = this.run.get(id) ?? 1
    const stamped: SessionEvent = { ...event, run, seq: next, session: id }
    session.log.push(stamped)
    return stamped
  }

  /** The highest seq stamped for a session (0 if none / unknown). */
  headSeq(id: string): number {
    return this.seq.get(id) ?? 0
  }

  /**
   * Restore previously-persisted events into an open session's log, READ-ONLY: they are injected for
   * `consultTrace` visibility carrying their ORIGINAL `(run, seq)`, and never pass through the observe
   * path (so the read-views are untouched). Only the governance (emitted) slice is restored, so the
   * log has seq gaps where observed events were — fine for the kind-filtered replay a step-gate does.
   * A no-op if the session is already populated (an idempotent re-open of a LIVE session must not
   * double-load).
   *
   * `continueSeq` decides the seq counter:
   * - true (a daemon-CRASH recovery of the SAME run): continue seq from the highest restored value so
   *   the recovered run stays monotonic.
   * - false (a RESUME into a NEW run): leave the counter untouched, so the new run's `seq` restarts at
   *   1 and the restored prior-run events keep their own `(run, seq)` — no collision.
   */
  rehydrate(id: string, events: SessionEvent[], opts?: { continueSeq?: boolean }): void {
    const session = this.sessions.get(id)
    if (!session || session.log.length > 0 || events.length === 0) return
    for (const e of events) session.log.push(e)
    if (opts?.continueSeq) {
      let max = this.seq.get(id) ?? 0
      for (const e of events) if (e.seq > max) max = e.seq
      this.seq.set(id, max)
    }
  }

  /**
   * Inject already-stamped events READ-ONLY into the live log (for `consultTrace`), preserving their
   * own `(run, seq)` and NEVER advancing the current run's seq. Unlike `rehydrate` it does not
   * require an empty log: replayed OBSERVABLE conversation augments the governance already rehydrated
   * on a resume. It never touches `readView` / `servedView` (those come only from the observe path),
   * so the read-views stay empty across a resume.
   */
  injectReplay(id: string, events: SessionEvent[]): number {
    const session = this.sessions.get(id)
    if (!session) return 0
    for (const e of events) session.log.push(e)
    return events.length
  }
}
