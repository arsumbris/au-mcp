import { describe, it, expect } from 'vitest'
import {
  parseProfileHookConfig,
  parseProfileHookWhitelist,
  resolveProfileHookConfig,
  validateProfileHooks,
  type EngineReadFn,
  type ProfileRow,
} from '../src/daemon/profile-config.ts'

// The shape here mirrors the REAL engine output confirmed by hook-config-probe: each hookConfig
// entry is a flat record carrying its `type` claim (with the `::repo` qualifier) beside the fields.
const rows: ProfileRow[] = [
  {
    path: '/ws/sample-profile.md',
    fields: {
      name: 'sample',
      hookConfig: [
        { type: 'mcp.hook.instance-count-notice::au-mcp-core', forType: 'task', threshold: 20, message: 'triage' },
        { type: 'mcp.hook.instance-count-notice::au-mcp-core', forType: 'note', threshold: 5 },
        { type: 'mcp.hook.other::somerepo', foo: 1 },
      ],
    },
  },
  { path: '/ws/other.md', fields: { name: 'other', hookConfig: [{ type: 'mcp.hook.x::r' }] } },
]

describe('parseProfileHookConfig', () => {
  it('groups a profile hookConfig by hook manifest id (matched by name), N instances kept in order', () => {
    const map = parseProfileHookConfig(rows, 'sample')
    expect(map.get('mcp.instance-count-notice')).toEqual([
      { type: 'mcp.hook.instance-count-notice::au-mcp-core', forType: 'task', threshold: 20, message: 'triage' },
      { type: 'mcp.hook.instance-count-notice::au-mcp-core', forType: 'note', threshold: 5 },
    ])
    expect(map.get('mcp.other')).toEqual([{ type: 'mcp.hook.other::somerepo', foo: 1 }])
  })

  it('matches by path too', () => {
    const map = parseProfileHookConfig(rows, '/ws/other.md')
    expect(map.get('mcp.x')).toHaveLength(1)
  })

  it('empty for no profile / no match / no hookConfig / a malformed entry', () => {
    expect(parseProfileHookConfig(rows, undefined).size).toBe(0)
    expect(parseProfileHookConfig(rows, 'nope').size).toBe(0)
    expect(parseProfileHookConfig([{ fields: { name: 'x' } }], 'x').size).toBe(0)
    // an entry without a string `type` is skipped
    expect(parseProfileHookConfig([{ fields: { name: 'x', hookConfig: [{ foo: 1 }] } }], 'x').size).toBe(0)
  })

  it('skips a REF entry (a wikilink string, no `type`) — the daemon follow-reads those (Phase 6b)', () => {
    const map = parseProfileHookConfig([{ fields: { name: 'x', hookConfig: ['[[some-instance]]'] } }], 'x')
    expect(map.size).toBe(0)
  })
})

// `hooks` (type<mcp.hook>*[]) comes back as raw def-ref wikilink strings — the whitelist off-switch.
const whitelistRows: ProfileRow[] = [
  {
    path: '/ws/p.md',
    fields: { name: 'p', hooks: ['[[mcp.hook.instance-count-notice::au-mcp-core]]', '[[mcp.hook.other]]'] },
  },
  { path: '/ws/empty.md', fields: { name: 'empty', hooks: [] } },
  { path: '/ws/none.md', fields: { name: 'none' } },
]

describe('parseProfileHookWhitelist', () => {
  it('maps def-ref wikilinks to manifest ids, stripping [[ ]] and ::repo', () => {
    const set = parseProfileHookWhitelist(whitelistRows, 'p')
    expect(set).toEqual(new Set(['mcp.instance-count-notice', 'mcp.other']))
  })

  it('an empty `hooks` list -> an empty set (only critical hooks run)', () => {
    expect(parseProfileHookWhitelist(whitelistRows, 'empty')).toEqual(new Set())
  })

  it('an ABSENT `hooks` field -> undefined (no restriction, every hook runs)', () => {
    expect(parseProfileHookWhitelist(whitelistRows, 'none')).toBeUndefined()
    expect(parseProfileHookWhitelist(whitelistRows, undefined)).toBeUndefined()
    expect(parseProfileHookWhitelist(whitelistRows, 'nope')).toBeUndefined()
  })
})

