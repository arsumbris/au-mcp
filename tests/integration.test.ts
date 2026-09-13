// Phase 4 integration: an observer + the redirect mediator running inside the daemon's
// orchestration, end to end (events FAN OUT to the installed recorder; a deny is sequenced
// into the kernel's live log).
//
// The kernel is recorder-AGNOSTIC: it stamps every event into its OWN live log (consult-trace
// reads that) and fans a copy to whatever observer is installed. So these tests use a minimal
// local SPY observer, not a real recorder. The on-disk ledger FORMAT is au-provenance's
// concern (the recorder that absorbed au-mcp-trace), proven in au-provenance's own testing/.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { traceEvent, EventKind, type AdapterInfo, type DaemonResponse, type SessionEvent, type Plugin, type SessionStartContext } from '@arsumbris/au-mcp-sdk'
import { createDaemon } from '../src/daemon/daemon.ts'
import { createPluginRegistry } from '../src/daemon/registry.ts'
import { retire } from '../src/daemon/crash-recovery.ts'
import { scopedBroker } from '../src/daemon/discovery.ts'
import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import type { WireConnection } from '../src/wire/server.ts'

const fakeConn = (): WireConnection => ({ send: () => {}, onClose: () => {} })

// Isolate the crash-recovery scratch to a temp dir for EVERY test: the daemon's `emit` path now
// persists governance events, so any mediate-through-the-daemon test would otherwise write to the
// real `$HOME/.arsumbris`. Fresh per test, cleaned after.
let recoveryBase: string
let savedRecoveryEnv: string | undefined
beforeEach(() => {
  savedRecoveryEnv = process.env.AU_MCP_RECOVERY_DIR
  recoveryBase = mkdtempSync(join(tmpdir(), 'au-mcp-rec-'))
  process.env.AU_MCP_RECOVERY_DIR = recoveryBase
})
afterEach(() => {
  if (savedRecoveryEnv === undefined) delete process.env.AU_MCP_RECOVERY_DIR
  else process.env.AU_MCP_RECOVERY_DIR = savedRecoveryEnv
  rmSync(recoveryBase, { recursive: true, force: true })
})

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-int-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

/**
 * A minimal in-test observer. The kernel fans every appended event to whatever observer is
 * installed; this one just collects them. Stands in for a real recorder so these tests assert
 * the daemon's OWN behaviour (fan-out + live log + floors), never a specific ledger format.
 */
function spyObserver(): Plugin & { events: SessionEvent[] } {
  const events: SessionEvent[] = []
  return {
    events,
    manifest: { id: 'mcp.spy', name: 'spy', contractVersion: 0, kind: 'hook', shapes: ['observer'] },
    onEvent: (e: SessionEvent) => { events.push(e) },
  }
}

const info = (ws: string): AdapterInfo => ({
  harness: 'cc',
  session: 's1',
  workspace: ws,
  nativeTools: [{ name: 'Bash', gateEquivalent: 'bash' }],
})

/**
 * A synthetic stand-in for the tool-precondition floor (which now lives in au-mcp-core as the
 * loadable mcp.tool-precondition plugin). It gates ONE tool on `ctx.hasRead(path)`, so these
 * integration tests exercise the KERNEL seam the real floor depends on — a serves-contract call
 * populating the served-view, surfaced via the Phase-4 `ctx.hasRead` accessor — without mounting
 * au-mcp-core. The floor's own deny/allow + map-derivation logic is unit-tested in au-mcp-core.
 */
function readGate(tool: string, path: string): Plugin {
  return {
    manifest: { id: 'mcp.test-readgate', name: 'readgate', contractVersion: 0, kind: 'hook', shapes: ['mediator'], tier: 'floor' },
    decide: (action, ctx) => (action.tool === tool && !ctx.hasRead(path) ? { kind: 'deny', reason: `read ${path} first` } : { kind: 'allow' }),
  }
}

