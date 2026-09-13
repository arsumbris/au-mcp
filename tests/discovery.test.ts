import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { PLUGIN_CONTRACT_VERSION } from '@arsumbris/au-mcp-sdk'
import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import { discoverTools } from '../src/daemon/discovery.ts'

// A temp "package": <pkg>/type/<def>.type.yaml is the def source; <pkg>/demo.mjs is the
// entry, so packageRootOf(source) -> <pkg> and `./demo.mjs` resolves to the real file.
let pkg: string
beforeAll(() => {
  pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'au-tool-fixture-'))
  fs.mkdirSync(path.join(pkg, 'type'), { recursive: true })
  fs.writeFileSync(
    path.join(pkg, 'demo.mjs'),
    `export function createPlugin(ctx) {
       return { invoke: async (input) => ({ content: { echoed: input?.msg, ws: ctx.workspace } }) }
     }\n`,
  )
  // A loadable whose createPlugin throws at construction (governance plugin that fails to load).
  fs.writeFileSync(path.join(pkg, 'throws.mjs'), `export function createPlugin() { throw new Error('boom') }\n`)
  // A loadable whose entry exports NO createPlugin.
  fs.writeFileSync(path.join(pkg, 'nofn.mjs'), `export const notIt = 1\n`)
})
afterAll(() => fs.rmSync(pkg, { recursive: true, force: true }))

interface MetaField { name: string; value: unknown }
function subtype(name: string, meta: MetaField[] | null) {
  return {
    name,
    repo: 'a-repo',
    source: { file: path.join(pkg, 'type', `${name}.type.yaml`) },
    ...(meta ? { meta_blocks: [{ type_name: 'plugin-runtime-meta', body: meta }] } : {}),
  }
}

// A callable tool's runtime meta — a TOOL declares no shapes (callable is not a shape; the
// base mcp.tool IS the callable). manifestFrom derives kind:'tool' from the def name.
const demoMeta: MetaField[] = [
  { name: 'entry', value: './demo.mjs' },
  { name: 'contractVersion', value: 0 },
]

// A meta pointing at an entry that fails to load, optionally flagged `critical`.
function failMeta(entry: string, critical: boolean): MetaField[] {
  return [
    { name: 'entry', value: entry },
    { name: 'shapes', value: ['mediator'] },
    { name: 'contractVersion', value: 0 },
    ...(critical ? [{ name: 'critical', value: true }] : []),
  ]
}

// A meta at a given plugin contract version. The version gate fires BEFORE the entry is
// imported, so a valid entry (./demo.mjs) isolates the version path from any load failure.
function versionMeta(v: number, opts: { hook?: boolean; critical?: boolean } = {}): MetaField[] {
  return [
    { name: 'entry', value: './demo.mjs' },
    { name: 'contractVersion', value: v },
    ...(opts.hook ? [{ name: 'shapes', value: ['mediator'] }] : []),
    ...(opts.critical ? [{ name: 'critical', value: true }] : []),
  ]
}

function broker(subtypes: unknown[], available = true): EngineBroker {
  return {
    socketPath: '/x',
    mutate: async () => ({}),
    available: () => available,
    async read(op, args): Promise<EngineFrame> {
      // Discovery reads BOTH bases (mcp.tool + mcp.hook); return only the subtypes under the
      // queried base so a def is not processed twice.
      if (op === 'subtypes') {
        const base = (args as { base?: string } | undefined)?.base ?? ''
        const matching = (subtypes as { name?: unknown }[]).filter(
          (s) => typeof s?.name === 'string' && s.name.startsWith(`${base}.`),
        )
        return { type: 'response', ready: true, result: { base, subtypes: matching } }
      }
      return { type: 'response', ready: true, result: null }
    },
  }
}

