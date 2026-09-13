// Ephemeral crash-recovery scratch for a governed session's step-state.
//
// A daemon PROCESS DEATH loses the in-memory session log, so a self-gating mediator (au-workflow's
// step-gate) reads "no active workflow" and fails OPEN — the D2 hole. This persists ONLY the
// mediator-EMITTED events (transitions / denials — the un-forgeable governance slice, since emit
// is mediator-only) to a scratch file, rehydrated on the FIRST session-open after a restart so
// `consultTrace` replay recovers the step. Reconnects need nothing: the daemon keeps the session
// (idempotent open), so only a true process death reaches here.
//
// This is a RECOVERY SCRATCH, not a record. It refines [[decision - 2608041317 - durable
// governed-session step-state is a kernel crash-resistance guarantee, not a plugin file log]]:
// - EPHEMERAL: GC'd on session-close (and age-swept for orphans), it dies with the session.
// - GOVERNANCE-ONLY: just the emitted events, not the full session — the full permanent ledger
//   stays au-provenance's (plugin) job.
// - OUT OF THE AGENT'S REACH: under `$HOME/.arsumbris`, NOT the workspace, so the agent (which
//   has `write_file`, scoped to the workspace) cannot forge its step by writing the scratch.

import { appendFileSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { auDeviceDirCustom } from '@arsumbris/au-engine-sdk'
import type { SessionEvent } from '@arsumbris/au-mcp-sdk'
import type { EngineBroker } from './broker.ts'

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** The scratch base. `$HOME/.arsumbris/au-mcp/crash-recovery` by default (beside the sockets, out
 *  of the workspace); overridable via `AU_MCP_RECOVERY_DIR` for isolated tests. `crash-recovery`
 *  is a free-form category, so it rides engine-sdk's `auDeviceDirCustom` — same raw-`$HOME`
 *  derivation as our sockets + gen dir (was `os.homedir()`, now aligned to `$HOME`). */
function baseDir(): string {
  return process.env.AU_MCP_RECOVERY_DIR ?? auDeviceDirCustom('au-mcp', 'crash-recovery')
}

/** The per-workspace scratch dir, keyed by a stable hash of the realpath'd entry. */
function recoveryDir(workspace: string): string {
  let key = workspace
  try { key = realpathSync(workspace) } catch { /* not yet on disk -> hash the raw path */ }
  return join(baseDir(), shortHash(key))
}

/** The scratch file for one session (session id hashed to a safe single path segment). */
function recoveryFile(workspace: string, sessionId: string): string {
  return join(recoveryDir(workspace), `${shortHash(sessionId)}.ndjson`)
}

/**
 * Append a stamped emitted event to the session's scratch (SYNC — the governance fact must be
 * durable before the mediate decision returns, so a death right after does not lose it). BEST-
 * EFFORT: the scratch is a safety net; a write failure must never take the session with it.
 */
export function appendRecovery(workspace: string, sessionId: string, event: SessionEvent): void {
  try {
    mkdirSync(recoveryDir(workspace), { recursive: true })
    appendFileSync(recoveryFile(workspace, sessionId), JSON.stringify(event) + '\n')
  } catch {
    /* best-effort */
  }
}

// --- the durable session RECORD (run identity + dormancy) --------------------
//
// A session is a durable identity spanning many RUNS (one open->close episode each). The run index
// is the RESUME MARKER: it must survive a clean close (unlike the governance scratch above, which is
// cleared on close). The `dormant` flag, set on a clean close, lets a later open tell a RESUME (bump
// the run) from a daemon-CRASH recovery (a record exists but was never cleanly closed -> same run).
// See [[spec - session run lifecycle - a durable session is a series of runs keyed by run-seq and
// rehydrated from a minimal un-forgeable store]].

/** The durable per-session record: the current RUN index + whether the session was cleanly closed.
 *  Carries the raw session `id` so a store sweep (which walks files keyed by a HASH of the id) can
 *  surface the real id for retention listing + retirement. */
export interface SessionRecord {
  id: string
  run: number
  dormant: boolean
  /** The adapter that produced the session (`AdapterInfo.harness`) — the resume discriminator, the
   *  OPAQUE relaunch reference (`AdapterInfo.resumeRef`), and the agent-profile locator the session
   *  ran under (`AdapterInfo.profile`), so a host can restore the same surface on resume. All
   *  persisted at run-start and surfaced on `list-dormant`. Absent on pre-existing records. */
  harness?: string
  resumeRef?: string
  profile?: string
}

function sessionRecordFile(workspace: string, sessionId: string): string {
  return join(recoveryDir(workspace), `${shortHash(sessionId)}.session.json`)
}

/** The persisted session record, or undefined for a never-seen session (a FRESH session). `id` comes
 *  from the caller (who holds it), so an older record written without one still loads. */
export function loadSessionRecord(workspace: string, sessionId: string): SessionRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(sessionRecordFile(workspace, sessionId), 'utf8')) as Partial<SessionRecord>
    if (typeof rec?.run === 'number') return {
      id: sessionId, run: rec.run, dormant: rec.dormant === true,
      ...(typeof rec.harness === 'string' ? { harness: rec.harness } : {}),
      ...(typeof rec.resumeRef === 'string' ? { resumeRef: rec.resumeRef } : {}),
      ...(typeof rec.profile === 'string' ? { profile: rec.profile } : {}),
    }
  } catch {
    /* none / unreadable -> treated as fresh */
  }
  return undefined
}

