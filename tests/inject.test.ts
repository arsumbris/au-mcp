import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import { discoverInjects, genPath as injectGenPath, inDefaultSet, injectManifest, materializeInjects, type InjectBlock, type InjectTree } from '../src/inject/index.ts'
import { deriveSelKey } from '../src/gen/tree.ts'

// --- fake engine -----------------------------------------------------------------

interface FakeInject {
  path: string
  owner: string | null
  name?: unknown
  description?: unknown
  depth?: number
  edgeKinds?: string[]
  show?: string
  body?: string
}

/** The member roster the `members` read returns: member name -> role. */
type Roles = Record<string, 'entry' | 'edit' | 'discover' | 'dep'>

const ok = (result: unknown): EngineFrame => ({ type: 'response', ready: true, result })

/**
 * A broker serving the TWO reads inject discovery composes:
 * - `instances_of(mcp.inject, { origins:['file'], instance:true, body:true })` for the injects.
 * - `members` for the roles, joined by member name.
 *
 * The role join is the whole difference from skill discovery. The `members` result is a
 * `WireMember[]`; only `repo` (the member name) and `role` matter to the join, the rest is
 * padded to keep the fixture shape honest.
 */
function broker(fixtures: FakeInject[], roles: Roles, opts: { available?: boolean; membersFail?: boolean } = {}): EngineBroker {
  const match = (f: FakeInject) => {
    const values: unknown[] = []
    if (f.name !== undefined) values.push({ field: 'name', containers: [{ value: { kind: 'scalar', value: f.name } }] })
    if (f.description !== undefined)
      values.push({ field: 'description', containers: [{ value: { kind: 'scalar', value: f.description } }] })
    if (f.depth !== undefined) values.push({ field: 'depth', containers: [{ value: { kind: 'scalar', value: f.depth } }] })
    if (f.edgeKinds)
      values.push({ field: 'edge-kinds', containers: f.edgeKinds.map((k) => ({ value: { kind: 'scalar', value: k } })) })
    if (f.show !== undefined) values.push({ field: 'show', containers: [{ value: { kind: 'scalar', value: f.show } }] })
    return {
      path: f.path,
      member: f.owner, // string, or null to model "under no declared member"
      type_owners: ['au-mcp-sdk'],
      body: f.body ?? '',
      instance: { effective_values: values },
    }
  }
  const memberRows = Object.entries(roles).map(([repo, role]) => ({ repo, role, editable: true, local: true, scattered: false }))
  return {
    socketPath: '/x',
    mutate: async () => ({}),
    available: () => opts.available ?? true,
    async read(op): Promise<EngineFrame> {
      if (op === 'instances_of') return ok(fixtures.map(match))
      if (op === 'members') return opts.membersFail ? { type: 'error', ready: true } : ok(memberRows)
      return ok(null)
    },
  }
}

const inject = (over: Partial<FakeInject> = {}): FakeInject => ({
  path: '/ws/a/orientation.md',
  owner: 'au-mcp-workspace',
  name: 'knowledge-base-orientation',
  description: 'What this workspace is.',
  body: '# Orientation\n\nThis is the dev workspace.\n',
  ...over,
})

const ENTRY_ROLE: Roles = { 'au-mcp-workspace': 'entry' }

// --- discovery -------------------------------------------------------------------

