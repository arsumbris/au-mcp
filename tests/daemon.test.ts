import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  AdapterInfo,
  ClientRequest,
  DaemonResponse,
  MediationContext,
  Plugin,
  PluginManifest,
  SessionEvent,
} from '@arsumbris/au-mcp-sdk'
import { createDaemon } from '../src/daemon/daemon.ts'
import type { EngineBroker } from '../src/daemon/broker.ts'
import type { WireConnection } from '../src/wire/server.ts'

// A REAL workspace dir: `socketPath()` realpath-resolves the entry, so a bare literal like
// `/tmp/ws` throws ENOENT when absent (todo 2607281308). One per file is enough for createDaemon
// (no socket bound). Crash-recovery scratch is isolated PER TEST below, so tests sharing this ws +
// session can't bleed a persisted ledger into each other's rehydrate (the flaky 2-9 failures).
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-daemon-'))
const ORIG_REC = process.env.AU_MCP_RECOVERY_DIR
beforeEach(() => {
  process.env.AU_MCP_RECOVERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-rec-'))
})
afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true })
  if (ORIG_REC === undefined) delete process.env.AU_MCP_RECOVERY_DIR
  else process.env.AU_MCP_RECOVERY_DIR = ORIG_REC
})

/** A throwaway WireConnection (each call models a fresh short-lived hook process). */
function fakeConn(): WireConnection {
  return { send: () => {}, onClose: () => {} }
}

const info: AdapterInfo = {
  harness: 'cc',
  session: 's1',
  workspace: ws,
  nativeTools: [{ name: 'Bash' }],
}

function event(kind: string): SessionEvent {
  return { kind, run: 0, seq: 0, session: 's1', data: null }
}

