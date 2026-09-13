import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AdapterInfo, SessionEvent, Plugin, RunLifecycle, DormantSession } from '@arsumbris/au-mcp-sdk'
import type { WireConnection } from '../src/wire/server.ts'
import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import { createDaemon } from '../src/daemon/daemon.ts'
import { SessionRegistry } from '../src/daemon/session.ts'
import {
  loadSessionRecord,
  persistSessionRecord,
  markSessionDormant,
  appendRecovery,
  loadRecovery,
  sweepRetention,
  listSessions,
  retire,
} from '../src/daemon/crash-recovery.ts'

const conn: WireConnection = { send: () => {}, onClose: () => {} }
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-runid-'))

const ORIG = process.env.AU_MCP_RECOVERY_DIR
beforeEach(() => {
  process.env.AU_MCP_RECOVERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-runrec-'))
})
afterEach(() => {
  if (ORIG === undefined) delete process.env.AU_MCP_RECOVERY_DIR
  else process.env.AU_MCP_RECOVERY_DIR = ORIG
})

const info = (session: string, extra: Partial<AdapterInfo> = {}): AdapterInfo => ({
  harness: 'cc',
  session,
  workspace: ws,
  nativeTools: [],
  ...extra,
})

// Read the run stamped on the most recent observed event, via consult-trace.
async function traceEvents(daemon: ReturnType<typeof createDaemon>, session: string): Promise<SessionEvent[]> {
  const tr = (await daemon.handle({ kind: 'consult-trace', id: 99, session, query: {} } as never, conn)) as {
    slice: { events: SessionEvent[] }
  }
  return tr.slice.events
}
async function runOfLatest(daemon: ReturnType<typeof createDaemon>, session: string): Promise<number> {
  return (await traceEvents(daemon, session)).at(-1)!.run
}
const observe = (daemon: ReturnType<typeof createDaemon>, session: string, kind: string) =>
  daemon.handle({ kind: 'observe', id: 1, session, event: { kind, run: 0, seq: 0, session, data: null } } as never, conn)

describe('the durable session record (run identity + dormancy)', () => {
  it('round-trips, marks dormant, and is undefined for a never-seen session', () => {
    expect(loadSessionRecord(ws, 'never')).toBeUndefined()
    persistSessionRecord(ws, 'x', { id: 'x', run: 1, dormant: false })
    expect(loadSessionRecord(ws, 'x')).toEqual({ id: 'x', run: 1, dormant: false })
    markSessionDormant(ws, 'x')
    expect(loadSessionRecord(ws, 'x')).toEqual({ id: 'x', run: 1, dormant: true })
  })
})

describe('SessionRegistry run seeding + stamping', () => {
  it('seeds a NEW session with the given run and stamps it on append; a re-open keeps it', () => {
    const reg = new SessionRegistry()
    reg.open(info('s'), 3)
    expect(reg.runOf('s')).toBe(3)
    const e = reg.append('s', { kind: 'k', run: 0, seq: 0, session: 's', data: null })
    expect(e).toMatchObject({ run: 3, seq: 1 }) // run seeded, seq the authoritative next
    reg.open(info('s'), 9) // idempotent re-open ignores the new run
    expect(reg.runOf('s')).toBe(3)
  })
  it('defaults a new session to run 1 when no run is given', () => {
    const reg = new SessionRegistry()
    reg.open(info('s'))
    expect(reg.runOf('s')).toBe(1)
  })
})