/**
 * Persist the session record ATOMICALLY (write a temp file, then rename onto the target on the same
 * filesystem). The run index is the resume marker, and it is written at run-start BEFORE any event of
 * the run is stamped, so a crash mid-write must never leave a torn counter. Best-effort on failure.
 */
export function persistSessionRecord(workspace: string, sessionId: string, rec: SessionRecord): void {
  try {
    mkdirSync(recoveryDir(workspace), { recursive: true })
    const target = sessionRecordFile(workspace, sessionId)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(rec))
    renameSync(tmp, target)
  } catch {
    /* best-effort */
  }
}

/** Mark a session dormant on a clean close, preserving its run index as the resume marker. */
export function markSessionDormant(workspace: string, sessionId: string): void {
  const rec = loadSessionRecord(workspace, sessionId)
  if (rec && !rec.dormant) persistSessionRecord(workspace, sessionId, { ...rec, dormant: true })
}

/** The emitted events previously persisted for a session, or [] if none / unreadable. */
export function loadRecovery(workspace: string, sessionId: string): SessionEvent[] {
  try {
    return readFileSync(recoveryFile(workspace, sessionId), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as SessionEvent)
  } catch {
    return []
  }
}

/** GC a session's governance scratch. Called by `retire`, not on close — a clean close leaves the
 *  session DORMANT and its governance KEPT (for resume rehydration); only retirement clears it. */
export function clearRecovery(workspace: string, sessionId: string): void {
  try {
    rmSync(recoveryFile(workspace, sessionId), { force: true })
  } catch {
    /* already gone */
  }
}

/**
 * Retire a session: GC its whole durable store — the governance scratch AND the session record.
 *
 * This is the WHOLE kernel side of retirement. The kernel touches no recorder's files: a recorder
 * (au-provenance) decides new-vs-continue from the `run-start(isResume)` signal, so a resume of a
 * retired id arrives `isResume=false` (no record) and the recorder starts fresh — no rename needed.
 * See [[spec - session retention - dormant sessions are surfaced, age-bounded, and retired by a
 * kernel-store GC the recorder follows]].
 */
export function retire(workspace: string, sessionId: string): void {
  clearRecovery(workspace, sessionId)
  try {
    rmSync(sessionRecordFile(workspace, sessionId), { force: true })
  } catch {
    /* already gone */
  }
}

/** A dormant/orphan session's durable store, summarized for the retention surface + sweep. */
export interface SessionSummary {
  id: string
  run: number
  /** True = cleanly closed (resumable). False = open/crashed mid-run (an orphan). */
  dormant: boolean
  /** Newest mtime across the session's store files (its last activity). */
  lastActiveMs: number
  /** Total bytes of the session's store files. */
  sizeBytes: number
  /** The producing adapter (resume discriminator), its opaque relaunch reference, and the profile the
   *  session ran under, from the record. Absent on records written before these fields existed. */
  harness?: string
  resumeRef?: string
  profile?: string
}

/**
 * List every session with a durable store, from the record files (which carry the raw id — the
 * filenames are hashed). One entry per session, aggregating its files by shared hash STEM. A stem
 * with no readable record is skipped (its id is unrecoverable), and is left to the age-sweep of the
 * older single-window path — in practice every run persists a record at run-start, so this is total.
 */