describe('discoverTools', () => {
  it('loads a loadable tool and derives its manifest + id from the def', async () => {
    const { loaded, skipped } = await discoverTools(broker([subtype('mcp.tool.demo', demoMeta)]), { workspace: '/ws' })
    expect(skipped).toEqual([])
    expect(loaded).toHaveLength(1)
    expect(loaded[0].manifest.id).toBe('mcp.demo') // mcp.tool.demo -> mcp.demo
    expect(loaded[0].manifest.kind).toBe('tool')
    const res = await loaded[0].invoke!({ msg: 'hi' })
    expect(res.content).toEqual({ echoed: 'hi', ws: '/ws' }) // the loaded ESM ran with ctx
  })

  it('maps meta.requiresContinuity onto the manifest (exact parallel to critical)', async () => {
    const contMeta: MetaField[] = [...demoMeta, { name: 'requiresContinuity', value: true }]
    const { loaded } = await discoverTools(broker([subtype('mcp.tool.cont', contMeta)]), { workspace: '/ws' })
    expect(loaded).toHaveLength(1)
    expect(loaded[0].manifest.requiresContinuity).toBe(true)
  })

  it('leaves requiresContinuity unset on the manifest when the meta does not declare it', async () => {
    const { loaded } = await discoverTools(broker([subtype('mcp.tool.demo', demoMeta)]), { workspace: '/ws' })
    expect(loaded[0].manifest.requiresContinuity).toBeUndefined()
  })

  it('dedups a tool whose id is already registered BEFORE importing (floor+enrichment)', async () => {
    const { loaded, skipped } = await discoverTools(
      broker([subtype('mcp.tool.demo', demoMeta)]),
      { workspace: '/ws' },
      (id) => id === 'mcp.demo', // core literal already holds it
    )
    expect(loaded).toEqual([])
    expect(skipped).toEqual(['mcp.demo'])
  })

  it('ignores a subtype with no plugin-runtime-meta block (not loadable code)', async () => {
    const { loaded, skipped } = await discoverTools(broker([subtype('mcp.tool.plain', null)]), { workspace: '/ws' })
    expect(loaded).toEqual([])
    expect(skipped).toEqual([])
  })

  it('returns empty when the engine is unreachable (kernel still runs on core literals)', async () => {
    const { loaded, skipped } = await discoverTools(broker([subtype('mcp.tool.demo', demoMeta)], false), { workspace: '/ws' })
    expect(loaded).toEqual([])
    expect(skipped).toEqual([])
  })

  it('records a CRITICAL loadable whose createPlugin throws in failedCritical (fail closed)', async () => {
    const { loaded, failedCritical } = await discoverTools(broker([subtype('mcp.hook.gate', failMeta('./throws.mjs', true))]), { workspace: '/ws' })
    expect(loaded).toEqual([])
    expect(failedCritical).toHaveLength(1)
    expect(failedCritical[0].id).toBe('mcp.gate')
    expect(failedCritical[0].error).toMatch(/boom/)
  })

  it('records a CRITICAL loadable whose entry exports no createPlugin in failedCritical', async () => {
    const { loaded, failedCritical } = await discoverTools(broker([subtype('mcp.hook.gate', failMeta('./nofn.mjs', true))]), { workspace: '/ws' })
    expect(loaded).toEqual([])
    expect(failedCritical).toHaveLength(1)
    expect(failedCritical[0].id).toBe('mcp.gate')
    expect(failedCritical[0].error).toMatch(/no createPlugin/)
  })

  it('a NON-critical loadable that throws is skipped, NOT recorded in failedCritical (best-effort)', async () => {
    const { loaded, failedCritical } = await discoverTools(broker([subtype('mcp.hook.opt', failMeta('./throws.mjs', false))]), { workspace: '/ws' })
    expect(loaded).toEqual([])
    expect(failedCritical).toEqual([])
  })

  // The kernel<->plugin handshake: a plugin's declared contractVersion must EQUAL
  // PLUGIN_CONTRACT_VERSION, else it is refused (loud fail-closed, no override — decision 2609091649).
  it('REFUSES a critical plugin at a mismatched contract version (fail closed, like a critical load failure)', async () => {
    const { loaded, failedCritical } = await discoverTools(
      broker([subtype('mcp.hook.gate', versionMeta(PLUGIN_CONTRACT_VERSION + 1, { hook: true, critical: true }))]),
      { workspace: '/ws' },
    )
    expect(loaded).toEqual([])
    expect(failedCritical).toHaveLength(1)
    expect(failedCritical[0].id).toBe('mcp.gate')
    expect(failedCritical[0].error).toMatch(new RegExp(`v${PLUGIN_CONTRACT_VERSION + 1} != kernel-expected v${PLUGIN_CONTRACT_VERSION}`))
  })

  it('SKIPS a non-critical plugin at a mismatched contract version with a loud warning (best-effort, not recorded)', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { loaded, failedCritical } = await discoverTools(
      broker([subtype('mcp.tool.demo', versionMeta(PLUGIN_CONTRACT_VERSION + 1))]),
      { workspace: '/ws' },
    )
    expect(loaded).toEqual([])
    expect(failedCritical).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping mcp.demo'))
    warn.mockRestore()
  })

  it('LOADS a plugin whose contract version equals the kernel-expected version', async () => {
    const { loaded } = await discoverTools(
      broker([subtype('mcp.tool.demo', versionMeta(PLUGIN_CONTRACT_VERSION))]),
      { workspace: '/ws' },
    )
    expect(loaded).toHaveLength(1)
    expect(loaded[0].manifest.contractVersion).toBe(PLUGIN_CONTRACT_VERSION)
  })

  it('records the engine unmet_required_meta per tool (the description gate is the engine, not a STANDIN)', async () => {
    // schema 18: the `mcp.tool` base declares `required: tool-presentation-meta`; the engine reports
    // each concrete subtype's `unmet_required_meta` on the subtypes view. The harness reads it
    // instead of hand-checking "did this tool declare a description".
    const satisfied = { ...subtype('mcp.tool.demo', demoMeta), unmet_required_meta: [] }
    const missingDesc = { ...subtype('mcp.tool.plain', demoMeta), unmet_required_meta: ['tool-presentation-meta'] }
    const { unmetRequiredMeta } = await discoverTools(broker([satisfied, missingDesc]), { workspace: '/ws' })
    expect(unmetRequiredMeta.get('mcp.plain')).toEqual(['tool-presentation-meta']) // the gap the engine flags
    expect(unmetRequiredMeta.has('mcp.demo')).toBe(false) // satisfied -> not recorded
  })
})
