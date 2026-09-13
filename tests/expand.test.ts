import { describe, it, expect } from 'vitest'

import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import { expandInjects, sizeInject } from '../src/inject/index.ts'
import type { Inject } from '../src/inject/discover.ts'

const inject = (over: Partial<Inject> = {}): Inject => ({
  path: '/ws/moc.md',
  owner: 'au-mcp-workspace',
  role: 'entry',
  name: 'file-writing-rules',
  description: 'How to write files.',
  depth: 0,
  edgeKinds: [],
  show: 'body',
  body: '# Rules MOC\n\n- [[rule-a]]\n- [[rule-b]]\n',
  ...over,
})

const ok = (result: unknown): EngineFrame => ({ type: 'response', ready: true, result })

/**
 * A broker serving `neighborhood`, recording the args so a test can assert the enrichment flag
 * and the kinds forwarding. `nodes` are returned as-is; a test controls depth/body/content.
 */
function broker(nodes: unknown[], calls: { op: string; args: Record<string, unknown> }[] = []): EngineBroker {
  return {
    socketPath: '/x',
    mutate: async () => ({}),
    available: () => true,
    read: async (op, args = {}) => {
      calls.push({ op, args })
      if (op === 'neighborhood') return ok({ nodes, edges: [], truncated: false, dropped: [] })
      return ok(null)
    },
  }
}

/** A neighborhood node. Own-repo nodes carry no `repo`. */
const node = (path: string, depth: number, body: string, repo?: string) => ({ path, depth, body, file_kind: 'note', repo })

describe('expandInjects', () => {
  it('a depth-0 inject is ONE seed block from the discovered body (no walk)', async () => {
    const calls: { op: string; args: Record<string, unknown> }[] = []
    const blocks = await expandInjects([inject({ depth: 0 })], broker([], calls))
    expect(calls.find((c) => c.op === 'neighborhood')).toBeUndefined() // no engine walk at depth 0
    expect(blocks).toEqual([
      { key: 'au-mcp-workspace:file-writing-rules', stem: 'moc', repo: 'au-mcp-workspace', body: '# Rules MOC\n\n- [[rule-a]]\n- [[rule-b]]\n' },
    ])
  })

  it('the FLAGSHIP: a depth-1 MOC-as-seed walks to its rules, seed-first', async () => {
    const nodes = [
      node('/ws/rules/rule-b.md', 1, '# Rule B\n\nSplit at commas.\n'),
      node('/ws/moc.md', 0, '# Rules MOC\n\n- [[rule-a]]\n- [[rule-b]]\n'), // seed, returned out of order
      node('/ws/rules/rule-a.md', 1, '# Rule A\n\nOne fact per line.\n'),
    ]
    const calls: { op: string; args: Record<string, unknown> }[] = []
    const blocks = await expandInjects([inject({ depth: 1 })], broker(nodes, calls))
    // depth 1 with no edge-kinds: kinds omitted (follow all — the MOC is the curation).
    expect(calls[0]).toEqual({ op: 'neighborhood', args: { path: '/ws/moc.md', direction: 'out', depth: 1, body: true } })
    // Seed-first (min-depth) order; the MOC list then each rule body.
    expect(blocks.map((b) => b.stem)).toEqual(['moc', 'rule-a', 'rule-b'])
    expect(blocks[1].body).toContain('One fact per line')
  })

  it('forwards edge-kinds when set (depth >= 2 blast control)', async () => {
    const calls: { op: string; args: Record<string, unknown> }[] = []
    await expandInjects([inject({ depth: 2, edgeKinds: ['field-reference'] })], broker([node('/ws/moc.md', 0, 'x')], calls))
    expect(calls[0].args).toMatchObject({ depth: 2, kinds: ['field-reference'] })
  })

  it('show: body-and-frontmatter walks with content:true and reads the whole-file field', async () => {
    const nodes = [{ path: '/ws/rec.md', depth: 0, file_kind: 'instance', content: '---\nk: v\n---\n# Rec\n' }]
    const calls: { op: string; args: Record<string, unknown> }[] = []
    const blocks = await expandInjects([inject({ depth: 0 + 1, show: 'body-and-frontmatter' })], broker(nodes, calls))
    expect(calls[0].args).toMatchObject({ content: true })
    expect(blocks[0].body).toContain('k: v') // the whole file, frontmatter included
  })

  it('skips a node with no injectable text (an asset / null-body node)', async () => {
    const nodes = [
      node('/ws/moc.md', 0, '# MOC\n'),
      { path: '/ws/diagram.png', depth: 1, file_kind: 'asset', body: null }, // reached by a file* edge
    ]
    const blocks = await expandInjects([inject({ depth: 1 })], broker(nodes))
    // Null is not zero content: the asset is dropped, not packed as empty.
    expect(blocks.map((b) => b.stem)).toEqual(['moc'])
  })

  it('addresses an own-repo node against the seed owner, a cross-repo node against its repo', async () => {
    const nodes = [
      node('/ws/moc.md', 0, '# MOC\n'), // own-repo: no `repo`
      node('/peer/x.md', 1, '# X\n', 'peer-repo'), // cross-repo: carries repo
    ]
    const blocks = await expandInjects([inject({ depth: 1 })], broker(nodes))
    expect(blocks.map((b) => [b.stem, b.repo])).toEqual([
      ['moc', 'au-mcp-workspace'], // fell back to the seed owner
      ['x', 'peer-repo'],
    ])
  })

  it('degrades to the seed block when the walk ERRORS (e.g. depth>=2 with no kinds)', async () => {
    const b: EngineBroker = {
      socketPath: '/x',
      mutate: async () => ({}),
      available: () => true,
      read: async (op) => (op === 'neighborhood' ? ({ type: 'error', ready: true } as EngineFrame) : ok(null)),
    }
    const blocks = await expandInjects([inject({ depth: 2 })], b)
    // The hop failed, but the inject's own content is never lost — the seed block still lands.
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ stem: 'moc', repo: 'au-mcp-workspace' })
  })

  it('degrades to the seed block when the walk returns NO nodes', async () => {
    const blocks = await expandInjects([inject({ depth: 1 })], broker([]))
    expect(blocks.map((b) => b.stem)).toEqual(['moc'])
  })
})