export function listSessions(workspace: string): SessionSummary[] {
  const dir = recoveryDir(workspace)
  const out: SessionSummary[] = []
  try {
    if (!existsSync(dir)) return out
    const byStem = new Map<string, string[]>()
    for (const f of readdirSync(dir)) {
      const stem = f.split('.')[0]
      const list = byStem.get(stem) ?? []
      list.push(f)
      byStem.set(stem, list)
    }
    for (const files of byStem.values()) {
      let newest = 0
      let size = 0
      let rec: Partial<SessionRecord> | undefined
      for (const f of files) {
        try {
          const st = statSync(join(dir, f))
          newest = Math.max(newest, st.mtimeMs)
          size += st.size
          if (f.endsWith('.session.json')) {
            rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<SessionRecord>
          }
        } catch {
          /* racing another sweep / already gone */
        }
      }
      if (rec && typeof rec.id === 'string' && typeof rec.run === 'number') {
        out.push({
          id: rec.id, run: rec.run, dormant: rec.dormant === true, lastActiveMs: newest, sizeBytes: size,
          ...(typeof rec.harness === 'string' ? { harness: rec.harness } : {}),
          ...(typeof rec.resumeRef === 'string' ? { resumeRef: rec.resumeRef } : {}),
          ...(typeof rec.profile === 'string' ? { profile: rec.profile } : {}),
        })
      }
    }
  } catch {
    /* no dir yet */
  }
  return out
}

/**
 * Age-based retention: retire every session whose store is past its window, THROUGH the given
 * `retire` callback (so it emits the best-effort `session-retire` signal + GC's the store, never a
 * bare `rm`). A DORMANT session (cleanly closed, resumable) gets `dormantWindowMs`; an ORPHAN
 * (open/crashed mid-run) gets the shorter `orphanWindowMs`. Per-session atomic: a session is retired
 * as a whole when its NEWEST store file is past its window. Returns the retired ids. `now` injectable.
 */
export function sweepRetention(
  workspace: string,
  opts: { dormantWindowMs: number; orphanWindowMs: number; now?: number },
  retire: (sessionId: string) => void,
): string[] {
  const now = opts.now ?? Date.now()
  const retired: string[] = []
  for (const s of listSessions(workspace)) {
    const window = s.dormant ? opts.dormantWindowMs : opts.orphanWindowMs
    if (s.lastActiveMs > 0 && now - s.lastActiveMs > window) {
      retire(s.id)
      retired.push(s.id)
    }
  }
  return retired
}

/** Default dormancy window: a cleanly-closed session stays resumable this long, then is retired. */
export const RETENTION_DORMANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Orphan window: an open/crashed-mid-run session's scratch is retired sooner (never cleanly closed). */
export const RECOVERY_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** au-mcp's retention-config storage address: scoped-config, repo scope, `au-mcp` consumer. PRIVATE
 *  to au-mcp — a consuming app never names it; it calls the retention verbs. */
const RETENTION_CONFIG = { scope: 'repo', consumer: 'au-mcp', file: 'retention.yaml', type: 'retention-config' } as const
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * au-mcp's dormancy retention window, in ms, or undefined when unset / unparseable / non-positive.
 *
 * Read from au-mcp's OWN storage over the engine's scoped-config channel (`config` read, repo scope,
 * consumer `au-mcp`), NOT a hand-parsed file — it moved off the retired `<ws>/.arsumbris/au-mcp.yaml`
 * `dormancy_days` regex. ASYNC (an engine round-trip). The value is parsed off the file content; the
 * engine field-shape-validates it against `retention-config`.
 */
export async function readRetentionWindowMs(broker: EngineBroker): Promise<number | undefined> {
  try {
    const frame = await broker.read('config', { ...RETENTION_CONFIG })
    const content = (frame.result as { content?: string | null } | undefined)?.content
    if (!content) return undefined
    const m = /^\s*dormancy_days\s*:\s*(\d+)\s*$/im.exec(content)
    if (!m) return undefined
    const days = Number(m[1])
    return days > 0 ? days * DAY_MS : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist au-mcp's retention window (whole days) to its scoped-config storage (governed, committed).
 * THROWS on a rejected write (no engine, validation, CAS) so a failed write never reads as success.
 * `days` must be a positive integer — the caller validates at the wire boundary.
 */
export async function writeRetentionWindow(broker: EngineBroker, days: number): Promise<void> {
  const frame = await broker.mutate('set_config', { ...RETENTION_CONFIG, content: `dormancy_days: ${days}\n` })
  if ((frame as { type?: string }).type === 'error') {
    throw new Error(`set-retention-window failed: ${(frame as { message?: string }).message ?? 'engine rejected the write'}`)
  }
}
