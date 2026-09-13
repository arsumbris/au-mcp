import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import {
  discoverSkills,
  genPath,
  materialize,
  skillKey,
  skillManifest,
  type Skill,
  type SkillTree,
} from '../src/skills/index.ts'
import { deriveSelKey } from '../src/gen/tree.ts'

// HOME is isolated into a SHORT /tmp path: these tests bind real UNIX sockets to probe
// the GC's liveness check, and a long path overruns sun_path (SUN_LEN). This is the same
// constraint that pushed the engine's sockets out of the repo in the first place.
let home: string
let entry: string
const servers: net.Server[] = []

beforeEach(() => {
  home = fs.mkdtempSync(path.join('/tmp', 'au-sk-'))
  // The entry is a folder-repo DIRECTORY (schema 16). materialize only realpaths + hashes
  // it, so the marker is not strictly read here — it is written to keep the fixture honest.
  entry = fs.mkdtempSync(path.join('/tmp', 'au-ws-'))
  fs.mkdirSync(path.join(entry, '.arsumbris'), { recursive: true })
  fs.writeFileSync(path.join(entry, '.arsumbris', 'repo.yaml'), 'name: sk-fixture\n')
})

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(entry, { recursive: true, force: true })
})

// --- fake engine -----------------------------------------------------------------

interface FakeSkill {
  path: string
  owner: string | null
  name?: unknown
  description?: unknown
  related?: string[]
  allowed?: string[]
  body?: string
}

const ok = (result: unknown): EngineFrame => ({ type: 'response', ready: true, result })

/**
 * A broker serving the ONE schema-17 read the driver now composes:
 * `instances_of(mcp.skill, { origins:['file'], instance:true, body:true })`. Each match
 * carries `member` (the owner string), the spliced `instance` value layer, and `body`
 * (the prose AFTER frontmatter — `body:true` already strips it). VERIFIED against the
 * live engine: a `type<mcp.tool>*[]` def-ref field arrives as one `reference` CONTAINER
 * per element with a resolved `target`, NOT scalar wikilink strings.
 */
function broker(fixtures: FakeSkill[], available = true): EngineBroker {
  const refs = (targets: string[]) => targets.map((t) => ({ value: { kind: 'reference', target: t } }))
  const match = (f: FakeSkill) => {
    const values: unknown[] = []
    if (f.name !== undefined) values.push({ field: 'name', containers: [{ value: { kind: 'scalar', value: f.name } }] })
    if (f.description !== undefined)
      values.push({ field: 'description', containers: [{ value: { kind: 'scalar', value: f.description } }] })
    if (f.related) values.push({ field: 'related-tools', containers: refs(f.related) })
    if (f.allowed) values.push({ field: 'allowed-tools', containers: refs(f.allowed) })
    return {
      path: f.path,
      member: f.owner, // string, or null to model "under no declared member"
      type_owners: ['au-mcp-sdk'], // the TYPE identity's owner — never the file's member
      body: f.body ?? '', // the prose after frontmatter (body:true)
      instance: { effective_values: values },
    }
  }
  return {
    socketPath: '/x',
    mutate: async () => ({}),
    available: () => available,
    async read(op): Promise<EngineFrame> {
      if (op === 'instances_of') return ok(fixtures.map(match))
      return ok(null)
    },
  }
}

const skill = (over: Partial<FakeSkill> = {}): FakeSkill => ({
  path: '/ws/a/shout-skill.md',
  owner: 'tool-fixture',
  name: 'shout-helper',
  description: 'When the user wants text SHOUTED.',
  body: '# When to use\n\nThe user asks to shout.\n',
  ...over,
})

// A transform standing in for a real harness's: it only needs to be a pure
// skills -> files mapping, so the driver's IO can be tested without any adapter.
const fakeTransform = (skills: Skill[]): SkillTree => ({
  files: skills.map((s) => ({ relPath: `${s.owner}/skills/${s.name}.md`, content: s.body })),
  pluginRoots: [...new Set(skills.map((s) => s.owner))],
})

// --- discovery -------------------------------------------------------------------