describe('discoverInjects', () => {
  it('assembles an inject from the instances_of + members join', async () => {
    const { injects, skipped } = await discoverInjects(broker([inject()], ENTRY_ROLE))
    expect(skipped).toEqual([])
    expect(injects).toHaveLength(1)
    expect(injects[0]).toMatchObject({
      path: '/ws/a/orientation.md',
      owner: 'au-mcp-workspace',
      role: 'entry',
      name: 'knowledge-base-orientation',
      description: 'What this workspace is.',
      depth: 0,
      edgeKinds: [],
      show: 'body',
    })
    expect(injects[0].body).toContain('# Orientation')
  })

  it('reads the show mode, defaulting to body when unset', async () => {
    const dflt = await discoverInjects(broker([inject()], ENTRY_ROLE))
    expect(dflt.injects[0].show).toBe('body')
    const full = await discoverInjects(broker([inject({ show: 'body-and-frontmatter' })], ENTRY_ROLE))
    expect(full.injects[0].show).toBe('body-and-frontmatter')
    // An off-enum value cannot pass engine validation, but discovery must not crash on one;
    // it falls back to the safe `body` default rather than propagating an unknown mode.
    const bogus = await discoverInjects(broker([inject({ show: 'everything' })], ENTRY_ROLE))
    expect(bogus.injects[0].show).toBe('body')
  })

  it('carries the owner ROLE joined from the members read', async () => {
    // The field with no mcp.skill counterpart. Discovery only CARRIES it; the default-set
    // partition (entry/edit in, dep/discover opt-in) is phase 2 and applies no policy here.
    const fixtures = [
      inject({ path: '/ws/a/entry.md', name: 'a', owner: 'au-mcp-workspace' }),
      inject({ path: '/ws/b/dep.md', name: 'b', owner: 'au-mcp-sdk' }),
    ]
    const { injects } = await discoverInjects(broker(fixtures, { 'au-mcp-workspace': 'entry', 'au-mcp-sdk': 'dep' }))
    // Output is (owner, name)-sorted, so au-mcp-sdk (dep) precedes au-mcp-workspace (entry).
    expect(injects.map((i) => [i.owner, i.role])).toEqual([
      ['au-mcp-sdk', 'dep'],
      ['au-mcp-workspace', 'entry'],
    ])
  })

  it('reads depth as a number and edge-kinds as an ordered enum list', async () => {
    const { injects } = await discoverInjects(
      broker([inject({ depth: 2, edgeKinds: ['field-reference', 'contributing'] })], ENTRY_ROLE),
    )
    expect(injects[0].depth).toBe(2)
    expect(injects[0].edgeKinds).toEqual(['field-reference', 'contributing'])
  })

  it('takes the body as prose (body:true already strips frontmatter)', async () => {
    const { injects } = await discoverInjects(broker([inject()], ENTRY_ROLE))
    expect(injects[0].body).not.toMatch(/^---/)
    expect(injects[0].body).not.toContain('type: mcp.inject')
    expect(injects[0].body).toContain('# Orientation')
  })

  // --- the skipped set: never silently dropped ---------------------------------

  it('skips an inject missing a required name or description', async () => {
    const fixtures = [
      inject({ path: '/ws/a/no-name.md', name: undefined }),
      inject({ path: '/ws/b/no-desc.md', name: 'b', description: undefined }),
    ]
    const { injects, skipped } = await discoverInjects(broker(fixtures, ENTRY_ROLE))
    expect(injects).toEqual([])
    expect(skipped.map((s) => s.path)).toEqual(['/ws/a/no-name.md', '/ws/b/no-desc.md'])
    expect(skipped[0].reason).toMatch(/name/)
    expect(skipped[1].reason).toMatch(/description/)
  })

  it('skips an inject under no declared member', async () => {
    const { injects, skipped } = await discoverInjects(broker([inject({ owner: null })], ENTRY_ROLE))
    expect(injects).toEqual([])
    expect(skipped[0].reason).toMatch(/no declared workspace member/)
  })

  it('skips an inject whose member has no known role, rather than defaulting it in', async () => {
    // The trust-boundary failure mode: an inject with an unresolvable role must NOT enter a
    // session. Skipping is the safe direction; guessing a role is the mistake this prevents.
    const { injects, skipped } = await discoverInjects(broker([inject({ owner: 'ghost-member' })], ENTRY_ROLE))
    expect(injects).toEqual([])
    expect(skipped[0].reason).toMatch(/'ghost-member' has no known role/)
  })

  it('skips every inject when the members read fails, never admitting an unroled one', async () => {
    const { injects, skipped } = await discoverInjects(broker([inject()], ENTRY_ROLE, { membersFail: true }))
    expect(injects).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toMatch(/has no known role/)
  })

  // --- the one-read hygiene skill discovery already established -----------------

  it('requests only file origins (a nested/meta match cannot yield a bodyless inject)', async () => {
    let sawArgs: Record<string, unknown> | undefined
    const b: EngineBroker = {
      socketPath: '/x',
      mutate: async () => ({}),
      available: () => true,
      async read(op, args): Promise<EngineFrame> {
        if (op === 'instances_of') {
          sawArgs = args
          return ok([])
        }
        if (op === 'members') return ok([])
        return ok(null)
      },
    }
    await discoverInjects(b)
    expect(sawArgs).toMatchObject({ type: 'mcp.inject', origins: ['file'], instance: true, body: true })
  })

  it('dedupes by path (a bare type name matches every same-named identity)', async () => {
    const dup = inject()
    const { injects } = await discoverInjects(broker([dup, dup], ENTRY_ROLE))
    expect(injects).toHaveLength(1)
  })

  it('sorts by (owner, name) for a deterministic materialized tree', async () => {
    const fixtures = [
      inject({ path: '/z', owner: 'z-owner', name: 'a' }),
      inject({ path: '/a2', owner: 'a-owner', name: 'b' }),
      inject({ path: '/a1', owner: 'a-owner', name: 'a' }),
    ]
    const { injects } = await discoverInjects(broker(fixtures, { 'z-owner': 'edit', 'a-owner': 'edit' }))
    expect(injects.map((i) => [i.owner, i.name])).toEqual([
      ['a-owner', 'a'],
      ['a-owner', 'b'],
      ['z-owner', 'a'],
    ])
  })

  it('degrades to empty on an unavailable engine (no injects to materialize is a no-op)', async () => {
    const { injects, skipped } = await discoverInjects(broker([inject()], ENTRY_ROLE, { available: false }))
    expect(injects).toEqual([])
    expect(skipped).toEqual([])
  })
})