/**
 * A synthetic stand-in for the redirect floor, now the loadable mcp.nativeToolRedirect plugin in
 * au-mcp-core. It denies ONE native tool with a `useInstead` redirect, so these integration
 * tests exercise the KERNEL seam the real floor rides — a deny decision sequenced into the live
 * log as `tool_denied` and fanned to the observer — without mounting au-mcp-core. The floor's own
 * allowlist / gate-prefix logic is unit-tested in au-mcp-core.
 */
function denyGate(tool: string, useInstead: string): Plugin {
  return {
    manifest: { id: 'mcp.test-denygate', name: 'denygate', contractVersion: 0, kind: 'hook', shapes: ['mediator'], tier: 'gate' },
    decide: (action, ctx) => {
      if (action.tool !== tool) return { kind: 'allow' }
      const reason = `use ${useInstead} instead`
      // Emit tool_denied like the real redirect floor, so the daemon sequences it into the live
      // log + fans it to observers — the seam under test.
      ctx.emit(EventKind.ToolDenied, { tool, input: action.input, reason, belt: 'hook' })
      return { kind: 'deny', useInstead, reason }
    },
  }
}

/** A synthetic session-start hook (decision 2609020302): injects one fixed block at open. */
function startHook(id: string, tier: 'gate' | 'floor' | 'policy', text: string): Plugin {
  return {
    manifest: { id, name: id, contractVersion: 0, kind: 'hook', shapes: ['session-start'], tier },
    onSessionStart: () => ({ inject: [text] }),
  }
}