describe('validateProfileHooks (advisory cross-field checks)', () => {
  const critical = new Set(['mcp.read-guard', 'mcp.tool-precondition'])

  it('no whitelist -> no warnings (unrestricted profile is always clean)', () => {
    expect(validateProfileHooks(undefined, ['mcp.instance-count-notice'], critical)).toEqual([])
  })

  it('warns that a critical hook in the whitelist is redundant', () => {
    const w = validateProfileHooks(new Set(['mcp.read-guard', 'mcp.instance-count-notice']), ['mcp.instance-count-notice'], critical)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/mcp\.read-guard.*critical.*redundant/)
  })

  it('warns that a hookConfig hook excluded by a present whitelist is ignored', () => {
    const w = validateProfileHooks(new Set(['mcp.other']), ['mcp.instance-count-notice'], critical)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/mcp\.instance-count-notice.*excludes.*ignored/)
  })

  it('a critical configured hook excluded by the whitelist is NOT warned (it runs anyway)', () => {
    expect(validateProfileHooks(new Set(['mcp.other']), ['mcp.read-guard'], critical)).toEqual([])
  })

  it('a configured hook IN the whitelist is clean', () => {
    expect(validateProfileHooks(new Set(['mcp.instance-count-notice']), ['mcp.instance-count-notice'], critical)).toEqual([])
  })
})

describe('resolveProfileHookConfig (inline + REF follow-read via the engine resolve verb)', () => {
  // A fake engine read: resolve_target maps a target name to a path; instance returns the view for it.
  const fakeRead: EngineReadFn = async (op, args) => {
    if (op === 'resolve_target') {
      return args?.target === 'shared-notice'
        ? { result: { path: '/ws/shared-notice.md', kind: 'instance' } }
        : { result: null }
    }
    if (op === 'instance' && args?.path === '/ws/shared-notice.md') {
      return {
        result: {
          claim: ['mcp.hook.instance-count-notice::au-mcp-core'],
          effective_values: [
            // a `type*` def-ref field carries a REFERENCE value ({kind, target}), reconstructed to a wikilink.
            { field: 'forType', containers: [{ value: { kind: 'reference', target: 'note', anchor: null, block_id: null } }] },
            { field: 'threshold', containers: [{ value: { kind: 'scalar', value: 9 } }] },
          ],
        },
      }
    }
    return { result: null }
  }

  const refRows: ProfileRow[] = [
    {
      path: '/ws/p.md',
      fields: {
        name: 'p',
        hookConfig: [
          { type: 'mcp.hook.instance-count-notice::au-mcp-core', forType: 'task', threshold: 20 },
          '[[shared-notice]]',
        ],
      },
    },
  ]

  it('follows a REF entry into an inline-shaped record (def-ref reconstructed to a wikilink) and groups it in order', async () => {
    const map = await resolveProfileHookConfig(refRows, 'p', fakeRead)
    expect(map.get('mcp.instance-count-notice')).toEqual([
      { type: 'mcp.hook.instance-count-notice::au-mcp-core', forType: 'task', threshold: 20 },
      // the followed ref's `type*` forType came back as a reference value, rebuilt to `[[note]]`.
      { type: 'mcp.hook.instance-count-notice::au-mcp-core', forType: '[[note]]', threshold: 9 },
    ])
  })

  it('skips a REF that does not resolve (best-effort, never wedges)', async () => {
    const rows: ProfileRow[] = [{ path: '/ws/p.md', fields: { name: 'p', hookConfig: ['[[missing]]'] } }]
    const map = await resolveProfileHookConfig(rows, 'p', fakeRead)
    expect(map.size).toBe(0)
  })

  it('matches parseProfileHookConfig for an inline-only profile (no reads issued)', async () => {
    let reads = 0
    const counting: EngineReadFn = async (...a) => {
      reads++
      return fakeRead(...a)
    }
    const map = await resolveProfileHookConfig(rows, 'sample', counting)
    expect(map.get('mcp.instance-count-notice')).toHaveLength(2)
    expect(reads).toBe(0)
  })
})
