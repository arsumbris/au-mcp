import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  AdapterInfo,
  Decision,
  Plugin,
  PluginManifest,
  SessionEvent,
} from '@arsumbris/au-mcp-sdk'
import { createDaemon } from '../src/daemon/daemon.ts'
import type { WireConnection } from '../src/wire/server.ts'

// A REAL workspace dir (socketPath realpaths the entry) + per-test crash-recovery isolation, so
// these tests don't ENOENT on a bare `/tmp/ws` nor bleed persisted scratch across each other
// (todo 2607281308). See daemon.test.ts for the full rationale.
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-registry-'))
const ORIG_REC = process.env.AU_MCP_RECOVERY_DIR
beforeEach(() => {
  process.env.AU_MCP_RECOVERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'au-mcp-rec-'))
})
afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true })
  if (ORIG_REC === undefined) delete process.env.AU_MCP_RECOVERY_DIR
  else process.env.AU_MCP_RECOVERY_DIR = ORIG_REC
})

function fakeConn(): WireConnection {
  return { send: () => {}, onClose: () => {} }
}

const info: AdapterInfo = {
  harness: 'cc',
  session: 's1',
  workspace: ws,
  nativeTools: [],
}

function manifest(over: { id: string; kind: 'tool' | 'hook' } & Record<string, unknown>): PluginManifest {
  return { name: over.id, contractVersion: 0, ...over } as PluginManifest
}

/** A callable echo tool. */
function echoTool(id: string): Plugin {
  return {
    manifest: manifest({ id, kind: 'tool' }),
    invoke: async (input) => ({ content: { echoed: input } }),
  }
}

/** A mediator that denies a given tool name, at a given priority. */
function denyMediator(id: string, denyTool: string, priority: number): Plugin {
  return {
    manifest: manifest({ id, kind: 'hook', shapes: ['mediator'], priority }),
    decide: (action): Decision =>
      action.tool === denyTool ? { kind: 'deny', reason: `${id} denies ${denyTool}` } : { kind: 'allow' },
  }
}

async function open(daemon: ReturnType<typeof createDaemon>) {
  await daemon.handle({ kind: 'session-open', id: 1, info }, fakeConn())
}

describe('plugin registry + orchestration', () => {
  it('routes invoke to the registered callable', async () => {
    const daemon = createDaemon({ workspace: ws, plugins: [echoTool('mcp.echo')] })
    await open(daemon)
    const res = await daemon.handle(
      { kind: 'invoke', id: 2, session: 's1', tool: 'mcp.echo', input: { a: 1 } },
      fakeConn(),
    )
    expect(res).toMatchObject({ kind: 'invoked', result: { echoed: { a: 1 } } })
  })

  it('lists callable manifests as capabilities', async () => {
    const daemon = createDaemon({
      workspace: ws,
      plugins: [echoTool('mcp.a'), echoTool('mcp.b'), denyMediator('mcp.guard', 'Bash', 0)],
    })
    await open(daemon)
    const res = await daemon.handle({ kind: 'list-capabilities', id: 2, session: 's1' }, fakeConn())
    expect(res).toMatchObject({ kind: 'capabilities' })
    const ids = (res as { callables: PluginManifest[] }).callables.map((m) => m.id).sort()
    expect(ids).toEqual(['mcp.a', 'mcp.b']) // the mediator is not a callable
  })

  it('runs mediators in priority order; the first deny short-circuits', async () => {
    const daemon = createDaemon({
      workspace: ws,
      plugins: [denyMediator('mcp.low', 'Bash', 1), denyMediator('mcp.high', 'Bash', 10)],
    })
    await open(daemon)
    const res = await daemon.handle(
      { kind: 'mediate', id: 2, session: 's1', action: { tool: 'Bash', input: {} } },
      fakeConn(),
    )
    expect(res).toMatchObject({ kind: 'decision', decision: { kind: 'deny', reason: 'mcp.high denies Bash' } })
  })

  it('allows when no mediator denies', async () => {
    const daemon = createDaemon({
      workspace: ws,
      plugins: [denyMediator('mcp.guard', 'Bash', 0)],
    })
    await open(daemon)
    const res = await daemon.handle(
      { kind: 'mediate', id: 2, session: 's1', action: { tool: 'Read', input: {} } },
      fakeConn(),
    )
    expect(res).toMatchObject({ kind: 'decision', decision: { kind: 'allow' } })
  })

  it('fans observed events out to observer plugins', async () => {
    const seen: SessionEvent[] = []
    const watcher: Plugin = {
      manifest: manifest({ id: 'mcp.watch', kind: 'hook', shapes: ['observer'] }),
      onEvent: (event) => seen.push(event),
    }
    const daemon = createDaemon({ workspace: ws, plugins: [watcher] })
    await open(daemon)
    await daemon.handle(
      { kind: 'observe', id: 2, session: 's1', event: { kind: 'tool_start', run: 0, seq: 0, session: 's1', data: null } },
      fakeConn(),
    )
    expect(seen.map((e) => [e.kind, e.seq])).toEqual([['tool_start', 1]]) // daemon-stamped seq
  })

  it('fails closed when a plugin dependency is unsatisfied (P4)', () => {
    const needsTrace: Plugin = {
      manifest: manifest({ id: 'mcp.hardrule', kind: 'hook', shapes: ['mediator'], dependsOn: ['mcp.trace'] }),
      decide: () => ({ kind: 'allow' }),
    }
    expect(() => createDaemon({ workspace: ws, plugins: [needsTrace] })).toThrow(
      /unsatisfied plugin dependencies: mcp\.trace/,
    )
  })
})