describe('discoverSkills', () => {
  it('assembles a skill from one instances_of (member + instance + body splices)', async () => {
    const { skills, skipped } = await discoverSkills(broker([skill({ related: ['mcp.tool.shout'], allowed: ['mcp.tool.shout'] })]))
    expect(skipped).toEqual([])
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      path: '/ws/a/shout-skill.md',
      owner: 'tool-fixture', // from the match's `member`, NOT its `type_owners`
      name: 'shout-helper',
      relatedTools: ['mcp.tool.shout'],
      allowedTools: ['mcp.tool.shout'],
    })
    expect(skills[0].body).toContain('# When to use')
  })

  it('reads def-ref lists from the reference containers the engine returns', async () => {
    // A `type<mcp.tool>*[]` slot arrives as one `reference` container per element with a
    // resolved `target` — no wikilink-string parsing. One target per authored element,
    // in order.
    const { skills } = await discoverSkills(broker([skill({ allowed: ['mcp.tool.shout', 'mcp.tool.read_file_pinned'] })]))
    expect(skills[0].allowedTools).toEqual(['mcp.tool.shout', 'mcp.tool.read_file_pinned'])
  })

  it('takes the body as prose (body:true already strips frontmatter — no type plumbing leaks)', async () => {
    // The materialized skill must not carry the instance's own frontmatter or def-ref
    // plumbing; `body:true` serves the prose after frontmatter, so the body is clean.
    const { skills } = await discoverSkills(broker([skill()]))
    expect(skills[0].body).not.toContain('type: mcp.skill')
    expect(skills[0].body).not.toMatch(/^---/)
    expect(skills[0].body).toContain('# When to use')
  })

  it('requests only `file` origins, so a nested or meta match cannot yield a bodyless skill', async () => {
    const seen: Record<string, unknown>[] = []
    const inner = broker([skill()])
    const spy: EngineBroker = { ...inner, read: (op, args, t) => (seen.push({ op, ...args }), inner.read(op, args, t)) }
    await discoverSkills(spy)
    expect(seen.find((s) => s.op === 'instances_of')).toMatchObject({ type: 'mcp.skill', origins: ['file'] })
  })

  it('skips an instance missing a required field, reporting it rather than dropping it silently', async () => {
    const { skills, skipped } = await discoverSkills(
      broker([skill({ path: '/ws/a/good.md' }), skill({ path: '/ws/b/nameless.md', name: undefined })]),
    )
    expect(skills.map((s) => s.path)).toEqual(['/ws/a/good.md'])
    expect(skipped).toEqual([{ path: '/ws/b/nameless.md', reason: 'no `name` value (required by mcp.skill)' }])
  })

  it('skips an instance under no declared member', async () => {
    const { skills, skipped } = await discoverSkills(broker([skill({ owner: null })]))
    expect(skills).toEqual([])
    expect(skipped[0].reason).toBe('instance lies under no declared workspace member')
  })

  it('sorts by (owner, name) so a materialized tree is deterministic', async () => {
    const { skills } = await discoverSkills(
      broker([
        skill({ path: '/1.md', owner: 'zeta', name: 'a' }),
        skill({ path: '/2.md', owner: 'alpha', name: 'z' }),
        skill({ path: '/3.md', owner: 'alpha', name: 'b' }),
      ]),
    )
    expect(skills.map((s) => `${s.owner}/${s.name}`)).toEqual(['alpha/b', 'alpha/z', 'zeta/a'])
  })

  it('degrades to nothing (never an error) when no engine is available', async () => {
    await expect(discoverSkills(broker([skill()], false))).resolves.toEqual({ skills: [], skipped: [] })
  })
})

// --- materialize: paths + atomic write --------------------------------------------