describe('daemon core', () => {
  it('handshakes on session-open with the contract version', async () => {
    const daemon = createDaemon({ workspace: ws })
    const res = await daemon.handle({ kind: 'session-open', id: 1, info }, fakeConn())
    expect(res.kind).toBe('opened')
    expect((res as Extract<DaemonResponse, { kind: 'opened' }>).contractVersion).toBe(0)
    expect(daemon.sessionCount()).toBe(1)
  })

  it('rejects requests for an unknown session', async () => {
    const daemon = createDaemon({ workspace: ws })
    const req: ClientRequest = {
      kind: 'observe',
      id: 1,
      session: 'nope',
      event: event('x'),
    }
    await expect(daemon.handle(req, fakeConn())).rejects.toThrow(/unknown session/)
  })

  it('allows by default when no mediators are loaded', async () => {
    const daemon = createDaemon({ workspace: ws })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info }, conn)
    const res = await daemon.handle(
      { kind: 'mediate', id: 2, session: 's1', action: { tool: 'Bash', input: {} } },
      conn,
    )
    expect(res).toEqual({ kind: 'decision', id: 2, decision: { kind: 'allow' } })
  })

  it('hands a mediator a read-only engine broker in its MediationContext', async () => {
    // Phase 3.1 (plan 2608012141): a loadable mediator (the provenance guard, the
    // workflow type-gate) needs engine reads to inform its decision. It gets a READ-ONLY
    // broker — a mediator decides, never mutates.
    let seen: MediationContext | undefined
    const probe: Plugin = {
      manifest: { id: 'mcp.probe', name: 'probe', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: (_action, ctx) => {
        seen = ctx
        return { kind: 'allow' }
      },
    }
    // A REAL workspace dir: createEngineBroker realpaths the entry to derive the socket
    // path, so a non-existent path throws at construction (todo 2607281308). An existing
    // dir with no socket gives a broker that constructs and reports available() === false.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-mediator-broker-'))
    const daemon = createDaemon({ workspace: ws, plugins: [probe] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info }, conn)
    await daemon.handle(
      { kind: 'mediate', id: 2, session: 's1', action: { tool: 'Bash', input: {} } },
      conn,
    )
    // The broker handle is present with the read surface.
    expect(seen?.broker).toBeDefined()
    expect(typeof seen?.broker?.read).toBe('function')
    expect(typeof seen?.broker?.available).toBe('function')
    // No engine for the temp ws — the read-only view is still handed over, reporting unavailable.
    expect(seen?.broker?.available()).toBe(false)
    // Mutation is DENIED for a mediator's broker (read-only grant).
    const denied = await seen!.broker!.mutate('write_file', { path: 'x', content: 'y' })
    expect(denied.type).toBe('error')
  })

  it('FAILS CLOSED: a critical loadable that fails to load poisons the daemon — mediate DENIES, other requests error', async () => {
    // The lazy path is the common one (engine-startup race): the critical governance plugin
    // is discovered on the first request. Its load fails, so the daemon must refuse EVERYTHING
    // rather than run the session ungated. mediate must DENY (not transport-error): the adapter
    // fails OPEN to allow on a mediate error.
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-poison-'))
    fs.mkdirSync(path.join(pkg, 'type'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'gate.mjs'), `export function createPlugin() { throw new Error('gate boom') }\n`)
    const gate = {
      name: 'mcp.hook.gate',
      repo: 'au-workflow',
      source: { file: path.join(pkg, 'type', 'mcp.hook.gate.type.yaml') },
      meta_blocks: [{ type_name: 'plugin-runtime-meta', body: [
        { name: 'entry', value: './gate.mjs' },
        { name: 'shapes', value: ['mediator'] },
        { name: 'contractVersion', value: 0 },
        { name: 'critical', value: true },
      ] }],
    }
    const fakeBroker: EngineBroker = {
      socketPath: '/x',
      mutate: async () => ({}),
      available: () => true,
      async read(op, args) {
        if (op === 'subtypes') {
          // Discovery reads both bases; the gate is a hook, so return it only under mcp.hook.
          const base = (args as { base?: string } | undefined)?.base ?? ''
          return { type: 'response', ready: true, result: { base, subtypes: gate.name.startsWith(`${base}.`) ? [gate] : [] } }
        }
        return { type: 'response', ready: true, result: null }
      },
    }
    const daemon = createDaemon({ workspace: pkg, broker: fakeBroker })
    const conn = fakeConn()
    // session-open triggers ensureLoadableTools -> critical load fails -> poisoned.
    const opened = await daemon.handle({ kind: 'session-open', id: 1, info }, conn)
    expect(opened.kind).toBe('error')
    expect((opened as Extract<DaemonResponse, { kind: 'error' }>).message).toMatch(/gate boom/)
    // mediate must DENY, never allow.
    const med = await daemon.handle(
      { kind: 'mediate', id: 2, session: 's1', action: { tool: 'Bash', input: {} } },
      conn,
    )
    expect(med.kind).toBe('decision')
    expect((med as Extract<DaemonResponse, { kind: 'decision' }>).decision.kind).toBe('deny')
    fs.rmSync(pkg, { recursive: true, force: true })
  })

  it('requestApproval learns the human verdict and RECORDS it (granted -> allow + approval_granted; denied -> deny + approval_denied)', async () => {
    // A quiet broker dodges createEngineBroker entirely (no socket realpath) and is unused by the
    // gate. The injected `approval` stands in for the native dialog.
    const quietBroker: EngineBroker = {
      socketPath: '/x', mutate: async () => ({}), available: () => false,
      read: async () => ({ type: 'response', ready: true, result: null }),
    }
    const gate: Plugin = {
      manifest: { id: 'mcp.gate', name: 'gate', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: async (action, ctx) => {
        const v = await ctx.requestApproval({ title: 'escape', reason: 'exit workflow?', tool: action.tool, toolUseId: 'tu1' })
        return v === 'granted' ? { kind: 'allow' } : { kind: 'deny', reason: 'human denied' }
      },
    }
    const runWith = async (verdict: 'granted' | 'denied') => {
      const daemon = createDaemon({ workspace: ws, broker: quietBroker, plugins: [gate], approval: async () => verdict })
      const conn = fakeConn()
      await daemon.handle({ kind: 'session-open', id: 1, info }, conn)
      const med = await daemon.handle({ kind: 'mediate', id: 2, session: 's1', action: { tool: 'Bash', input: {} } }, conn)
      const tr = await daemon.handle({ kind: 'consult-trace', id: 3, session: 's1', query: {} }, conn)
      return { med, events: (tr as Extract<DaemonResponse, { kind: 'trace' }>).slice.events }
    }

    const granted = await runWith('granted')
    expect((granted.med as Extract<DaemonResponse, { kind: 'decision' }>).decision).toEqual({ kind: 'allow' })
    expect(granted.events.map((e) => e.kind)).toContain('approval_granted')

    const denied = await runWith('denied')
    expect((denied.med as Extract<DaemonResponse, { kind: 'decision' }>).decision).toEqual({ kind: 'deny', reason: 'human denied' })
    const verdictEvent = denied.events.find((e) => e.kind === 'approval_denied')
    expect(verdictEvent).toBeDefined()
    // The reject is AUDITED: the verdict event carries the correlation + reason.
    expect(verdictEvent!.data).toMatchObject({ tool: 'Bash', tool_use_id: 'tu1', reason: 'exit workflow?' })
  })

  it('appends observed events to the live log with daemon-assigned monotonic seq', async () => {
    const daemon = createDaemon({ workspace: ws })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info }, conn)
    await daemon.handle({ kind: 'observe', id: 2, session: 's1', event: event('a') }, conn)
    await daemon.handle({ kind: 'observe', id: 3, session: 's1', event: event('b') }, conn)

    const res = await daemon.handle({ kind: 'consult-trace', id: 4, session: 's1', query: {} }, conn)
    const slice = (res as Extract<DaemonResponse, { kind: 'trace' }>).slice
    expect(slice.events.map((e) => [e.kind, e.seq])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect(slice.headSeq).toBe(2)
  })

  it('returns a legible "referenced but not mounted" result for an unregistered callable (B1-A)', async () => {
    // No raw throw -> no opaque wire error. A tool that is allowed but not a registered callable
    // (its owner is not a member here) yields a uniform, actionable isError tool result instead.
    const daemon = createDaemon({ workspace: ws })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info }, conn)
    const res = await daemon.handle({ kind: 'invoke', id: 2, session: 's1', tool: 'no.such.tool', input: {} }, conn)
    expect(res).toMatchObject({ kind: 'invoked', isError: true })
    expect((res as { result: string }).result).toMatch(/referenced but not mounted/)
  })

  it('serves invoke + list-capabilities workspace-scoped (no session needed)', async () => {
    const echo: Plugin = {
      manifest: { id: 'mcp.echo', name: 'echo', contractVersion: 0, kind: 'tool' },
      invoke: async (i) => ({ content: i }),
    }
    const daemon = createDaemon({ workspace: ws, plugins: [echo] })
    // No session-open first.
    const caps = await daemon.handle({ kind: 'list-capabilities', id: 1 }, fakeConn())
    expect((caps as { callables: PluginManifest[] }).callables.map((m) => m.id)).toEqual(['mcp.echo'])
    const res = await daemon.handle({ kind: 'invoke', id: 2, tool: 'mcp.echo', input: { a: 1 } }, fakeConn())
    expect(res).toMatchObject({ kind: 'invoked', result: { a: 1 } })
  })

  it('hands a session-scoped callable a read-only consultTrace over its own live log', async () => {
    // A reporting tool computes its OWN payload from the trace, instead of depending on a
    // mediator's pre-tool inject to be useful (the au-workflow workflow_status gap).
    // Hermetic workspace + session so no shared-fixture recovery scratch bleeds in.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-ct-'))
    const sess = 'ct-sess'
    const localInfo: AdapterInfo = { harness: 'cc', session: sess, workspace: ws, nativeTools: [{ name: 'Bash' }] }
    const probe: Plugin = {
      manifest: { id: 'mcp.trace-probe', name: 'trace-probe', contractVersion: 0, kind: 'tool' },
      invoke: async (_i, ctx) => {
        const slice = await ctx?.consultTrace?.({})
        return { content: { kinds: slice?.events.map((e) => e.kind) ?? null, headSeq: slice?.headSeq ?? null } }
      },
    }
    const daemon = createDaemon({ workspace: ws, plugins: [probe] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: localInfo }, conn)
    await daemon.handle({ kind: 'observe', id: 2, session: sess, event: { kind: 'user_prompt', run: 0, seq: 0, session: sess, data: null } }, conn)
    await daemon.handle({ kind: 'observe', id: 3, session: sess, event: { kind: 'tool_start', run: 0, seq: 0, session: sess, data: null } }, conn)

    const res = await daemon.handle({ kind: 'invoke', id: 4, session: sess, tool: 'mcp.trace-probe', input: {} }, conn)
    expect(res).toMatchObject({ kind: 'invoked', result: { kinds: ['user_prompt', 'tool_start'] } })
    // headSeq is a real number the callable can page from — the same slice a mediator would get.
    expect((res as { result: { headSeq: number } }).result.headSeq).toBeGreaterThanOrEqual(1)
  })

  it('gives a workspace-scoped callable no consultTrace (no session, no log to read)', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-ct-'))
    const probe: Plugin = {
      manifest: { id: 'mcp.trace-probe', name: 'trace-probe', contractVersion: 0, kind: 'tool' },
      invoke: async (_i, ctx) => ({ content: { hasTrace: ctx?.consultTrace !== undefined } }),
    }
    const daemon = createDaemon({ workspace: ws, plugins: [probe] })
    const res = await daemon.handle({ kind: 'invoke', id: 1, tool: 'mcp.trace-probe', input: {} }, fakeConn())
    expect(res).toMatchObject({ kind: 'invoked', result: { hasTrace: false } })
  })

  it('a reporting callable invoked by HANDLE (the CC shim) resolves to the bound session and gets consultTrace', async () => {
    // The workflow_status case (au-workflow message 260807000226): the CC mcp-server invokes carrying
    // only the launch HANDLE (not the session id). session-open bound handle -> session, so the daemon
    // resolves it and hands the reporting callable a consultTrace over that session's log.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-ct-handle-'))
    const sess = 'wf-sess'
    const handle = 'launch-h1'
    const localInfo: AdapterInfo = { harness: 'cc', session: sess, handle, workspace: ws, nativeTools: [{ name: 'Bash' }] }
    const probe: Plugin = {
      manifest: { id: 'mcp.workflow-status-probe', name: 'wf-probe', contractVersion: 0, kind: 'tool' },
      invoke: async (_i, ctx) => {
        const slice = await ctx?.consultTrace?.({})
        return { content: { hasTrace: ctx?.consultTrace !== undefined, kinds: slice?.events.map((e) => e.kind) ?? null } }
      },
    }
    const daemon = createDaemon({ workspace: ws, plugins: [probe] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: localInfo }, conn)
    await daemon.handle({ kind: 'observe', id: 2, session: sess, event: { kind: 'user_prompt', run: 0, seq: 0, session: sess, data: null } }, conn)
    // Invoke by HANDLE (as the CC shim does): the daemon resolves handle -> session.
    const res = await daemon.handle({ kind: 'invoke', id: 3, session: handle, tool: 'mcp.workflow-status-probe', input: {} }, conn)
    expect(res).toMatchObject({ kind: 'invoked', result: { hasTrace: true, kinds: ['user_prompt'] } })
  })

  it('runs a mediator review on observe and returns its text on the observed response (B2-i)', async () => {
    // The POST-tool announcement channel: a mediator narrates a consequence of a completed event,
    // and the text rides back on the observed response for the adapter to surface.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-rv-'))
    const sess = 'rv-sess'
    const localInfo: AdapterInfo = { harness: 'cc', session: sess, workspace: ws, nativeTools: [] }
    const reviewer: Plugin = {
      manifest: { id: 'mcp.reviewer', name: 'reviewer', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: () => ({ kind: 'allow' }),
      review: (event) => (event.kind === 'tool_call' ? { text: `gate verdict for ${event.kind}` } : undefined),
    }
    const daemon = createDaemon({ workspace: ws, plugins: [reviewer] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: localInfo }, conn)

    const seen = await daemon.handle({ kind: 'observe', id: 2, session: sess, event: { kind: 'tool_call', run: 0, seq: 0, session: sess, data: null } }, conn)
    expect(seen).toMatchObject({ kind: 'observed', text: 'gate verdict for tool_call' })
    // A non-matching event -> the mediator declines -> no text field at all.
    const quiet = await daemon.handle({ kind: 'observe', id: 3, session: sess, event: { kind: 'user_prompt', run: 0, seq: 0, session: sess, data: null } }, conn)
    expect(quiet).toEqual({ kind: 'observed', id: 3 })
  })

  it('isolates a throwing mediator review — no text, the observe (and session) survive', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-rv-'))
    const sess = 'rv-sess'
    const localInfo: AdapterInfo = { harness: 'cc', session: sess, workspace: ws, nativeTools: [] }
    const boom: Plugin = {
      manifest: { id: 'mcp.boom', name: 'boom', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: () => ({ kind: 'allow' }),
      review: () => {
        throw new Error('boom')
      },
    }
    const daemon = createDaemon({ workspace: ws, plugins: [boom] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: localInfo }, conn)
    const res = await daemon.handle({ kind: 'observe', id: 2, session: sess, event: { kind: 'tool_call', run: 0, seq: 0, session: sess, data: null } }, conn)
    expect(res).toEqual({ kind: 'observed', id: 2 }) // best-effort: the throw is swallowed, no text
  })

  it('gives a mediator previewAction over the pending write, mapped from the engine (P1/P2)', async () => {
    // A per-call gate previews the pending write's product at decide, without the agent seeing a
    // preview tool call. au-mcp maps the action -> preview_mutation and projects to ActionPreview.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-pv-'))
    const previewBroker: EngineBroker = {
      socketPath: '/x',
      available: () => true,
      // The real broker unwraps the schema-17 envelope, so `frame.result` is the payload already.
      read: async (op, args) => {
        if (op !== 'preview_mutation') return { ready: true, result: null }
        return {
          ready: true,
          result: {
            target: { path: (args as { path: string }).path, hash: 'h1', identities: [{ name: 'plan', repo: 'proj', hash: 'z' }], diagnostics: [] },
            blast_radius: [],
          },
        }
      },
      mutate: async () => ({}),
    }
    let seen: unknown = 'unset'
    const gate: Plugin = {
      manifest: { id: 'mcp.previewer', name: 'previewer', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: async (action, ctx) => {
        const preview = await ctx.previewAction(action)
        seen = preview
        // Gate the write on its product: deny unless it would produce a `plan`.
        const ok = preview?.kind === 'product' && preview.identities.some((i) => i.name === 'plan')
        return ok ? { kind: 'allow' } : { kind: 'deny', reason: 'not a plan' }
      },
    }
    const daemon = createDaemon({ workspace: ws, broker: previewBroker, plugins: [gate] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: { harness: 'cc', session: 's1', workspace: ws, nativeTools: [] } }, conn)

    const dec = await daemon.handle(
      { kind: 'mediate', id: 2, session: 's1', action: { tool: 'mcp.write_file', input: { file_path: '/w/plan.md', content: 'x' } } },
      conn,
    )
    expect(dec).toMatchObject({ kind: 'decision', decision: { kind: 'allow' } })
    expect(seen).toMatchObject({ kind: 'product', identities: [{ name: 'plan', repo: 'proj' }] })

    // A non-previewable action (read_file_pinned) -> previewAction resolves undefined -> the gate denies.
    const dec2 = await daemon.handle(
      { kind: 'mediate', id: 3, session: 's1', action: { tool: 'mcp.read_file_pinned', input: { file_path: '/w/plan.md' } } },
      conn,
    )
    expect(dec2).toMatchObject({ kind: 'decision', decision: { kind: 'deny' } })
    expect(seen).toBeUndefined()
  })

  it('gates from the profile-derived SESSION allowlist (plan 2609072337)', async () => {
    // Visibility is session state, resolved from the active profile at open — no per-request allowlist.
    const tool = (id: string): Plugin => ({
      manifest: { id, name: id, contractVersion: 0, kind: 'tool' },
      invoke: async (i) => ({ content: i }),
    })
    // A broker whose graph carries one agent-profile 'p' restricting tools to read_file_pinned. session-open
    // reads it, resolveSessionScope reduces it, and the daemon stashes session.toolAllowlist.
    const profileBroker: EngineBroker = {
      socketPath: '/fake/engine.sock',
      available: () => true,
      read: async (op, args) =>
        op === 'instances_of' && (args as { type?: string })?.type === 'agent-profile'
          ? { result: [{ path: '/ws/p.md', fields: { name: 'p', tools: ['[[mcp.tool.read_file_pinned]]'] } }] }
          : { result: [] }, // mcp.skill discovery + members -> none
      mutate: async () => ({}),
    }
    const daemon = createDaemon({ workspace: ws, broker: profileBroker, plugins: [tool('mcp.shout'), tool('mcp.read_file_pinned')] })
    await daemon.handle({ kind: 'session-open', id: 1, info: { ...info, profile: 'p' } }, fakeConn())

    const ids = async () =>
      ((await daemon.handle({ kind: 'list-capabilities', id: 3, session: 's1' }, fakeConn())) as { callables: PluginManifest[] }).callables.map((m) => m.id).sort()

    expect(await ids()).toEqual(['mcp.read_file_pinned']) // shout is not in the profile -> hidden
    // invoke: a tool outside the session allowlist is refused; one inside proceeds.
    expect(
      await daemon.handle({ kind: 'invoke', id: 1, tool: 'mcp.shout', input: { a: 1 }, session: 's1' }, fakeConn()),
    ).toMatchObject({ kind: 'invoked', isError: true })
    expect(
      await daemon.handle({ kind: 'invoke', id: 2, tool: 'mcp.read_file_pinned', input: { a: 1 }, session: 's1' }, fakeConn()),
    ).toMatchObject({ kind: 'invoked', result: { a: 1 } })
  })

  it('resolves the advertise from the profile LOCATOR when no session is open (startup race fix)', async () => {
    // The shim advertises at MCP-server startup, before session-open. With no session, the daemon
    // resolves the allowlist from the forwarded profile locator (plan 2609072337 Adjustment).
    const tool = (id: string): Plugin => ({
      manifest: { id, name: id, contractVersion: 0, kind: 'tool' },
      invoke: async (i) => ({ content: i }),
    })
    const profileBroker: EngineBroker = {
      socketPath: '/fake/engine.sock',
      available: () => true,
      read: async (op, args) =>
        op === 'instances_of' && (args as { type?: string })?.type === 'agent-profile'
          ? {
              result: [
                { path: '/ws/p.md', fields: { name: 'p', tools: ['[[mcp.tool.read_file_pinned]]'] } },
                { path: '/ws/p_empty.md', fields: { name: 'p_empty', tools: [] } },
                { path: '/ws/p_ghost.md', fields: { name: 'p_ghost', tools: ['[[mcp.tool.nonexistent]]'] } },
              ],
            }
          : { result: [] },
      mutate: async () => ({}),
    }
    const daemon = createDaemon({ workspace: ws, broker: profileBroker, plugins: [tool('mcp.shout'), tool('mcp.read_file_pinned')] })
    // NO session opened. Advertise resolves purely from the profile locator.
    const ids = async (profile?: string) =>
      ((await daemon.handle({ kind: 'list-capabilities', id: 3, profile }, fakeConn())) as { callables: PluginManifest[] }).callables.map((m) => m.id).sort()

    expect(await ids('p')).toEqual(['mcp.read_file_pinned']) // profile restricts, no session needed
    expect(await ids(undefined)).toEqual(['mcp.read_file_pinned', 'mcp.shout']) // no profile -> unrestricted (every tool)
    expect(await ids('p_empty')).toEqual([]) // an empty `tools` list -> no tool
    expect(await ids('p_ghost')).toEqual([]) // a profile naming no mounted tool advertises none, not an error
  })

  it('persists a session across connections; closes only on explicit session-close', async () => {
    const daemon = createDaemon({ workspace: ws, plugins: [] })
    // Each fakeConn() models a separate short-lived hook process.
    await daemon.handle({ kind: 'session-open', id: 1, info }, fakeConn())
    expect(daemon.sessionCount()).toBe(1)
    // A different connection observes — the session is still alive.
    await daemon.handle({ kind: 'observe', id: 2, session: 's1', event: event('a') }, fakeConn())
    expect(daemon.sessionCount()).toBe(1)
    // Re-open is idempotent: it keeps the existing log.
    await daemon.handle({ kind: 'session-open', id: 3, info }, fakeConn())
    const trace = await daemon.handle({ kind: 'consult-trace', id: 4, session: 's1', query: {} }, fakeConn())
    expect((trace as Extract<DaemonResponse, { kind: 'trace' }>).slice.events).toHaveLength(1)
    // Only an explicit session-close drops it.
    await daemon.handle({ kind: 'session-close', id: 5, session: 's1' }, fakeConn())
    expect(daemon.sessionCount()).toBe(0)
  })
})