describe('session-start phase through the daemon', () => {
  it('stashes computed inject at the fresh open and returns it via session-start-context', async () => {
    const ws = await tempWorkspace()
    const daemon = createDaemon({ workspace: ws, plugins: [startHook('mcp.s1', 'policy', 'hello from s1')] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())
    const r = await daemon.handle({ kind: 'session-start-context', id: 2, session: 's1' }, fakeConn())
    expect(r).toMatchObject({ kind: 'session-start-context', inject: ['hello from s1'] })
  })

  it('orders session-start inject by tier (gate before policy)', async () => {
    const ws = await tempWorkspace()
    const daemon = createDaemon({
      workspace: ws,
      plugins: [startHook('mcp.late', 'policy', 'late'), startHook('mcp.early', 'gate', 'early')],
    })
    await daemon.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())
    const r = await daemon.handle({ kind: 'session-start-context', id: 2, session: 's1' }, fakeConn())
    expect(r).toMatchObject({ kind: 'session-start-context', inject: ['early', 'late'] })
  })

  it('isolates a throwing session-start hook (the rest still inject)', async () => {
    const ws = await tempWorkspace()
    const boom: Plugin = {
      manifest: { id: 'mcp.boom', name: 'boom', contractVersion: 0, kind: 'hook', shapes: ['session-start'], tier: 'policy' },
      onSessionStart: () => {
        throw new Error('boom')
      },
    }
    const daemon = createDaemon({ workspace: ws, plugins: [boom, startHook('mcp.ok', 'policy', 'ok')] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())
    const r = await daemon.handle({ kind: 'session-start-context', id: 2, session: 's1' }, fakeConn())
    expect(r).toMatchObject({ kind: 'session-start-context', inject: ['ok'] })
  })

  it('runs a session-start hook once PER config instance, in order (registry)', async () => {
    const reg = createPluginRegistry()
    const seen: unknown[] = []
    reg.register({
      manifest: { id: 'mcp.n', name: 'n', contractVersion: 0, kind: 'hook', shapes: ['session-start'], tier: 'policy' },
      onSessionStart: (_ctx, config) => {
        seen.push(config)
        return { inject: [`cfg:${JSON.stringify(config)}`] }
      },
    })
    const configs = new Map<string, unknown[]>([['mcp.n', [{ a: 1 }, { a: 2 }]]])
    const blocks = await reg.sessionStart({} as unknown as SessionStartContext, configs)
    expect(seen).toEqual([{ a: 1 }, { a: 2 }])
    expect(blocks).toEqual(['cfg:{"a":1}', 'cfg:{"a":2}'])
  })

  it('runs a config-less session-start hook once with undefined (registry)', async () => {
    const reg = createPluginRegistry()
    let calls = 0
    let received: unknown = 'unset'
    reg.register({
      manifest: { id: 'mcp.bare', name: 'bare', contractVersion: 0, kind: 'hook', shapes: ['session-start'], tier: 'policy' },
      onSessionStart: (_ctx, config) => {
        calls++
        received = config
        return undefined
      },
    })
    await reg.sessionStart({} as unknown as SessionStartContext, new Map())
    expect(calls).toBe(1)
    expect(received).toBeUndefined()
  })

  it('the `hooks` whitelist selects non-critical hooks; critical always runs; absent = all (registry)', async () => {
    const build = () => {
      const reg = createPluginRegistry()
      const ran: string[] = []
      const ss = (id: string, critical?: boolean) =>
        reg.register({
          manifest: { id, name: id, contractVersion: 0, kind: 'hook', shapes: ['session-start'], tier: 'policy', ...(critical ? { critical: true } : {}) },
          onSessionStart: () => {
            ran.push(id)
            return undefined
          },
        })
      ss('mcp.notice') // non-critical
      ss('mcp.other') // non-critical
      ss('mcp.floor', true) // critical — mandatory
      return { reg, ran }
    }
    const ctx = {} as unknown as SessionStartContext
    const cfgs = new Map<string, unknown[]>()

    // absent whitelist (undefined) -> every hook runs
    const a = build()
    await a.reg.sessionStart(ctx, cfgs, undefined)
    expect(new Set(a.ran)).toEqual(new Set(['mcp.notice', 'mcp.other', 'mcp.floor']))

    // a subset -> those + the critical one; the unlisted non-critical is skipped
    const b = build()
    await b.reg.sessionStart(ctx, cfgs, new Set(['mcp.notice']))
    expect(new Set(b.ran)).toEqual(new Set(['mcp.notice', 'mcp.floor']))

    // an EMPTY whitelist -> only the critical hook runs
    const c = build()
    await c.reg.sessionStart(ctx, cfgs, new Set())
    expect(c.ran).toEqual(['mcp.floor'])
  })

  it('returns [] for a session with no session-start hooks, and for an unknown session', async () => {
    const ws = await tempWorkspace()
    const daemon = createDaemon({ workspace: ws, plugins: [] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())
    const known = await daemon.handle({ kind: 'session-start-context', id: 2, session: 's1' }, fakeConn())
    expect(known).toMatchObject({ kind: 'session-start-context', inject: [] })
    const unknown = await daemon.handle({ kind: 'session-start-context', id: 3, session: 'nope' }, fakeConn())
    expect(unknown).toMatchObject({ kind: 'session-start-context', inject: [] })
  })
})

describe('observer through the daemon', () => {
  it('fans observed events to the installed recorder, seq-stamped in order', async () => {
    const ws = await tempWorkspace()
    const spy = spyObserver()
    const daemon = createDaemon({ workspace: ws, plugins: [spy] })
    await daemon.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())
    await daemon.handle(
      { kind: 'observe', id: 2, session: 's1', event: traceEvent(EventKind.UserPrompt, 's1', { prompt: 'go' }) },
      fakeConn(),
    )
    await daemon.handle(
      { kind: 'observe', id: 3, session: 's1', event: traceEvent(EventKind.ToolStart, 's1', { tool: 'Read' }) },
      fakeConn(),
    )

    expect(spy.events.map((e) => e.kind)).toEqual(['user_prompt', 'tool_start'])
    expect(spy.events.map((e) => e.seq)).toEqual([1, 2]) // daemon-assigned monotonic seq
  })
})

describe('redirect + observer sequenced through the daemon', () => {
  it('denies a native tool, and the daemon-emitted tool_denied reaches the live log + the recorder', async () => {
    const ws = await tempWorkspace()
    const spy = spyObserver()
    const daemon = createDaemon({
      workspace: ws,
      plugins: [spy, denyGate('Bash', 'bash')],
    })
    await daemon.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())

    // A native tool is denied + redirected.
    const denied = await daemon.handle(
      { kind: 'mediate', id: 2, session: 's1', action: { tool: 'Bash', input: { command: 'ls' } } },
      fakeConn(),
    )
    expect(denied).toMatchObject({ kind: 'decision', decision: { kind: 'deny', useInstead: 'bash' } })

    // A gate tool is allowed.
    const allowed = await daemon.handle(
      { kind: 'mediate', id: 3, session: 's1', action: { tool: 'mcp.read_file_pinned', input: {} } },
      fakeConn(),
    )
    expect(allowed).toMatchObject({ kind: 'decision', decision: { kind: 'allow' } })

    // The deny was sequenced into the live log (consult-trace).
    const trace = await daemon.handle({ kind: 'consult-trace', id: 4, session: 's1', query: {} }, fakeConn())
    const events = (trace as Extract<DaemonResponse, { kind: 'trace' }>).slice.events as SessionEvent[]
    expect(events.map((e) => e.kind)).toEqual(['tool_denied'])
    expect(events[0].data).toMatchObject({ tool: 'Bash', reason: expect.stringMatching(/use bash instead/) })

    // ...and fanned out to the recorder (no desync between the live log and what the observer sees).
    const seen = spy.events.find((e) => e.kind === 'tool_denied')
    expect(seen).toBeDefined()
    expect((seen!.data as { tool?: string }).tool).toBe('Bash')
  })
})