describe('materialize', () => {
  it('writes the tree under the socket-keyed gen path and returns absolute plugin dirs', async () => {
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })

    const target = genPath(entry, 'cc', 'all', home)
    expect(target.startsWith(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill'))).toBe(true)
    expect(fs.readFileSync(path.join(target, 'tool-fixture/skills/shout-helper.md'), 'utf8')).toContain('# When to use')
    expect(res.pluginDirs).toEqual([path.join(target, 'tool-fixture')])
    expect(res.skipped).toEqual([])
  })

  it('keys the gen path by the same hash as the engine socket', async () => {
    // The GC's whole no-registry design rests on this: one hash keys both the gen tree
    // and the engine's `au-engine/run/<hash>.sock`, so the socket IS the liveness signal.
    await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    const { socketFileName } = await import('@arsumbris/au-engine-sdk')
    const hash = socketFileName(fs.realpathSync(entry)).replace(/\.sock$/, '')
    expect(genPath(entry, 'cc', 'all', home)).toBe(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill', hash, 'cc', 'all'))
  })

  it('REPLACES the previous generation, so a removed skill vanishes from the tree', async () => {
    await materialize(entry, 'cc', fakeTransform, {
      broker: broker([skill({ path: '/a.md', name: 'first' }), skill({ path: '/b.md', name: 'second' })]),
      home,
    })
    const target = genPath(entry, 'cc', 'all', home)
    expect(fs.existsSync(path.join(target, 'tool-fixture/skills/second.md'))).toBe(true)

    await materialize(entry, 'cc', fakeTransform, { broker: broker([skill({ path: '/a.md', name: 'first' })]), home })
    expect(fs.existsSync(path.join(target, 'tool-fixture/skills/first.md'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'tool-fixture/skills/second.md'))).toBe(false)
  })

  it('leaves no staging directory behind', async () => {
    await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    // The staging dir is a sibling of the target (`.../cc/all`), so its parent (`.../cc`)
    // must hold only the sel-key bucket, no leftover `.staging-` dir.
    const parent = path.dirname(genPath(entry, 'cc', 'all', home))
    expect(fs.readdirSync(parent)).toEqual(['all'])
  })

  it('an empty skill set yields an empty tree and no plugin dirs, never an error', async () => {
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([]), home })
    expect(res.skills).toEqual([])
    expect(res.pluginDirs).toEqual([])
    expect(fs.readdirSync(genPath(entry, 'cc', 'all', home))).toEqual([])
  })
})

// --- materialize: socket-keyed GC --------------------------------------------------

/** Plant a sibling gen tree for `hash`, and return its socket path. */
function plantTree(hash: string): string {
  fs.mkdirSync(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill', hash, 'cc'), { recursive: true })
  const sockets = path.join(home, '.arsumbris', 'au-engine', 'run')
  fs.mkdirSync(sockets, { recursive: true })
  return path.join(sockets, `${hash}.sock`)
}

/** A sibling with a LIVE daemon: a real server bound to its socket. */
async function plantLive(hash: string): Promise<void> {
  const server = net.createServer()
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(plantTree(hash), resolve))
}

/**
 * A sibling whose daemon CRASHED: bind a real socket in a child process, then SIGKILL
 * it. The inode survives (only a clean shutdown unlinks), so connecting gets
 * ECONNREFUSED — the exact stale-socket state the GC must recognise. Faking this with
 * a regular file would test a different errno than production ever sees.
 */
async function plantCrashed(hash: string): Promise<void> {
  const socket = plantTree(hash)
  const binder = path.join(home, 'binder.mjs')
  fs.writeFileSync(binder, `import net from 'node:net'
net.createServer().listen(process.argv[2], () => console.log('bound'))
setInterval(() => {}, 1000)
`)
  const child = spawn(process.execPath, [binder, socket])
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (!fs.existsSync(socket)) throw new Error('fixture invalid: the crashed socket did not survive')
}

