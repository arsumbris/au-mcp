import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AdapterInfo, DaemonResponse, SessionEvent, TraceQuery } from '@arsumbris/au-mcp-sdk'
import { createDaemon, type Daemon } from '../src/daemon/daemon.ts'
import type { WireConnection } from '../src/wire/server.ts'

// A REAL workspace dir (socketPath realpaths the entry) + per-test crash-recovery isolation, so
// session-open in the describe's beforeEach never rehydrates a stale scratch ledger for s1 (the
// flaky seq mismatches). This file-level beforeEach runs BEFORE the describe's. See todo 2607281308.
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-trace-'))
const ORIG_REC = process.env.AU_MCP_RECOVERY_DIR
beforeEach(() => {
  process.env.AU_MCP_RECOVERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-rec-'))
})
afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true })
  if (ORIG_REC === undefined) delete process.env.AU_MCP_RECOVERY_DIR
  else process.env.AU_MCP_RECOVERY_DIR = ORIG_REC
})

const fakeConn = (): WireConnection => ({ send: () => {}, onClose: () => {} })
const info: AdapterInfo = { harness: 'cc', session: 's1', workspace: ws, nativeTools: [] }
const ev = (kind: string): SessionEvent => ({ kind, run: 0, seq: 0, session: 's1', data: null })

let daemon: Daemon
let id = 0
const next = () => ++id

async function observe(kind: string) {
  await daemon.handle({ kind: 'observe', id: next(), session: 's1', event: ev(kind) }, fakeConn())
}
async function consult(query: TraceQuery) {
  const res = await daemon.handle({ kind: 'consult-trace', id: next(), session: 's1', query }, fakeConn())
  return (res as Extract<DaemonResponse, { kind: 'trace' }>).slice
}

describe('consult-trace TraceQuery filter', () => {
  beforeEach(async () => {
    id = 0
    daemon = createDaemon({ workspace: ws, plugins: [] })
    await daemon.handle({ kind: 'session-open', id: next(), info }, fakeConn())
    // seq: 1 user_prompt, 2 tool_start, 3 tool_end, 4 user_prompt, 5 tool_start, 6 tool_denied
    for (const k of ['user_prompt', 'tool_start', 'tool_end', 'user_prompt', 'tool_start', 'tool_denied']) {
      await observe(k)
    }
  })

  it('returns the whole log with headSeq on an empty query', async () => {
    const slice = await consult({})
    expect(slice.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(slice.headSeq).toBe(6)
  })

  it('sinceSeq returns events at or after the seq', async () => {
    const slice = await consult({ sinceSeq: 4 })
    expect(slice.events.map((e) => e.seq)).toEqual([4, 5, 6])
  })

  it('kinds filters to the given event kinds', async () => {
    const slice = await consult({ kinds: ['tool_start'] })
    expect(slice.events.map((e) => e.seq)).toEqual([2, 5])
  })

  it('thisTurn returns events since the last user_prompt', async () => {
    const slice = await consult({ thisTurn: true })
    expect(slice.events.map((e) => e.kind)).toEqual(['user_prompt', 'tool_start', 'tool_denied'])
    expect(slice.events.map((e) => e.seq)).toEqual([4, 5, 6])
  })

  it('limit keeps the most recent N', async () => {
    const slice = await consult({ limit: 2 })
    expect(slice.events.map((e) => e.seq)).toEqual([5, 6])
  })

  it('filters compose (thisTurn AND kinds)', async () => {
    const slice = await consult({ thisTurn: true, kinds: ['tool_start', 'tool_denied'] })
    expect(slice.events.map((e) => e.seq)).toEqual([5, 6])
  })
})

describe('observe idempotency (dedupeKey)', () => {
  beforeEach(async () => {
    id = 0
    daemon = createDaemon({ workspace: ws, plugins: [] })
    await daemon.handle({ kind: 'session-open', id: next(), info }, fakeConn())
  })

  const observeKeyed = (kind: string, dedupeKey?: string) =>
    daemon.handle(
      {
        kind: 'observe',
        id: next(),
        session: 's1',
        event: { kind, run: 0, seq: 0, session: 's1', data: null, ...(dedupeKey ? { dedupeKey } : {}) },
      },
      fakeConn(),
    )

  it('records an event with a fresh dedupeKey once', async () => {
    await observeKeyed('assistant_message', 'u1')
    const slice = await consult({})
    expect(slice.events.map((e) => e.kind)).toEqual(['assistant_message'])
  })

  it('drops a second observe of a seen dedupeKey (no append, no seq consumed)', async () => {
    await observeKeyed('assistant_message', 'u1')
    await observeKeyed('assistant_message', 'u1')
    const slice = await consult({})
    expect(slice.events.length).toBe(1)
    expect(slice.headSeq).toBe(1) // the duplicate never advanced seq
  })

  it('records distinct dedupeKeys separately', async () => {
    await observeKeyed('assistant_message', 'u1')
    await observeKeyed('assistant_message', 'u2')
    const slice = await consult({})
    expect(slice.events.length).toBe(2)
  })

  it('never dedupes events without a dedupeKey', async () => {
    await observeKeyed('tool_call')
    await observeKeyed('tool_call')
    const slice = await consult({})
    expect(slice.events.length).toBe(2)
  })

  it('seeds the seen-set from a resume replay, so a re-lift of the same key no-ops', async () => {
    // The adapter replays the prior conversation on --resume; its keys seed the seen-set.
    await daemon.handle(
      { kind: 'session-rehydrate', id: next(), session: 's1', events: [{ kind: 'assistant_message', data: null, dedupeKey: 'u1' }] },
      fakeConn(),
    )
    // A subsequent live re-lift of that same event (same dedupeKey) must not re-record it.
    await observeKeyed('assistant_message', 'u1')
    const slice = await consult({})
    // Only the inert replayed copy is in the log; the observe no-opped.
    expect(slice.events.filter((e) => e.kind === 'assistant_message').length).toBe(1)
  })
})