describe('rehydrate seq semantics (inert on resume, continued on crash)', () => {
  it('resume (continueSeq=false): injects the prior run read-only, the new run seq RESTARTS at 1', () => {
    const reg = new SessionRegistry()
    reg.open(info('s'), 2) // resumed into run 2
    reg.rehydrate('s', [{ kind: 'transition', run: 1, seq: 3, session: 's', data: null }], { continueSeq: false })
    // the prior-run event is visible in the log, carrying its OWN (run, seq)
    expect(reg.get('s')!.log.map((e) => [e.run, e.seq])).toEqual([[1, 3]])
    // the new run's first append restarts seq at 1, stamped run 2 — no collision with (1,3)
    expect(reg.append('s', { kind: 'k', run: 0, seq: 0, session: 's', data: null })).toMatchObject({ run: 2, seq: 1 })
  })

  it('crash recovery (continueSeq=true): continues seq from the restored max, same run', () => {
    const reg = new SessionRegistry()
    reg.open(info('s'), 5) // recovered SAME run 5
    reg.rehydrate('s', [{ kind: 'transition', run: 5, seq: 3, session: 's', data: null }], { continueSeq: true })
    expect(reg.append('s', { kind: 'k', run: 0, seq: 0, session: 's', data: null })).toMatchObject({ run: 5, seq: 4 })
  })
})

describe('daemon resume cycle', () => {
  it('fresh open is run 1; a clean close then reopen is run 2, seq restarts', async () => {
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('s1') } as never, conn)
    expect(loadSessionRecord(ws, 's1')).toEqual({ id: 's1', run: 1, dormant: false, harness: 'cc' })
    await observe(daemon, 's1', 'a')
    await observe(daemon, 's1', 'b')
    expect(await runOfLatest(daemon, 's1')).toBe(1)

    await daemon.handle({ kind: 'session-close', id: 2, session: 's1' } as never, conn)
    expect(loadSessionRecord(ws, 's1')).toEqual({ id: 's1', run: 1, dormant: true, harness: 'cc' }) // dormant, run preserved

    await daemon.handle({ kind: 'session-open', id: 3, info: info('s1') } as never, conn) // --resume
    expect(loadSessionRecord(ws, 's1')).toEqual({ id: 's1', run: 2, dormant: false, harness: 'cc' }) // bumped + active
    await observe(daemon, 's1', 'c')
    const run2 = (await traceEvents(daemon, 's1')).filter((x) => x.run === 2)
    expect(run2.length).toBeGreaterThan(0)
    expect(run2[0].seq).toBe(1) // seq RESTARTS in the new run — no collision with run 1
  })

  it('a daemon-CRASH recovery (a non-dormant record) keeps the SAME run', async () => {
    persistSessionRecord(ws, 's2', { id: 's2', run: 5, dormant: false }) // last run never cleanly closed
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('s2') } as never, conn)
    expect(loadSessionRecord(ws, 's2')).toEqual({ id: 's2', run: 5, dormant: false, harness: 'cc' }) // same run, not 6
    await observe(daemon, 's2', 'a')
    expect(await runOfLatest(daemon, 's2')).toBe(5)
  })

  it('the adapter `resume` override bumps the run even on a non-dormant record', async () => {
    persistSessionRecord(ws, 's3', { id: 's3', run: 5, dormant: false })
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('s3', { resume: true }) } as never, conn)
    expect(loadSessionRecord(ws, 's3')).toEqual({ id: 's3', run: 6, dormant: false, harness: 'cc' })
  })

  it('an unrestricted session that emits nothing still records its run (the resume marker)', async () => {
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('s4') } as never, conn)
    // no observe, no governance emit
    expect(loadSessionRecord(ws, 's4')).toEqual({ id: 's4', run: 1, dormant: false, harness: 'cc' })
  })
})

function spyObserver(onRunImpl?: (e: RunLifecycle) => void): { plugin: Plugin; runs: RunLifecycle[] } {
  const runs: RunLifecycle[] = []
  const plugin: Plugin = {
    manifest: { id: 'mcp.spy', name: 'Spy', contractVersion: 0, kind: 'hook', shapes: ['observer'] },
    onEvent: () => {},
    onRun: (e) => {
      runs.push(e)
      onRunImpl?.(e)
    },
  }
  return { plugin, runs }
}

