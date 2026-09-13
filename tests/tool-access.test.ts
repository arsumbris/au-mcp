// A tool's DECLARED engine access — the `tool-access-meta` meta on its own def.
//
// This is the tool stating what it needs to do its job, fixed at discovery for its
// lifetime in the daemon. It is NOT a human knob: which tools a session has is the
// separate on/off allowlist axis (see tool-visibility.ts + the tool-visibility spec),
// and that axis never changes what a tool may do once it is loaded.

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import { readOnlyBroker } from '../src/daemon/broker.ts'
import { discoverTools, requestedBroker, scopedBroker } from '../src/daemon/discovery.ts'

// A full fake broker: read/mutate/available all succeed, so a denial is observably the wrapper's.
function fullBroker(): EngineBroker {
  return {
    socketPath: '/x',
    available: () => true,
    read: async (): Promise<EngineFrame> => ({ type: 'response', ready: true, result: 'READ_OK' }),
    mutate: async (): Promise<EngineFrame> => ({ ready: true, result: 'MUTATE_OK' }),
  }
}

// A def carrying (or not) a tool-access-meta meta, in the WireSubtype shape discovery reads.
function defWith(broker?: string): Parameters<typeof requestedBroker>[0] {
  const meta = broker === undefined ? [] : [{ type_name: 'tool-access-meta::au-mcp-sdk', body: [{ name: 'broker', value: broker }] }]
  return { name: 'mcp.tool.x', meta_blocks: meta } as Parameters<typeof requestedBroker>[0]
}

describe('readOnlyBroker', () => {
  it('passes read + available through and denies mutate', async () => {
    const ro = readOnlyBroker(fullBroker())
    expect(ro.available()).toBe(true)
    expect((await ro.read('types', {})).result).toBe('READ_OK')
    const denied = await ro.mutate('write_file', {})
    expect(denied.type).toBe('error')
  })
})

describe('requestedBroker', () => {
  it('reads the declared broker level, defaulting to none', () => {
    expect(requestedBroker(defWith('read'))).toBe('read')
    expect(requestedBroker(defWith('read-write'))).toBe('read-write')
    expect(requestedBroker(defWith('none'))).toBe('none')
    expect(requestedBroker(defWith())).toBe('none') // no meta -> requests nothing
    expect(requestedBroker(defWith('nonsense'))).toBe('none') // unrecognised -> nothing
  })
})

describe('scopedBroker', () => {
  it('scopes the broker to the declared level', async () => {
    const full = fullBroker()
    expect(scopedBroker(full, 'read-write')).toBe(full)
    expect(scopedBroker(full, 'none')).toBeUndefined()
    const ro = scopedBroker(full, 'read')
    expect((await ro!.mutate('write_file', {})).type).toBe('error')
  })
})

describe('discoverTools broker scoping', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'au-perm-pkg-'))
  fs.mkdirSync(path.join(pkg, 'type'), { recursive: true })
  // The demo reports whether it got a broker and whether mutate is denied.
  fs.writeFileSync(
    path.join(pkg, 'demo-broker.mjs'),
    `export function createPlugin(ctx) {
       return { invoke: async () => {
         if (!ctx.broker) return { content: { hasBroker: false } }
         const m = await ctx.broker.mutate('write_file')
         return { content: { hasBroker: true, mutateDenied: m?.type === 'error' } }
       } }
     }\n`,
  )

  function permSubtype(name: string, broker?: string) {
    const meta_blocks: Array<{ type_name: string; body: Array<{ name: string; value: unknown }> }> = [
      { type_name: 'plugin-runtime-meta', body: [
        { name: 'entry', value: './demo-broker.mjs' }, { name: 'shapes', value: ['callable'] }, { name: 'contractVersion', value: 0 },
      ] },
    ]
    if (broker !== undefined) meta_blocks.push({ type_name: 'tool-access-meta::au-mcp-sdk', body: [{ name: 'broker', value: broker }] })
    return { name, repo: 'a-repo', source: { file: path.join(pkg, 'type', `${name}.type.yaml`) }, meta_blocks }
  }

  // A discovery-shaped full broker (mutate succeeds, so a denial is observably the scoping).
  function discoveryBroker(subtypes: unknown[]): EngineBroker {
    return {
      socketPath: '/x',
      available: () => true,
      mutate: async (): Promise<EngineFrame> => ({ ready: true, result: 'OK' }),
      read: async (op, args): Promise<EngineFrame> => {
        // Discovery reads both bases (mcp.tool + mcp.hook); return only the subtypes under the
        // queried base so a def is not processed twice.
        if (op !== 'subtypes') return { type: 'response', ready: true, result: null }
        const base = (args as { base?: string } | undefined)?.base ?? ''
        const matching = (subtypes as { name?: unknown }[]).filter((s) => typeof s?.name === 'string' && s.name.startsWith(`${base}.`))
        return { type: 'response', ready: true, result: { base, subtypes: matching } }
      },
    }
  }

  const tempWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'au-perm-ws-'))

  it('a read request yields a read-only broker (mutate denied)', async () => {
    const { loaded } = await discoverTools(discoveryBroker([permSubtype('mcp.tool.rd', 'read')]), { workspace: tempWs() })
    expect((await loaded[0].invoke!({})).content).toEqual({ hasBroker: true, mutateDenied: true })
  })

  it('a read-write request yields the full broker (mutate allowed)', async () => {
    const { loaded } = await discoverTools(discoveryBroker([permSubtype('mcp.tool.rw', 'read-write')]), { workspace: tempWs() })
    expect((await loaded[0].invoke!({})).content).toEqual({ hasBroker: true, mutateDenied: false })
  })

  it('declaring nothing yields no broker at all', async () => {
    const { loaded } = await discoverTools(discoveryBroker([permSubtype('mcp.tool.plain')]), { workspace: tempWs() })
    expect((await loaded[0].invoke!({})).content).toEqual({ hasBroker: false })
  })

  it('declaring broker:none yields no broker, the same as declaring nothing', async () => {
    const { loaded } = await discoverTools(discoveryBroker([permSubtype('mcp.tool.zero', 'none')]), { workspace: tempWs() })
    expect((await loaded[0].invoke!({})).content).toEqual({ hasBroker: false })
  })

  it('scopes each tool independently in one discovery pass', async () => {
    const subtypes = [permSubtype('mcp.tool.a', 'read'), permSubtype('mcp.tool.b', 'read-write'), permSubtype('mcp.tool.c')]
    const { loaded } = await discoverTools(discoveryBroker(subtypes), { workspace: tempWs() })
    const byId = new Map(loaded.map((p) => [p.manifest.id, p]))
    expect((await byId.get('mcp.a')!.invoke!({})).content).toEqual({ hasBroker: true, mutateDenied: true })
    expect((await byId.get('mcp.b')!.invoke!({})).content).toEqual({ hasBroker: true, mutateDenied: false })
    expect((await byId.get('mcp.c')!.invoke!({})).content).toEqual({ hasBroker: false })
  })
})
