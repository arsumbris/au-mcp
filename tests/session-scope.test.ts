import { describe, it, expect } from 'vitest'
import { resolveSessionScope } from '../src/daemon/session-scope.ts'
import { parseProfileNameAllowlist, parseProfileNativeToolAllowlist, type ProfileRow } from '../src/daemon/profile-config.ts'
import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'

// resolveSessionScope (decision 2609071712): the kernel resolves active-vs-mounted tools/skills +
// members + profile ONCE at session-open. mounted = what the workspace provides; active = mounted ∩
// the profile's tools/skills allowlist (absent -> unrestricted). Best-effort on a down engine.

function fakeBroker(members: string[], opts: { available?: boolean } = {}): EngineBroker {
  return {
    socketPath: '/fake/engine.sock',
    available: () => opts.available ?? true,
    read: async (op: string): Promise<EngineFrame> => {
      if (op === 'members') return { result: members.map((repo) => ({ repo })) }
      // discoverSkills issues instances_of('mcp.skill'); return none for these tests.
      return { result: [] }
    },
    mutate: async () => ({}),
  }
}

/** An agent-profile row with the given name + optional tools/skills/native-tools allowlist fields. */
function profileRows(name: string, fields: { tools?: unknown; skills?: unknown; nativeToolAllowlist?: unknown } = {}): ProfileRow[] {
  return [{ path: `/ws/${name}.md`, fields: { name, ...fields } }]
}

describe('parseProfileNameAllowlist', () => {
  it('is undefined when the field is absent (unrestricted)', () => {
    expect(parseProfileNameAllowlist(profileRows('p'), 'p', 'tools')).toBeUndefined()
  })
  it('is an empty set for an empty list (none)', () => {
    expect(parseProfileNameAllowlist(profileRows('p', { tools: [] }), 'p', 'tools')).toEqual(new Set())
  })
  it('reduces def-ref wikilinks to bare names', () => {
    const set = parseProfileNameAllowlist(profileRows('p', { tools: ['[[mcp.tool.au_declare::au-provenance]]', '[[mcp.tool.read_file_pinned]]'] }), 'p', 'tools')
    expect(set).toEqual(new Set(['au_declare', 'read_file_pinned']))
  })
  it('reads the skills field independently', () => {
    expect(parseProfileNameAllowlist(profileRows('p', { skills: ['[[build-a-plugin::au-mcp-sdk]]'] }), 'p', 'skills')).toEqual(
      new Set(['build-a-plugin']),
    )
  })
})

describe('parseProfileNativeToolAllowlist', () => {
  it('is undefined when the field is absent (every native tool allowed)', () => {
    expect(parseProfileNativeToolAllowlist(profileRows('p'), 'p')).toBeUndefined()
  })
  it('is an empty list for an empty list (no native tool)', () => {
    expect(parseProfileNativeToolAllowlist(profileRows('p', { nativeToolAllowlist: [] }), 'p')).toEqual([])
  })
  it('reads raw native-tool names, no def-ref reduction', () => {
    expect(parseProfileNativeToolAllowlist(profileRows('p', { nativeToolAllowlist: ['Read', 'WebFetch'] }), 'p')).toEqual([
      'Read',
      'WebFetch',
    ])
  })
})

describe('resolveSessionScope', () => {
  const toolIds = ['mcp.read_file_pinned', 'mcp.write_file', 'mcp.au_instances_of']

  it('unrestricted profile: active == mounted, members from the engine, toolAllowlist undefined', async () => {
    const { scope, toolAllowlist } = await resolveSessionScope({
      broker: fakeBroker(['au-mcp', 'au-mcp-core']),
      toolManifestIds: toolIds,
      profile: 'p',
      profileRows: profileRows('p'), // no tools/skills allowlist -> unrestricted
    })
    expect(scope.tools.mounted).toEqual(['read_file_pinned', 'write_file', 'au_instances_of'])
    expect(scope.tools.active).toEqual(['read_file_pinned', 'write_file', 'au_instances_of'])
    expect(scope.members).toEqual(['au-mcp', 'au-mcp-core'])
    expect(scope.profile).toBe('p')
    // The visibility tri-state: absent field -> undefined (advertise every tool).
    expect(toolAllowlist).toBeUndefined()
  })

  it('a tools allowlist narrows active to the intersection, toolAllowlist is the raw (un-intersected) set', async () => {
    const { scope, toolAllowlist } = await resolveSessionScope({
      broker: fakeBroker([]),
      toolManifestIds: toolIds,
      profile: 'p',
      profileRows: profileRows('p', { tools: ['[[mcp.tool.read_file_pinned]]', '[[mcp.tool.au_instances_of::au-mcp-core]]', '[[mcp.tool.not_mounted]]'] }),
    })
    expect(scope.tools.mounted).toEqual(['read_file_pinned', 'write_file', 'au_instances_of'])
    // active = mounted ∩ allowlist; a listed-but-not-mounted ref (not_mounted) simply drops.
    expect(scope.tools.active).toEqual(['read_file_pinned', 'au_instances_of'])
    // toolAllowlist is the tri-state allowlist itself (what the gate consults), so it keeps the
    // authored names verbatim, INCLUDING a not-yet-mounted one — the gate is a membership test.
    expect(toolAllowlist).toEqual(['read_file_pinned', 'au_instances_of', 'not_mounted'])
  })

  it('an empty tools allowlist yields no active tools and an empty toolAllowlist (none)', async () => {
    const { scope, toolAllowlist } = await resolveSessionScope({
      broker: fakeBroker([]),
      toolManifestIds: toolIds,
      profile: 'p',
      profileRows: profileRows('p', { tools: [] }),
    })
    expect(scope.tools.active).toEqual([])
    expect(scope.tools.mounted).toEqual(['read_file_pinned', 'write_file', 'au_instances_of'])
    // Empty list -> an empty allowlist ([]), distinct from undefined: advertise NO tool.
    expect(toolAllowlist).toEqual([])
  })

  it('degrades on a down engine: registry-only tools, active == mounted, empty skills/members', async () => {
    const { scope, toolAllowlist } = await resolveSessionScope({
      broker: fakeBroker(['ignored'], { available: false }),
      toolManifestIds: toolIds,
      profile: undefined,
      profileRows: [],
    })
    expect(scope.tools.mounted).toEqual(['read_file_pinned', 'write_file', 'au_instances_of'])
    expect(scope.tools.active).toEqual(['read_file_pinned', 'write_file', 'au_instances_of'])
    expect(scope.skills).toEqual({ active: [], mounted: [] })
    expect(scope.members).toEqual([])
    expect(scope.profile).toBeUndefined()
    // No profile -> unrestricted.
    expect(toolAllowlist).toBeUndefined()
  })
})