describe('run-lifecycle signals', () => {
  it('a fresh open fires run-start(isResume=false, no priorRun); close fires run-end', async () => {
    const { plugin, runs } = spyObserver()
    const daemon = createDaemon({ workspace: ws, plugins: [plugin] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('r1') } as never, conn)
    expect(runs).toEqual([{ kind: 'run-start', session: 'r1', run: 1, isResume: false }])
    await daemon.handle({ kind: 'session-close', id: 2, session: 'r1' } as never, conn)
    expect(runs.at(-1)).toEqual({ kind: 'run-end', session: 'r1', run: 1 })
  })

  it('a resumed open fires run-start(isResume=true, priorRun)', async () => {
    const { plugin, runs } = spyObserver()
    const daemon = createDaemon({ workspace: ws, plugins: [plugin] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('r2') } as never, conn)
    await daemon.handle({ kind: 'session-close', id: 2, session: 'r2' } as never, conn)
    await daemon.handle({ kind: 'session-open', id: 3, info: info('r2') } as never, conn) // --resume
    expect(runs.at(-1)).toEqual({ kind: 'run-start', session: 'r2', run: 2, isResume: true, priorRun: 1 })
  })

  it('retireSession fires session-retire with the last run, and GCs the store', async () => {
    const { plugin, runs } = spyObserver()
    const daemon = createDaemon({ workspace: ws, plugins: [plugin] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('r3') } as never, conn)
    await daemon.handle({ kind: 'session-close', id: 2, session: 'r3' } as never, conn)
    daemon.retireSession('r3')
    expect(runs.at(-1)).toEqual({ kind: 'session-retire', session: 'r3', lastRun: 1 })
    expect(loadSessionRecord(ws, 'r3')).toBeUndefined() // store GC'd
  })

  it('a throwing onRun is isolated — the session-open still succeeds', async () => {
    const { plugin } = spyObserver(() => {
      throw new Error('boom')
    })
    const daemon = createDaemon({ workspace: ws, plugins: [plugin] })
    const res = await daemon.handle({ kind: 'session-open', id: 1, info: info('r4') } as never, conn)
    expect((res as { kind: string }).kind).toBe('opened')
  })
})