// A mediator DENY is recorded through the kernel AND fanned to the observer, no desync (decide ->
// record). The native-tool redirect mediator that used to prove this is now an au-mcp-core plugin
// (mcp.nativeToolRedirect), so a synthetic `denyTool` mediator — producing the SAME ToolDenied shape the
// real floor emits — stands in, exercising the kernel deny-record-fan seam without mounting
// au-mcp-core. The floor's own allow/deny logic is unit-tested in au-mcp-core (tests/native-tool-redirect.test.ts).
describe('a mediator deny is recorded + fanned (decide -> record, no desync)', () => {
  const GATE = 'mcp__x__'
  const denyTool = (tool: string): Plugin => ({
    manifest: { id: 'mcp.test-deny', name: 'deny', contractVersion: 0, kind: 'hook', shapes: ['mediator'], tier: 'gate' },
    decide: (action, ctx) => {
      if (action.tool !== tool) return { kind: 'allow' }
      ctx.emit(EventKind.ToolDenied, { tool: action.tool, input: action.input, reason: 'blocked', belt: 'hook' })
      return { kind: 'deny', reason: 'blocked' }
    },
  })
  const sessionInfo = (ws: string): AdapterInfo => ({
    harness: 'cc', session: 's1', workspace: ws, gatePrefix: GATE,
    nativeTools: [{ name: 'Bash', gateEquivalent: `${GATE}bash` }],
  })
  const mediate = (d: ReturnType<typeof createDaemon>, tool: string) =>
    d.handle({ kind: 'mediate', id: 9, session: 's1', action: { tool, input: {} } }, fakeConn()).then((r) => (r as Extract<DaemonResponse, { kind: 'decision' }>).decision)

  it('a native deny is recorded through the kernel and fanned to the observer', async () => {
    const ws = await tempWorkspace()
    const spy = spyObserver()
    const daemon = createDaemon({ workspace: ws, plugins: [spy, denyTool('Bash')] })
    await daemon.handle({ kind: 'session-open', id: 1, info: sessionInfo(ws) }, fakeConn())

    expect((await mediate(daemon, 'Bash')).kind).toBe('deny') // native denied
    expect((await mediate(daemon, `${GATE}read_file_pinned`)).kind).toBe('allow') // gate allowed

    // the native deny was recorded through the kernel + fanned to the observer (no desync).
    const trace = await daemon.handle({ kind: 'consult-trace', id: 4, session: 's1', query: { kinds: [EventKind.ToolDenied] } }, fakeConn())
    const denies = (trace as Extract<DaemonResponse, { kind: 'trace' }>).slice.events as SessionEvent[]
    expect(denies).toHaveLength(1)
    const seen = spy.events.find((e) => e.kind === 'tool_denied')
    expect(seen).toBeDefined()
    expect((seen!.data as { tool?: string }).tool).toBe('Bash')
  })
})