// --- the manifest (the host picker projection) -----------------------------------

describe('injectManifest', () => {
  it('projects each inject with role + estimated bytes, plus skipped-with-reasons', async () => {
    const fixtures = [
      inject({ path: '/e/a.md', name: 'a', owner: 'w-entry', body: 'ten bytes!' }), // depth 0 => body length
      inject({ path: '/d/b.md', name: 'b', owner: 'w-dep' }),
      inject({ path: '/x/broken.md', name: undefined, owner: 'w-entry' }), // no name => skipped
    ]
    const manifest = await injectManifest('/ws', {
      broker: broker(fixtures, { 'w-entry': 'entry', 'w-dep': 'dep' }),
    })
    // (owner, name)-sorted; both valid injects present with role + bytes.
    expect(manifest.injects.map((i) => [i.key, i.role])).toEqual([
      ['w-dep:b', 'dep'],
      ['w-entry:a', 'entry'],
    ])
    const a = manifest.injects.find((i) => i.key === 'w-entry:a')
    expect(a?.bytes).toBe('ten bytes!'.length) // depth 0 sized from the body
    expect(a?.description).toBe('What this workspace is.')
    // the malformed instance is visible by absence, not silently gone.
    expect(manifest.skipped).toHaveLength(1)
    expect(manifest.skipped[0].path).toBe('/x/broken.md')
  })

  it('carries no body (the picker shows description + cost, not content)', async () => {
    const manifest = await injectManifest('/ws', { broker: broker([inject()], ENTRY_ROLE) })
    expect(manifest.injects[0]).not.toHaveProperty('body')
  })
})

// --- the role-scoped default set (the trust boundary) ----------------------------