describe('MediationContext surfaces run-lifecycle facts to a mediator at decide', () => {
  // A mediator that captures the run facts it reads at decide time. Composes with
  // PluginManifest.requiresContinuity: the manifest says "I need continuity", these ctx fields
  // say "continuity is degraded THIS run" (au-workflow's observable-absent-resume fail-closed).
  function runProbe(): { plugin: Plugin; seen: { run?: number; isResume?: boolean; priorRun?: number }[] } {
    const seen: { run?: number; isResume?: boolean; priorRun?: number }[] = []
    const plugin: Plugin = {
      manifest: { id: 'mcp.runprobe', name: 'RunProbe', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: (_a, ctx) => {
        seen.push({ run: ctx.run, isResume: ctx.isResume, priorRun: ctx.priorRun })
        return { kind: 'allow' }
      },
    }
    return { plugin, seen }
  }
  const GATE = 'mcp__x__'
  const mediate = (daemon: ReturnType<typeof createDaemon>, session: string) =>
    daemon.handle({ kind: 'mediate', id: 5, session, action: { tool: `${GATE}read_file_pinned`, input: {} } } as never, conn)

  it('a fresh run reports run 1, isResume false, no priorRun', async () => {
    const { plugin, seen } = runProbe()
    const daemon = createDaemon({ workspace: ws, plugins: [plugin] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('m1', { gatePrefix: GATE }) } as never, conn)
    await mediate(daemon, 'm1')
    expect(seen.at(-1)).toEqual({ run: 1, isResume: false, priorRun: undefined })
  })

  it('a resumed run reports the bumped run, isResume true, and the priorRun (mirrors run-start)', async () => {
    const { plugin, seen } = runProbe()
    const daemon = createDaemon({ workspace: ws, plugins: [plugin] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('m2', { gatePrefix: GATE }) } as never, conn)
    await daemon.handle({ kind: 'session-close', id: 2, session: 'm2' } as never, conn)
    await daemon.handle({ kind: 'session-open', id: 3, info: info('m2', { gatePrefix: GATE }) } as never, conn) // --resume
    await mediate(daemon, 'm2')
    expect(seen.at(-1)).toEqual({ run: 2, isResume: true, priorRun: 1 })
  })
})

describe('inert observable replay (the sessionRehydrate seam)', () => {
  const at = '2026-08-08T00:00:00.000Z'
  it('injects OBSERVABLE events read-only and REFUSES governance kinds', async () => {
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('p1') } as never, conn)
    // The adapter supplies IDENTITY-FREE events (its transcript has no run/seq); the kernel stamps.
    const res = daemon.ingestReplay('p1', [
      { kind: 'user_prompt', at, data: { prompt: 'hi' } },
      { kind: 'tool_call', at, data: {} },
      { kind: 'mcp.workflow.transition', at, data: { step: 'x' } }, // plugin GOVERNANCE -> refused
      { kind: 'approval_granted', at, data: {} }, // kernel governance -> refused
      { kind: 'judgment', at, data: {} }, // au-provenance governance -> refused
    ])
    expect(res).toEqual({ injected: 2, refused: 3 })
    const kinds = (await traceEvents(daemon, 'p1')).map((e) => e.kind)
    expect(kinds).toEqual(['user_prompt', 'tool_call']) // only the observable pair, forged governance dropped
  })

  it('KERNEL-STAMPS run=priorRun + a fresh monotonic seq on a resumed replay', async () => {
    persistSessionRecord(ws, 'p2', { id: 'p2', run: 1, dormant: true }) // a dormant session -> resume bumps to run 2
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('p2') } as never, conn)
    daemon.ingestReplay('p2', [
      { kind: 'user_prompt', at, data: { prompt: 'a' } },
      { kind: 'tool_call', at, data: {} },
    ])
    const replayed = (await traceEvents(daemon, 'p2')).filter((e) => e.kind === 'user_prompt' || e.kind === 'tool_call')
    expect(replayed.map((e) => e.run)).toEqual([1, 1]) // the PRIOR run, not the live run (2)
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]) // a fresh monotonic seq, refused kinds consuming none
  })

  it('lands over the wire: a session-rehydrate request injects + tallies', async () => {
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('p3') } as never, conn)
    const res = (await daemon.handle(
      {
        kind: 'session-rehydrate',
        id: 2,
        session: 'p3',
        events: [
          { kind: 'assistant_message', at, data: { blocks: [] } },
          { kind: 'judgment', at, data: {} }, // governance -> refused
        ],
      } as never,
      conn,
    )) as { kind: string; injected: number; refused: number }
    expect(res).toEqual({ kind: 'rehydrated', id: 2, injected: 1, refused: 1 })
    expect((await traceEvents(daemon, 'p3')).map((e) => e.kind)).toEqual(['assistant_message'])
  })

  it('injectReplay never populates the read-views, but IS visible to consultTrace', () => {
    const reg = new SessionRegistry()
    reg.open(info('s'), 2)
    reg.injectReplay('s', [{ kind: 'tool_call', run: 1, seq: 1, session: 's', data: null }])
    expect(reg.get('s')!.readView.size).toBe(0) // safety views stay empty on resume
    expect(reg.get('s')!.servedView.size).toBe(0)
    expect(reg.get('s')!.log.length).toBe(1) // the replayed event IS in the live log for consultTrace
  })
})