// The read-precondition SEAM end to end (decision 2607030037): a serves-contract call (au_guide)
// registers the served file into the session served-view (no engine needed — derived from the
// observed tool name + input), and that surfaces through the Phase-4 `ctx.hasRead` accessor. That
// is exactly what the tool-precondition floor (now an au-mcp-core plugin) reads. A synthetic
// `readGate` mediator stands in for the real floor, so this exercises the KERNEL half
// (serves -> served-view -> ctx.hasRead) without mounting au-mcp-core. Serves are set on the
// registry directly (discovery's job in prod); the floor's own logic is unit-tested in au-mcp-core.
describe('serves-contract -> served-view -> ctx.hasRead, end to end', () => {
  const GATE = 'mcp__x__'
  const gated = (ws: string): AdapterInfo => ({ harness: 'cc', session: 's1', workspace: ws, gatePrefix: GATE, nativeTools: [] })
  const mediate = (d: ReturnType<typeof createDaemon>, tool: string, input: unknown = {}) =>
    d.handle({ kind: 'mediate', id: 9, session: 's1', action: { tool, input } }, fakeConn()).then((r) => (r as Extract<DaemonResponse, { kind: 'decision' }>).decision)

  it('an au_guide serves-contract call satisfies a read-gated tool (served-view -> ctx.hasRead)', async () => {
    const ws = await tempWorkspace()
    const pkg = realpathSync(ws)
    await mkdir(join(pkg, 'guides'), { recursive: true })
    const guide = join(pkg, 'guides', 'schema-induction.md')
    await writeFile(guide, '---\nscenario: schema-induction\n---\nbody\n')

    const daemon = createDaemon({ workspace: ws, plugins: [spyObserver(), readGate(`${GATE}dry_run_type`, guide)] })
    daemon.registry.setServes(new Map([['au_guide', { pathTemplate: 'guides/{scenario}.md', packageRoot: pkg }]]))
    await daemon.handle({ kind: 'session-open', id: 1, info: gated(ws) }, fakeConn())

    // Before serving: the read-gated tool is denied (guide unread).
    const before = await mediate(daemon, `${GATE}dry_run_type`)
    expect(before.kind).toBe('deny')

    // A different tool is unaffected by the gate.
    expect((await mediate(daemon, `${GATE}read_file_pinned`)).kind).toBe('allow')

    // Observe an au_guide call -> the serves-contract registers the guide into the served-view.
    await daemon.handle(
      { kind: 'observe', id: 2, session: 's1', event: traceEvent(EventKind.ToolCall, 's1', { tool: `${GATE}au_guide`, input: { scenario: 'schema-induction' } }) },
      fakeConn(),
    )

    // After serving: ctx.hasRead(guide) is now true, so the gate allows.
    expect((await mediate(daemon, `${GATE}dry_run_type`)).kind).toBe('allow')

    // A task-map call (no scenario) serves nothing -> a fresh session stays denied.
    const daemon2 = createDaemon({ workspace: ws, plugins: [spyObserver(), readGate(`${GATE}dry_run_type`, guide)] })
    daemon2.registry.setServes(new Map([['au_guide', { pathTemplate: 'guides/{scenario}.md', packageRoot: pkg }]]))
    await daemon2.handle({ kind: 'session-open', id: 1, info: { ...gated(ws), session: 's2' } }, fakeConn())
    await daemon2.handle(
      { kind: 'observe', id: 2, session: 's2', event: traceEvent(EventKind.ToolCall, 's2', { tool: `${GATE}au_guide`, input: {} }) },
      fakeConn(),
    )
    const stillDenied = await daemon2.handle({ kind: 'mediate', id: 3, session: 's2', action: { tool: `${GATE}dry_run_type`, input: {} } }, fakeConn())
    expect((stillDenied as Extract<DaemonResponse, { kind: 'decision' }>).decision.kind).toBe('deny')
  })
})