describe('inDefaultSet', () => {
  it('admits the editable authoring surfaces, excludes the consumed members', () => {
    expect(inDefaultSet({ role: 'entry' })).toBe(true)
    expect(inDefaultSet({ role: 'edit' })).toBe(true)
    expect(inDefaultSet({ role: 'dep' })).toBe(false)
    expect(inDefaultSet({ role: 'discover' })).toBe(false)
  })
})

describe('materializeInjects — the default-set partition', () => {
  let home: string
  let entry: string

  beforeEach(() => {
    home = fs.mkdtempSync('/tmp/au-inj-')
    entry = fs.mkdtempSync('/tmp/au-iws-')
    fs.mkdirSync(path.join(entry, '.arsumbris'), { recursive: true })
    fs.writeFileSync(path.join(entry, '.arsumbris', 'repo.yaml'), 'name: inj-fixture\n')
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(entry, { recursive: true, force: true })
  })

  // A pure transform standing in for a real harness's — the partition is what's under test,
  // so the transform only needs to be a valid blocks -> tree mapping (no packing/overflow).
  const fakeTransform = (blocks: InjectBlock[]): InjectTree => ({
    files: blocks.map((b) => ({ relPath: `${b.key}.md`, content: b.body })),
    pluginRoots: blocks.length ? ['inj'] : [],
    dropped: [],
  })

  // A workspace with one inject per role, so the partition is observable end to end.
  const MIXED = [
    inject({ path: '/e/a.md', name: 'a', owner: 'w-entry' }),
    inject({ path: '/d/b.md', name: 'b', owner: 'w-edit' }),
    inject({ path: '/c/c.md', name: 'c', owner: 'w-dep' }),
    inject({ path: '/s/d.md', name: 'd', owner: 'w-discover' }),
  ]
  const ROLES = { 'w-entry': 'entry', 'w-edit': 'edit', 'w-dep': 'dep', 'w-discover': 'discover' } as const

  it('materializes ONLY entry/edit injects with no selection (a dep cannot inject into a bare launch)', async () => {
    const res = await materializeInjects(entry, 'cc', fakeTransform, { home, broker: broker(MIXED, ROLES) })
    expect(res.injects.map((i) => i.name).sort()).toEqual(['a', 'b'])
    // the consumed members' injects were discovered but withheld from the default set
    expect(res.injects.some((i) => i.role === 'dep' || i.role === 'discover')).toBe(false)
  })

  it('opts a dep inject in when it is EXPLICITLY selected', async () => {
    const res = await materializeInjects(entry, 'cc', fakeTransform, {
      home,
      broker: broker(MIXED, ROLES),
      select: ['w-dep:c'],
    })
    // an explicit selection is exact: only the named inject, role notwithstanding
    expect(res.injects.map((i) => i.name)).toEqual(['c'])
    expect(res.injects[0].role).toBe('dep')
  })

  it('an empty selection materializes nothing, distinct from absent (all of the default set)', async () => {
    const none = await materializeInjects(entry, 'cc', fakeTransform, { home, broker: broker(MIXED, ROLES), select: [] })
    expect(none.injects).toEqual([])
    expect(none.pluginDirs).toEqual([])
  })

  it('keys the inject tree by its OWN selection, in the inject capability root', async () => {
    // Independent per-capability keying: the inject sel-key derives from the inject selection,
    // under `gen/inject/...`, never cross-keyed with the skills selection.
    await materializeInjects(entry, 'cc', fakeTransform, { home, broker: broker(MIXED, ROLES), select: ['w-dep:c'] })
    const target = injectGenPath(entry, 'cc', deriveSelKey(['w-dep:c']), home)
    expect(target.startsWith(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'inject'))).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    // A different inject selection is a different bucket.
    expect(injectGenPath(entry, 'cc', deriveSelKey(['w-dep:c']), home))
      .not.toBe(injectGenPath(entry, 'cc', deriveSelKey(['w-entry:a']), home))
  })
})