describe('concurrency: run bumps once, retire/run-start are mutually exclusive', () => {
  it('concurrent fresh opens of one id bump the run exactly ONCE', async () => {
    const daemon = createDaemon({ workspace: ws })
    await Promise.all([
      daemon.handle({ kind: 'session-open', id: 1, info: info('c1') } as never, conn),
      daemon.handle({ kind: 'session-open', id: 2, info: info('c1') } as never, conn),
    ])
    expect(loadSessionRecord(ws, 'c1')).toEqual({ id: 'c1', run: 1, dormant: false, harness: 'cc' }) // once, not run 2
    expect(daemon.sessionCount()).toBe(1)
  })

  it('concurrent RESUMES of a dormant session bump to run 2 once, not twice', async () => {
    persistSessionRecord(ws, 'c2', { id: 'c2', run: 1, dormant: true })
    const daemon = createDaemon({ workspace: ws })
    await Promise.all([
      daemon.handle({ kind: 'session-open', id: 1, info: info('c2') } as never, conn),
      daemon.handle({ kind: 'session-open', id: 2, info: info('c2') } as never, conn),
    ])
    expect(loadSessionRecord(ws, 'c2')).toEqual({ id: 'c2', run: 2, dormant: false, harness: 'cc' }) // a single bump
  })

  it('retire then open is a FRESH session (run 1); the two do not tear each other', async () => {
    persistSessionRecord(ws, 'c3', { id: 'c3', run: 3, dormant: true })
    const daemon = createDaemon({ workspace: ws })
    daemon.retireSession('c3')
    expect(loadSessionRecord(ws, 'c3')).toBeUndefined() // retire GC'd it
    await daemon.handle({ kind: 'session-open', id: 1, info: info('c3') } as never, conn)
    expect(loadSessionRecord(ws, 'c3')).toEqual({ id: 'c3', run: 1, dormant: false, harness: 'cc' }) // a clean fresh start
  })
})

describe('age-sweep retires a session store as a UNIT (no split)', () => {
  const recDir = (): string => {
    const base = process.env.AU_MCP_RECOVERY_DIR!
    return path.join(base, fs.readdirSync(base)[0])
  }
  const ageSeconds = 100_000 // > 24h, in seconds for utimesSync
  const DAY = 24 * 3600 * 1000

  it('keeps the whole store while its NEWEST file is young, even if the scratch aged out', () => {
    appendRecovery(ws, 'sw1', { kind: 'transition', run: 1, seq: 1, session: 'sw1', data: null })
    persistSessionRecord(ws, 'sw1', { id: 'sw1', run: 1, dormant: true })
    const dir = recDir()
    const scratch = fs.readdirSync(dir).find((f) => f.endsWith('.ndjson'))!
    const old = Date.now() / 1000 - ageSeconds
    fs.utimesSync(path.join(dir, scratch), old, old) // age ONLY the scratch; the record stays fresh
    sweepRetention(ws, { dormantWindowMs: DAY, orphanWindowMs: DAY }, (id) => retire(ws, id))
    expect(loadSessionRecord(ws, 'sw1')).toEqual({ id: 'sw1', run: 1, dormant: true }) // record kept
    expect(loadRecovery(ws, 'sw1').length).toBe(1) // scratch kept too — the store is not split
  })

  it('retires the whole store when EVERY file is old', () => {
    appendRecovery(ws, 'sw2', { kind: 'transition', run: 1, seq: 1, session: 'sw2', data: null })
    persistSessionRecord(ws, 'sw2', { id: 'sw2', run: 1, dormant: true })
    const dir = recDir()
    const old = Date.now() / 1000 - ageSeconds
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old) // age ALL
    sweepRetention(ws, { dormantWindowMs: DAY, orphanWindowMs: DAY }, (id) => retire(ws, id))
    expect(loadSessionRecord(ws, 'sw2')).toBeUndefined()
    expect(loadRecovery(ws, 'sw2')).toEqual([])
  })

  it('ingestReplay reports injected:0 for an absent session (honest tally)', () => {
    const daemon = createDaemon({ workspace: ws })
    const res = daemon.ingestReplay('nope', [{ kind: 'tool_call', at: '2026-08-08T00:00:00.000Z', data: {} }])
    expect(res).toEqual({ injected: 0, refused: 0 })
  })
})