// The trace gate is RETIRED: capture is always-on substrate. Every event stamps into the
// in-memory log (consult-trace) AND fans out to observers UNCONDITIONALLY; the served-view that
// satisfies a precondition is populated the same way. Whether an observer PERSISTS is its own
// concern (au-provenance's recorder), not a kernel gate.
describe('observer fan-out is unconditional (trace gate retired); floors + served-view + consult-trace work', () => {
  const GATE = 'mcp__x__'
  it('the observer is fanned to unconditionally, and au_guide serves + consult-trace sees it', async () => {
    const ws = await tempWorkspace()
    const pkg = realpathSync(ws)
    await mkdir(join(pkg, 'guides'), { recursive: true })
    await writeFile(join(pkg, 'guides', 'schema-induction.md'), 'body\n')
    const guide = join(pkg, 'guides', 'schema-induction.md')

    const spy = spyObserver()
    const daemon = createDaemon({ workspace: ws, plugins: [spy, readGate(`${GATE}dry_run_type`, guide)] })
    daemon.registry.setServes(new Map([['au_guide', { pathTemplate: 'guides/{scenario}.md', packageRoot: pkg }]]))
    const info: AdapterInfo = { harness: 'cc', session: 's1', workspace: ws, gatePrefix: GATE, nativeTools: [] }
    await daemon.handle({ kind: 'session-open', id: 1, info }, fakeConn())

    // Observe an au_guide call.
    await daemon.handle(
      { kind: 'observe', id: 2, session: 's1', event: traceEvent(EventKind.ToolCall, 's1', { tool: `${GATE}au_guide`, input: { scenario: 'schema-induction' } }) },
      fakeConn(),
    )

    // The observer WAS fanned to — capture always fans out (the trace gate is retired); whether an
    // observer PERSISTS is its own concern (au-provenance's recorder), not a kernel gate.
    expect(spy.events).toHaveLength(1)

    // ...but the served-view WAS populated: the read-gated tool (via ctx.hasRead) is now satisfied.
    const decision = await daemon.handle({ kind: 'mediate', id: 3, session: 's1', action: { tool: `${GATE}dry_run_type`, input: {} } }, fakeConn())
    expect((decision as Extract<DaemonResponse, { kind: 'decision' }>).decision.kind).toBe('allow')

    // ...and the in-memory log still has the event (consult-trace works with trace off).
    const trace = await daemon.handle({ kind: 'consult-trace', id: 4, session: 's1', query: { kinds: [EventKind.ToolCall] } }, fakeConn())
    expect((trace as Extract<DaemonResponse, { kind: 'trace' }>).slice.events).toHaveLength(1)
  })
})

describe('tool ACCESS is the tool\'s own declaration, independent of visibility', () => {
  // A fake unscoped engine broker whose mutate succeeds, so a denial would be observably
  // the scoping rather than the engine.
  const unscoped = (): EngineBroker => ({
    socketPath: '/x',
    available: () => true,
    read: async (): Promise<EngineFrame> => ({ type: 'response', ready: true, result: 'R' }),
    mutate: async (): Promise<EngineFrame> => ({ ready: true, result: 'M' }),
  })

  // A loaded tool `mcp.rw` scoped to its DECLARED read-write request, exactly as discovery
  // builds it. Its engine access does not vary by caller; only its visibility does.
  const rwPlugin = () => {
    const broker = scopedBroker(unscoped(), 'read-write')!
    return {
      manifest: { id: 'mcp.rw', name: 'rw', contractVersion: 0, kind: 'tool' as const },
      invoke: async () => ({ content: { mutateDenied: (await broker.mutate('write_file'))?.type === 'error' } }),
    }
  }

  it('keeps a tool at its declared access when invoked', async () => {
    // Visibility (the profile's `tools`) governs WHETHER a session reaches a tool, never what the
    // tool may do — its engine access is its own def declaration. An unrestricted invoke reaches rw,
    // and rw's mutate succeeds because its access is read-write regardless of any allowlist.
    const ws = await tempWorkspace()
    const daemon = createDaemon({ workspace: ws, plugins: [rwPlugin()] })

    const result = await daemon
      .handle({ kind: 'invoke', id: 3, tool: 'mcp.rw', input: {} }, fakeConn())
      .then((r) => (r as { result: unknown }).result)
    expect(result).toEqual({ mutateDenied: false })
  })
  // Visibility hiding/refusing (the profile `tools` allowlist) is covered at the daemon level
  // (daemon.test.ts: advertise-from-profile + the session invoke gate) and end to end in the
  // au-mcp-adapter-cc allowlist e2e. This block only pins the ACCESS-vs-visibility separation.
})