describe('handle-bound invoke: the daemon resolves the CC session for the stamp attach', () => {
  // The CC mcp-server shim invokes carrying the launch HANDLE as `session` (CC exposes no session id
  // to an MCP server). session-open bound handle -> session id, so the daemon resolves it and the
  // stamp attach runs its stampers with the live session. Concurrency-exact by construction: each
  // launch has its own handle.
  const writer: Plugin = {
    // A stand-in for the gate write callable: echoes its (possibly stamped) input so a test can
    // see whether the daemon injected `stamps` before invoke.
    manifest: { id: 'mcp.edit_file', name: 'edit_file', contractVersion: 0, kind: 'tool' },
    invoke: async (i) => ({ content: i }),
  }
  const stamper: Plugin = {
    manifest: { id: 'mcp.test-stamper', name: 'Test Stamper', contractVersion: 0, kind: 'hook', shapes: ['stamper'] },
    stamp: (c) => [{ field: 'spine', record: { type: `fc.${c.kind}`, session: c.session } }],
  }
  const wsInfo = (session: string, handle: string, workspace: string): AdapterInfo => ({
    harness: 'cc',
    session,
    handle,
    workspace,
    nativeTools: [{ name: 'Bash' }],
  })
  const sessionOf = (res: unknown) =>
    (res as { result: { stamps?: Array<{ record: { session?: string } }> } }).result.stamps?.[0].record.session

  it('invoke by HANDLE -> stamp attaches with the bound session', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-bind-'))
    const daemon = createDaemon({ workspace: ws, plugins: [writer, stamper] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: wsInfo('s1', 'h1', ws) }, conn)
    // The mcp-server shim invokes carrying the handle as `session`.
    const res = await daemon.handle(
      { kind: 'invoke', id: 2, session: 'h1', tool: 'mcp.edit_file', input: { file_path: '/x.md', old_string: 'a', new_string: 'b' } },
      conn,
    )
    expect(sessionOf(res)).toBe('s1')
    expect((res as { result: { stamps?: Array<{ record: unknown }> } }).result.stamps?.[0].record).toMatchObject({ type: 'fc.edit', session: 's1' })
  })

  it('concurrency: two launches each invoke by their OWN handle and stamp their OWN session', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-bind2-'))
    const daemon = createDaemon({ workspace: ws, plugins: [writer, stamper] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: wsInfo('sA', 'hA', ws) }, conn)
    await daemon.handle({ kind: 'session-open', id: 2, info: wsInfo('sB', 'hB', ws) }, conn)
    const resB = await daemon.handle({ kind: 'invoke', id: 3, session: 'hB', tool: 'mcp.edit_file', input: { file_path: '/b.md', old_string: 'a', new_string: 'b' } }, conn)
    const resA = await daemon.handle({ kind: 'invoke', id: 4, session: 'hA', tool: 'mcp.edit_file', input: { file_path: '/a.md', old_string: 'a', new_string: 'b' } }, conn)
    expect(sessionOf(resB)).toBe('sB')
    expect(sessionOf(resA)).toBe('sA')
  })

  it('/clear rebind: the same handle re-opened with a NEW session resolves to the new one', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-bind3-'))
    const daemon = createDaemon({ workspace: ws, plugins: [writer, stamper] })
    const conn = fakeConn()
    // startup session s1 on handle h1, then /clear: SessionEnd(s1) then SessionStart(s2) same handle.
    await daemon.handle({ kind: 'session-open', id: 1, info: wsInfo('s1', 'h1', ws) }, conn)
    await daemon.handle({ kind: 'session-close', id: 2, session: 's1' }, conn)
    await daemon.handle({ kind: 'session-open', id: 3, info: wsInfo('s2', 'h1', ws) }, conn)
    // The shim still sends the unchanged handle h1; it must now resolve to s2.
    const res = await daemon.handle({ kind: 'invoke', id: 4, session: 'h1', tool: 'mcp.edit_file', input: { file_path: '/x.md', old_string: 'a', new_string: 'b' } }, conn)
    expect(sessionOf(res)).toBe('s2')
  })

  it('a raw session id (a direct caller, never bound) falls through unchanged', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-bind4-'))
    const daemon = createDaemon({ workspace: ws, plugins: [writer, stamper] })
    const conn = fakeConn()
    // A direct caller opens with no handle and invokes with the real session id (verify/test path).
    await daemon.handle({ kind: 'session-open', id: 1, info: { harness: 'cc', session: 's1', workspace: ws, nativeTools: [{ name: 'Bash' }] } }, conn)
    const res = await daemon.handle({ kind: 'invoke', id: 2, session: 's1', tool: 'mcp.edit_file', input: { file_path: '/x.md', old_string: 'a', new_string: 'b' } }, conn)
    expect(sessionOf(res)).toBe('s1')
  })

  it('a truly session-less invoke stays session-less (workspace-scoped, no stamp)', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-bind5-'))
    const daemon = createDaemon({ workspace: ws, plugins: [writer, stamper] })
    const conn = fakeConn()
    await daemon.handle({ kind: 'session-open', id: 1, info: wsInfo('s1', 'h1', ws) }, conn)
    // No session/handle on the invoke: no binding to resolve -> no stamp (sanitized, safe).
    const res = await daemon.handle({ kind: 'invoke', id: 2, tool: 'mcp.edit_file', input: { file_path: '/x.md', old_string: 'a', new_string: 'b' } }, conn)
    expect('stamps' in (res as { result: Record<string, unknown> }).result).toBe(false)
  })
})