describe('retention — surface, window distinction, control requests', () => {
  const DAY = 24 * 3600 * 1000
  const recDir = (): string => {
    const base = process.env.AU_MCP_RECOVERY_DIR!
    return path.join(base, fs.readdirSync(base)[0])
  }
  const ageAll = (secondsAgo: number): void => {
    const dir = recDir()
    const t = Date.now() / 1000 - secondsAgo
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t)
  }

  it('listSessions surfaces id/run/dormant/size for a persisted session', () => {
    persistSessionRecord(ws, 'l1', { id: 'l1', run: 2, dormant: true })
    const l1 = listSessions(ws).find((s) => s.id === 'l1')!
    expect(l1).toMatchObject({ id: 'l1', run: 2, dormant: true })
    expect(l1.sizeBytes).toBeGreaterThan(0)
    expect(l1.lastActiveMs).toBeGreaterThan(0)
  })

  it('sweepRetention retires an ORPHAN past the short window but keeps a DORMANT one of the same age', () => {
    persistSessionRecord(ws, 'dorm', { id: 'dorm', run: 1, dormant: true })
    persistSessionRecord(ws, 'orph', { id: 'orph', run: 1, dormant: false })
    ageAll(2 * 24 * 3600) // both 2 days old
    const retired = sweepRetention(ws, { dormantWindowMs: 30 * DAY, orphanWindowMs: DAY }, (id) => retire(ws, id))
    expect(retired).toContain('orph')
    expect(retired).not.toContain('dorm')
    expect(loadSessionRecord(ws, 'dorm')).toEqual({ id: 'dorm', run: 1, dormant: true }) // within 30d
    expect(loadSessionRecord(ws, 'orph')).toBeUndefined() // past the 1d orphan window
  })

  it('list-dormant returns DORMANT sessions, not active ones', async () => {
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('active1') } as never, conn) // active -> dormant:false
    persistSessionRecord(ws, 'dormant1', { id: 'dormant1', run: 1, dormant: true })
    const r = (await daemon.handle({ kind: 'list-dormant', id: 2 } as never, conn)) as { sessions: { id: string }[] }
    const ids = r.sessions.map((s) => s.id)
    expect(ids).toContain('dormant1')
    expect(ids).not.toContain('active1')
  })

  it('list-dormant carries the producing adapter + its opaque resumeRef (the resume recipe)', async () => {
    const daemon = createDaemon({ workspace: ws })
    // A session opened by the codex adapter, declaring an opaque relaunch reference.
    await daemon.handle(
      { kind: 'session-open', id: 1, info: info('withref', { harness: 'mcp.adapter.codex', resumeRef: 'codex-home#thread-42', profile: 'reviewer' }) } as never,
      conn,
    )
    await daemon.handle({ kind: 'session-close', id: 2, session: 'withref' } as never, conn)
    const r = (await daemon.handle({ kind: 'list-dormant', id: 3 } as never, conn)) as { sessions: DormantSession[] }
    const s = r.sessions.find((x) => x.id === 'withref')!
    expect(s).toMatchObject({ harness: 'mcp.adapter.codex', resumeRef: 'codex-home#thread-42', profile: 'reviewer' })
  })

  it('list-dormant omits resumeRef for an adapter that supplied none (not adapter-resumable)', async () => {
    const daemon = createDaemon({ workspace: ws })
    await daemon.handle({ kind: 'session-open', id: 1, info: info('noref') } as never, conn) // info() sets no resumeRef
    await daemon.handle({ kind: 'session-close', id: 2, session: 'noref' } as never, conn)
    const r = (await daemon.handle({ kind: 'list-dormant', id: 3 } as never, conn)) as { sessions: DormantSession[] }
    const s = r.sessions.find((x) => x.id === 'noref')!
    expect(s.harness).toBe('cc')
    expect(s.resumeRef).toBeUndefined()
  })

  it('retention-preview lists only the dormant sessions a proposed window would retire', async () => {
    const daemon = createDaemon({ workspace: ws })
    persistSessionRecord(ws, 'oldd', { id: 'oldd', run: 1, dormant: true })
    ageAll(10 * 24 * 3600) // age everything to 10 days
    persistSessionRecord(ws, 'newd', { id: 'newd', run: 1, dormant: true }) // rewrite -> fresh mtime
    const r = (await daemon.handle({ kind: 'retention-preview', id: 1, windowMs: 7 * DAY } as never, conn)) as {
      sessions: { id: string }[]
    }
    const ids = r.sessions.map((s) => s.id)
    expect(ids).toContain('oldd') // 10d past the 7d window
    expect(ids).not.toContain('newd') // fresh
  })

  it('retire-session GCs the store and acks the retired id', async () => {
    const daemon = createDaemon({ workspace: ws })
    persistSessionRecord(ws, 'ret1', { id: 'ret1', run: 1, dormant: true })
    const r = (await daemon.handle({ kind: 'retire-session', id: 1, session: 'ret1' } as never, conn)) as {
      kind: string
      session: string
    }
    expect(r).toEqual({ kind: 'retired', id: 1, session: 'ret1' })
    expect(loadSessionRecord(ws, 'ret1')).toBeUndefined()
  })
})