// accessOf surfaces the pending action's DECLARED access at decide (name-free "does this
// mutate?"), so a guard covers the write-capable CLASS without a verb table. Resolved off the
// target tool's manifest, gate-prefix stripped — core mutators are read-write, engine reads
// are read, a native tool with no manifest is undefined.
describe('MediationContext.accessOf classifies the pending action', () => {
  it('resolves declared tool access + native tools name-free at decide', async () => {
    const ws = await tempWorkspace()
    const seen: Record<string, string | undefined> = {}
    const probe: Plugin = {
      manifest: { id: 'mcp.probe', name: 'probe', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: (action, ctx) => { seen[action.tool] = ctx.accessOf(action); return { kind: 'allow' } },
    }
    // Explicit callables with a DECLARED access, so accessOf is tested name-free off the manifest,
    // decoupled from which tools ship where (file ops + engine reads are now loadable in au-mcp-core).
    const rw: Plugin = { manifest: { id: 'mcp.rw', name: 'rw', contractVersion: 0, kind: 'tool', access: 'read-write' }, invoke: async () => ({ content: '' }) }
    const ro: Plugin = { manifest: { id: 'mcp.ro', name: 'ro', contractVersion: 0, kind: 'tool', access: 'read' }, invoke: async () => ({ content: '' }) }
    const daemon = createDaemon({ workspace: ws, plugins: [rw, ro, probe] })
    const GATE = 'mcp__x__'
    await daemon.handle({ kind: 'session-open', id: 1, info: { harness: 'cc', session: 's1', workspace: ws, gatePrefix: GATE, nativeTools: [] } }, fakeConn())
    const mediate = (tool: string) => daemon.handle({ kind: 'mediate', id: 2, session: 's1', action: { tool, input: {} } }, fakeConn())
    await mediate(`${GATE}rw`)    // declared read-write -> the covered mutate class
    await mediate(`${GATE}ro`)    // declared read -> read
    await mediate('Bash')         // native, no manifest -> undefined

    expect(seen[`${GATE}rw`]).toBe('read-write')
    expect(seen[`${GATE}ro`]).toBe('read')
    expect(seen['Bash']).toBeUndefined()
  })
})

// The per-session channel a LOADABLE mediator lacks by construction (built once per daemon):
// its session id, the launch/governance facts the built-in floors close over, and its OWN
// per-session config set at launch (AdapterInfo.pluginConfig, keyed by plugin id).
describe('MediationContext surfaces session id + launch state + per-session plugin config', () => {
  it('a loadable mediator reads the launch facts + its typed hookConfig accessor', async () => {
    const ws = await tempWorkspace()
    let seen: { session?: string; config?: unknown; gatePrefix?: string; nativeToolAllowlist?: string[] } = {}
    const probe: Plugin = {
      manifest: { id: 'mcp.probe', name: 'probe', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: (_action, ctx) => {
        // Per-hook config rides ctx.hookConfig now (decision 2609021429), not launch.config (retired).
        // With no active profile, it resolves to undefined; the launch facts still reach the mediator.
        // nativeToolAllowlist is now resolved DAEMON-SIDE from the active profile (no AU_MCP_NATIVE_TOOLS
        // env); with no profile it is undefined (every native tool allowed). The parse is unit-tested
        // in session-scope.test.ts (parseProfileNativeToolAllowlist).
        seen = { session: ctx.session, config: ctx.hookConfig?.('mcp.probe'), gatePrefix: ctx.launch.gatePrefix, nativeToolAllowlist: ctx.launch.nativeToolAllowlist }
        return { kind: 'allow' }
      },
    }
    const daemon = createDaemon({ workspace: ws, plugins: [probe] })
    const GATE = 'mcp__x__'
    await daemon.handle({ kind: 'session-open', id: 1, info: {
      harness: 'cc', session: 's7', workspace: ws, gatePrefix: GATE, nativeTools: [],
    } }, fakeConn())
    await daemon.handle({ kind: 'mediate', id: 2, session: 's7', action: { tool: `${GATE}read_file_pinned`, input: {} } }, fakeConn())

    expect(seen.session).toBe('s7')
    expect(seen.config).toBeUndefined() // no active profile -> no hookConfig
    expect(seen.gatePrefix).toBe(GATE)
    expect(seen.nativeToolAllowlist).toBeUndefined() // no active profile -> unrestricted (profile-sourced now)
  })
})

// Crash recovery: a daemon death loses the in-memory log, so a step-gate would read "no workflow"
// and fail OPEN (the D2 hole). The kernel persists the mediator-EMITTED (governance) events to an
// out-of-workspace scratch, rehydrated on the first session-open after a restart. Reconnects need
// nothing (the session persists); only a true process death reaches here. Emitted-ONLY, so an
// observed event is not recovered, and the scratch is GC'd on session-close.
describe('crash recovery of governed step-state across a daemon restart', () => {
  // A step-gate-like mediator: emits an un-forgeable transition on each decide (emit is mediator-only).
  const stepGate = (): Plugin => ({
    manifest: { id: 'mcp.stepgate', name: 'stepgate', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
    decide: (_a, ctx) => { ctx.emit('mcp.workflow.transition', { step: 'review' }); return { kind: 'allow' } },
  })
  const info = (ws: string) => ({ harness: 'cc' as const, session: 'sr', workspace: ws, gatePrefix: 'mcp__x__', nativeTools: [] })
  const kindsAfterRestart = async (ws: string): Promise<string[]> => {
    // A brand-new daemon over the same workspace = the daemon died + restarted.
    const d2 = createDaemon({ workspace: ws, plugins: [stepGate()] })
    await d2.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn()) // fresh open -> rehydrate
    const trace = await d2.handle({ kind: 'consult-trace', id: 4, session: 'sr', query: {} }, fakeConn())
    return (trace as Extract<DaemonResponse, { kind: 'trace' }>).slice.events.map((e) => e.kind)
  }

  it('rehydrates the emitted transitions (not the observed events) into a fresh daemon', async () => {
    const ws = await tempWorkspace()
    const d1 = createDaemon({ workspace: ws, plugins: [stepGate()] })
    await d1.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())
    // An OBSERVED event (agent action) — NOT emitted, so it must NOT be persisted.
    await d1.handle({ kind: 'observe', id: 2, session: 'sr', event: traceEvent(EventKind.ToolCall, 'sr', { tool: 'x' }) }, fakeConn())
    // A mediate -> the step-gate EMITS a transition -> persisted to the scratch.
    await d1.handle({ kind: 'mediate', id: 3, session: 'sr', action: { tool: 'mcp__x__read_file_pinned', input: {} } }, fakeConn())

    const kinds = await kindsAfterRestart(ws)
    expect(kinds).toContain('mcp.workflow.transition') // the governance event recovered -> step re-derives, no fail-open
    expect(kinds).not.toContain('tool_call') // observed events are NOT persisted (governance-only scratch)
  })

  it('KEEPS the governance across a clean close (dormant), and only RETIRE clears it', async () => {
    const ws = await tempWorkspace()
    const d1 = createDaemon({ workspace: ws, plugins: [stepGate()] })
    await d1.handle({ kind: 'session-open', id: 1, info: info(ws) }, fakeConn())
    await d1.handle({ kind: 'mediate', id: 2, session: 'sr', action: { tool: 'mcp__x__read_file_pinned', input: {} } }, fakeConn())
    await d1.handle({ kind: 'session-close', id: 3, session: 'sr' }, fakeConn()) // DORMANT, not cleared

    // A clean close leaves the session dormant: the governance survives, so a resume recovers it.
    expect(await kindsAfterRestart(ws)).toContain('mcp.workflow.transition')

    // RETIRE clears the whole store: a later open recovers nothing.
    retire(ws, 'sr')
    expect(await kindsAfterRestart(ws)).not.toContain('mcp.workflow.transition')
  })
})
