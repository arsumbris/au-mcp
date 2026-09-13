import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AdapterInfo, Plugin } from '@arsumbris/au-mcp-sdk'
import type { WireConnection } from '../src/wire/server.ts'
import { createDaemon } from '../src/daemon/daemon.ts'

// Session CONTINUITY REQUIREMENTS (2b): a resume that LOST its durable state hides an OPTIONAL
// continuity-needing capability's tools, and fails a MANDATORY one closed (no writes). Mandatory =
// the capability SELF-DESCRIBES `critical && requiresContinuity` (queried from the mounted set), NOT
// a per-launch `require` list (decision 2608092020). No engine needed — synthetic plugins + the
// in-memory daemon exercise the gates directly.

const conn: WireConnection = { send: () => {}, onClose: () => {} }
const GATE = 'mcp__au__'
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-cont-'))

const ORIG = process.env.AU_MCP_RECOVERY_DIR
beforeEach(() => {
  process.env.AU_MCP_RECOVERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-cont-rec-'))
})
afterEach(() => {
  if (ORIG === undefined) delete process.env.AU_MCP_RECOVERY_DIR
  else process.env.AU_MCP_RECOVERY_DIR = ORIG
})

// A continuity-needing OPTIONAL tool: `requiresContinuity` but NOT `critical` -> Tier 1 (hide only).
const needy: Plugin = {
  manifest: { id: 'mcp.needy', name: 'Needy', contractVersion: 0, kind: 'tool', requiresContinuity: true, provenance: 'test-cap', access: 'none' },
  invoke: async () => ({ content: 'ok' }),
}
// A MANDATORY continuity-needing capability: `critical && requiresContinuity` -> Tier 2 (write-block)
// on a lost resume. Self-described; nothing at launch names it.
const mandatory: Plugin = {
  manifest: { id: 'mcp.mandatory', name: 'Mandatory', contractVersion: 0, kind: 'tool', requiresContinuity: true, critical: true, provenance: 'mandatory-cap', access: 'none' },
  invoke: async () => ({ content: 'ok' }),
}
// A plain mutator (a write), no continuity requirement — the Tier-2 target.
const writer: Plugin = {
  manifest: { id: 'mcp.writer', name: 'Writer', contractVersion: 0, kind: 'tool', access: 'read-write' },
  invoke: async () => ({ content: 'wrote' }),
}
// A plain reader (non-mutator) — must stay allowed even under a Tier-2 block.
const reader: Plugin = {
  manifest: { id: 'mcp.reader', name: 'Reader', contractVersion: 0, kind: 'tool', access: 'read' },
  invoke: async () => ({ content: 'read' }),
}

const daemon = (plugins: Plugin[] = [needy, writer, reader]) => createDaemon({ workspace: ws, plugins })
const info = (session: string, extra: Partial<AdapterInfo> = {}): AdapterInfo => ({
  harness: 'cc',
  session,
  workspace: ws,
  gatePrefix: GATE,
  nativeTools: [],
  ...extra,
})
const open = (d: ReturnType<typeof daemon>, i: AdapterInfo) => d.handle({ kind: 'session-open', id: 'o', info: i } as never, conn)
const caps = async (d: ReturnType<typeof daemon>, session: string): Promise<string[]> =>
  ((await d.handle({ kind: 'list-capabilities', id: 'l', session } as never, conn)) as { callables: { id: string }[] }).callables.map((c) => c.id)
const invoke = (d: ReturnType<typeof daemon>, session: string, tool: string) =>
  d.handle({ kind: 'invoke', id: 'i', session, tool, input: {} } as never, conn) as Promise<{ isError?: boolean; result: unknown }>
const mediate = (d: ReturnType<typeof daemon>, session: string, tool: string) =>
  d.handle({ kind: 'mediate', id: 'm', session, action: { tool, input: {} } } as never, conn) as Promise<{ decision: { kind: string; reason?: string } }>

describe('continuity — detection', () => {
  it('a resume with NO durable record is continuity-lost; a fresh open is not', async () => {
    const d = daemon()
    await open(d, info('lost', { resume: true })) // asserts resume, no record -> lost
    await open(d, info('fresh')) // no resume -> not lost
    // Effect-tested: the needy tool is hidden for 'lost', visible for 'fresh'.
    expect(await caps(d, 'lost')).not.toContain('mcp.needy')
    expect(await caps(d, 'fresh')).toContain('mcp.needy')
  })
})

describe('continuity — Tier 1 (optional capability lost)', () => {
  it('hides the tool from the advertise and denies a direct call', async () => {
    const d = daemon()
    await open(d, info('lost', { resume: true }))
    expect(await caps(d, 'lost')).not.toContain('mcp.needy')
    expect(await caps(d, 'lost')).toContain('mcp.writer') // other tools unaffected
    const inv = await invoke(d, 'lost', 'mcp.needy')
    expect(inv.isError).toBe(true)
    expect(String(inv.result)).toMatch(/continuity/i)
  })

  it('leaves the tool available on a not-lost session', async () => {
    const d = daemon()
    await open(d, info('fresh'))
    expect(await caps(d, 'fresh')).toContain('mcp.needy')
    expect((await invoke(d, 'fresh', 'mcp.needy')).isError).toBeUndefined()
  })
})

describe('continuity — Tier 2 (mandatory capability lost)', () => {
  it('blocks writes session-wide but keeps reads, when a mandatory (critical) capability is lost', async () => {
    const d = daemon([mandatory, writer, reader])
    await open(d, info('lost', { resume: true })) // mandatory-cap is mounted + self-critical; no launch arg
    // a write (mutator) is denied at mediate with the recovery notice...
    const mw = await mediate(d, 'lost', `${GATE}writer`)
    expect(mw.decision.kind).toBe('deny')
    expect(mw.decision.reason).toMatch(/saved state was cleaned up/i)
    expect(mw.decision.reason).toMatch(/mandatory-cap/) // names the self-described capability, not a launch list
    // ...and at invoke (defense in depth)
    expect((await invoke(d, 'lost', 'mcp.writer')).isError).toBe(true)
    // a read is still allowed
    const mr = await mediate(d, 'lost', `${GATE}reader`)
    expect(mr.decision.kind).not.toBe('deny')
    expect((await invoke(d, 'lost', 'mcp.reader')).isError).toBeUndefined()
  })

  it('does NOT block a fresh session on the same workspace (capability functions from the start)', async () => {
    const d = daemon([mandatory, writer, reader])
    await open(d, info('fresh')) // not lost
    const mw = await mediate(d, 'fresh', `${GATE}writer`)
    expect(mw.decision.kind).not.toBe('deny')
    expect((await invoke(d, 'fresh', 'mcp.writer')).isError).toBeUndefined()
  })

  it('does NOT block when the lost capability is optional, not critical (stays Tier 1)', async () => {
    const d = daemon([needy, writer, reader]) // needy needs continuity but is NOT critical
    await open(d, info('lost', { resume: true }))
    const mw = await mediate(d, 'lost', `${GATE}writer`)
    expect(mw.decision.kind).not.toBe('deny') // writes flow; only mcp.needy is hidden
  })
})