describe('retention window (the startup sweep honors the resolved window)', () => {
  // The window's SOURCE (au-mcp's scoped-config, resolved in `startDaemon`) is validated against a
  // real engine by the retention verify script; here we cover that `createDaemon` sweeps by whatever
  // window it is handed (`retentionWindowMs`, the same value `startDaemon` passes from scoped-config).
  const DAY = 24 * 3600 * 1000

  it('a 5-day-old dormant session is swept when the window is 1 day', () => {
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-dorm-'))
    process.env.AU_MCP_RECOVERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-dorm-rec-'))
    appendRecovery(w, 'old', { kind: 'transition', run: 1, seq: 1, session: 'old', data: null })
    persistSessionRecord(w, 'old', { id: 'old', run: 1, dormant: true })
    const base = process.env.AU_MCP_RECOVERY_DIR
    const dir = path.join(base, fs.readdirSync(base)[0])
    const fiveDaysAgo = Date.now() / 1000 - 5 * 24 * 3600
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), fiveDaysAgo, fiveDaysAgo)
    createDaemon({ workspace: w, retentionWindowMs: 1 * DAY }) // startup sweep honors the handed window
    expect(loadSessionRecord(w, 'old')).toBeUndefined()
  })
})

describe('set-retention-window verb (validates input + reports the APPLIED window, not the request)', () => {
  const wsTmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-rw-'))

  function configBroker(overrides: Partial<EngineBroker> = {}): { broker: EngineBroker; content: () => string | null } {
    let content: string | null = null
    const broker: EngineBroker = {
      socketPath: '/x',
      available: () => true,
      read: async (op): Promise<EngineFrame> =>
        op === 'config'
          ? { ready: true, result: { path: '/p', exists: content !== null, content, diagnostics: [] } }
          : { ready: true, result: null },
      mutate: async (verb, args): Promise<EngineFrame> => {
        if (verb === 'set_config') {
          content = String((args as { content?: string })?.content ?? '')
          return { ready: true, result: {} }
        }
        return { ready: true, result: {} }
      },
      ...overrides,
    }
    return { broker, content: () => content }
  }

  it('persists a valid window and reports the applied value (re-read, not the request)', async () => {
    const { broker, content } = configBroker()
    const daemon = createDaemon({ workspace: wsTmp(), broker })
    const res = await daemon.handle({ kind: 'set-retention-window', id: 1, windowDays: 7 }, conn)
    expect(res).toMatchObject({ kind: 'retention-config', windowDays: 7 })
    expect(content()).toMatch(/dormancy_days:\s*7/)
    const got = await daemon.handle({ kind: 'retention-config', id: 2 }, conn)
    expect(got).toMatchObject({ windowDays: 7 })
  })

  it('rejects a non-positive / non-integer window at the wire boundary (no false ack)', async () => {
    const { broker } = configBroker()
    const daemon = createDaemon({ workspace: wsTmp(), broker })
    await expect(daemon.handle({ kind: 'set-retention-window', id: 1, windowDays: 0 }, conn)).rejects.toThrow(/positive integer/)
    await expect(daemon.handle({ kind: 'set-retention-window', id: 2, windowDays: 1.5 }, conn)).rejects.toThrow(/positive integer/)
  })

  it('surfaces a rejected write instead of a false success', async () => {
    const { broker } = configBroker({ mutate: async () => ({ type: 'error', message: 'CAS mismatch' }) })
    const daemon = createDaemon({ workspace: wsTmp(), broker })
    await expect(daemon.handle({ kind: 'set-retention-window', id: 1, windowDays: 7 }, conn)).rejects.toThrow(/failed/)
  })
})