describe('sizeInject (the picker cost meter)', () => {
  it('a depth-0 inject is sized from the body it already holds (no walk)', async () => {
    const calls: { op: string; args: Record<string, unknown> }[] = []
    const size = await sizeInject(inject({ depth: 0, body: 'twelve chars' }), broker([], calls))
    expect(size).toBe('twelve chars'.length)
    expect(calls.find((c) => c.op === 'neighborhood')).toBeUndefined() // no content fetch to size
  })

  it('sums body_bytes over the UNENRICHED walk (size before content)', async () => {
    const nodes = [
      { path: '/ws/moc.md', depth: 0, body_bytes: 40 },
      { path: '/ws/rule-a.md', depth: 1, body_bytes: 100 },
      { path: '/ws/rule-b.md', depth: 1, body_bytes: 60 },
    ]
    const calls: { op: string; args: Record<string, unknown> }[] = []
    const size = await sizeInject(inject({ depth: 1 }), broker(nodes, calls))
    expect(size).toBe(200)
    // the sizing walk requests NO body/content — just the sizes.
    expect(calls[0].args).not.toHaveProperty('body')
    expect(calls[0].args).not.toHaveProperty('content')
  })

  it('uses bytes (whole file) when show is body-and-frontmatter', async () => {
    const nodes = [{ path: '/ws/rec.md', depth: 0, bytes: 512, body_bytes: 300 }]
    const size = await sizeInject(inject({ depth: 1, show: 'body-and-frontmatter' }), broker(nodes))
    expect(size).toBe(512)
  })

  it('a null size (asset) contributes nothing to the estimate', async () => {
    const nodes = [
      { path: '/ws/moc.md', depth: 0, body_bytes: 30 },
      { path: '/ws/img.png', depth: 1, body_bytes: null },
    ]
    expect(await sizeInject(inject({ depth: 1 }), broker(nodes))).toBe(30)
  })
})