describe('materialize / socket-keyed GC', () => {
  it('sweeps a sibling whose daemon CRASHED, leaving a stale socket inode', async () => {
    await plantCrashed('dead0000deadbeef')
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    expect(res.collected).toEqual(['dead0000deadbeef'])
    expect(fs.existsSync(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill', 'dead0000deadbeef'))).toBe(false)
  })

  it('sweeps a sibling with NO socket file at all', async () => {
    fs.mkdirSync(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill', 'orphan0000000000'), { recursive: true })
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    expect(res.collected).toEqual(['orphan0000000000'])
  })

  it('sweeps a sibling whose socket path holds a junk regular file', async () => {
    fs.writeFileSync(plantTree('junk0000000000ff'), '')
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    expect(res.collected).toEqual(['junk0000000000ff'])
  })

  it('KEEPS a sibling whose socket is connectable — existence alone is not liveness', async () => {
    await plantLive('live0000feedface')
    await plantCrashed('dead0000deadbeef')
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    expect(res.collected).toEqual(['dead0000deadbeef'])
    expect(fs.existsSync(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill', 'live0000feedface'))).toBe(true)
  })

  it('never sweeps the workspace it is materializing for', async () => {
    // Our own daemon need not be connectable for our own tree to survive the sweep.
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    expect(res.collected).toEqual([])
    expect(fs.existsSync(genPath(entry, 'cc', 'all', home))).toBe(true)
  })

  it('sweeps a dead workspace WHOLESALE, including every sel-key subtree beneath it', async () => {
    // The sel-key segment sits below the ws-hash, and GC deletes the ws-hash subtree
    // wholesale, so multiple sel-key buckets are swept for free with no GC change.
    await plantCrashed('dead0000deadbeef')
    const capRoot = path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill', 'dead0000deadbeef', 'cc')
    fs.mkdirSync(path.join(capRoot, 'all'), { recursive: true })
    fs.mkdirSync(path.join(capRoot, 'reviewer-abc123'), { recursive: true })
    fs.mkdirSync(path.join(capRoot, 'adhoc-def456'), { recursive: true })

    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker([skill()]), home })
    expect(res.collected).toEqual(['dead0000deadbeef'])
    expect(fs.existsSync(path.join(home, '.arsumbris', 'au-mcp', 'gen', 'skill', 'dead0000deadbeef'))).toBe(false)
  })
})

// --- materialize: the selection filter (host agent-profiles) -----------------------

describe('materialize / select', () => {
  const three = () => [
    skill({ path: '/a.md', owner: 'au-host', name: 'orchestrate' }),
    skill({ path: '/b.md', owner: 'au-host', name: 'inspect' }),
    skill({ path: '/c.md', owner: 'tool-fixture', name: 'shout-helper' }),
  ]

  it('materializes ONLY the selected keys, dropping an owner with none selected', async () => {
    const res = await materialize(entry, 'cc', fakeTransform, {
      broker: broker(three()),
      home,
      select: ['au-host:orchestrate', 'tool-fixture:shout-helper'],
    })
    // au-host keeps only orchestrate; the unselected au-host:inspect and the whole
    // owner boundary stay intact.
    expect(res.skills.map(skillKey).sort()).toEqual(['au-host:orchestrate', 'tool-fixture:shout-helper'])
    expect(res.pluginDirs.map((d) => path.basename(d)).sort()).toEqual(['au-host', 'tool-fixture'])
    // The materialized tree contains orchestrate but not the unselected inspect.
    const base = genPath(entry, 'cc', deriveSelKey(['au-host:orchestrate', 'tool-fixture:shout-helper']), home)
    expect(fs.existsSync(path.join(base, 'au-host/skills/orchestrate.md'))).toBe(true)
    expect(fs.existsSync(path.join(base, 'au-host/skills/inspect.md'))).toBe(false)
  })

  it('drops an owner entirely when none of its skills are selected', async () => {
    const res = await materialize(entry, 'cc', fakeTransform, {
      broker: broker(three()),
      home,
      select: ['tool-fixture:shout-helper'],
    })
    expect(res.skills.map((s) => s.owner)).toEqual(['tool-fixture'])
    expect(res.pluginDirs.map((d) => path.basename(d))).toEqual(['tool-fixture'])
  })

  it('an empty select materializes NOTHING (an explicit empty profile)', async () => {
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker(three()), home, select: [] })
    expect(res.skills).toEqual([])
    expect(res.pluginDirs).toEqual([])
  })

  it('no select materializes ALL (the default is unchanged)', async () => {
    const res = await materialize(entry, 'cc', fakeTransform, { broker: broker(three()), home })
    expect(res.skills).toHaveLength(3)
  })

  it('still reports a SKIPPED skill even when the selection would not include it', async () => {
    // Discovery drives skipped from the FULL set, so an authoring error surfaces regardless
    // of what a profile selected.
    const res = await materialize(entry, 'cc', fakeTransform, {
      broker: broker([skill({ path: '/ok.md', name: 'ok' }), skill({ path: '/bad.md', name: undefined })]),
      home,
      select: ['tool-fixture:ok'],
    })
    expect(res.skills.map((s) => s.name)).toEqual(['ok'])
    expect(res.skipped).toEqual([{ path: '/bad.md', reason: 'no `name` value (required by mcp.skill)' }])
  })
})

// --- the selection-key path segment (concurrent-profile isolation) -----------------

describe('materialize / selection-key path', () => {
  const three = () => [
    skill({ path: '/a.md', owner: 'au-host', name: 'orchestrate' }),
    skill({ path: '/b.md', owner: 'au-host', name: 'inspect' }),
    skill({ path: '/c.md', owner: 'tool-fixture', name: 'shout-helper' }),
  ]

  it('two different selections write to two distinct paths, neither clobbering the other', async () => {
    await materialize(entry, 'cc', fakeTransform, { broker: broker(three()), home, select: ['au-host:orchestrate'] })
    await materialize(entry, 'cc', fakeTransform, { broker: broker(three()), home, select: ['tool-fixture:shout-helper'] })

    const pathA = genPath(entry, 'cc', deriveSelKey(['au-host:orchestrate']), home)
    const pathB = genPath(entry, 'cc', deriveSelKey(['tool-fixture:shout-helper']), home)
    expect(pathA).not.toBe(pathB)
    expect(fs.existsSync(path.join(pathA, 'au-host/skills/orchestrate.md'))).toBe(true)
    expect(fs.existsSync(path.join(pathB, 'tool-fixture/skills/shout-helper.md'))).toBe(true)
    // Launch B did not overwrite launch A's bucket.
    expect(fs.existsSync(path.join(pathA, 'tool-fixture'))).toBe(false)
  })

  it('the same selection maps to one shared key, independent of ref order', () => {
    const forward = deriveSelKey(['au-host:orchestrate', 'tool-fixture:shout-helper'])
    const reversed = deriveSelKey(['tool-fixture:shout-helper', 'au-host:orchestrate'])
    expect(forward).toBe(reversed)
  })

  it('an absent selection lands in the `all` bucket', async () => {
    await materialize(entry, 'cc', fakeTransform, { broker: broker(three()), home })
    expect(deriveSelKey(undefined)).toBe('all')
    expect(fs.existsSync(genPath(entry, 'cc', 'all', home))).toBe(true)
  })

  it('a supplied profile name becomes a readable prefix on the sel-key', async () => {
    const key = deriveSelKey(['au-host:orchestrate'], 'reviewer')
    expect(key.startsWith('reviewer-')).toBe(true)
    await materialize(entry, 'cc', fakeTransform, {
      broker: broker(three()),
      home,
      select: ['au-host:orchestrate'],
      profileName: 'reviewer',
    })
    expect(fs.existsSync(genPath(entry, 'cc', key, home))).toBe(true)
  })

  it('an absent profile name falls back to the adhoc- prefix', () => {
    expect(deriveSelKey(['au-host:orchestrate']).startsWith('adhoc-')).toBe(true)
  })

  it('an empty selection is a bucket distinct from the absent `all`', () => {
    // A deliberately empty profile (materialize NOTHING) must not share the no-selection bucket.
    expect(deriveSelKey([])).not.toBe('all')
    expect(deriveSelKey([]).startsWith('adhoc-')).toBe(true)
  })
})

// --- skillManifest: the host picker surface ---------------------------------------

describe('skillManifest', () => {
  it('projects owner/name/description/key + agent-facing allowedTools, omitting the body', async () => {
    const manifest = await skillManifest(entry, {
      broker: broker([skill({ allowed: ['mcp.tool.shout', 'mcp.tool.read_file_pinned'] })]),
    })
    expect(manifest.skills).toEqual([
      {
        key: 'tool-fixture:shout-helper',
        owner: 'tool-fixture',
        name: 'shout-helper',
        description: 'When the user wants text SHOUTED.',
        allowedTools: ['shout', 'read_file_pinned'], // agent-facing base names — mcp.tool. stripped
        path: '/ws/a/shout-skill.md',
      },
    ])
    // No body key leaked into the manifest.
    expect(Object.keys(manifest.skills[0])).not.toContain('body')
  })

  it('carries the skipped instances with reasons (the discovery-debug surface)', async () => {
    const manifest = await skillManifest(entry, {
      broker: broker([skill({ path: '/ok.md', name: 'ok' }), skill({ path: '/bad.md', name: undefined })]),
    })
    expect(manifest.skills.map((s) => s.name)).toEqual(['ok'])
    expect(manifest.skipped).toEqual([{ path: '/bad.md', reason: 'no `name` value (required by mcp.skill)' }])
  })

  it('the manifest key round-trips as a materialize select ref', async () => {
    const b = broker([skill()])
    const manifest = await skillManifest(entry, { broker: b })
    const res = await materialize(entry, 'cc', fakeTransform, { broker: b, home, select: manifest.skills.map((s) => s.key) })
    expect(res.skills.map(skillKey)).toEqual(manifest.skills.map((s) => s.key))
  })
})
