import { describe, it, expect } from 'vitest'
import { currentContentHash } from '../src/daemon/read-guard.ts'
import type { EngineBroker } from '../src/daemon/broker.ts'

// The read-before-write GUARD (the mediator) migrated to au-mcp-core as the loadable
// `mcp.read-guard` plugin (plan 2608261532, Phase 5.1); its behavior tests live there now
// (au-mcp-core/tests/read-guard.test.ts). What stays here is the kernel-side content-hash
// helper the daemon still uses for read-view enrichment + served-file registration.

describe('currentContentHash (engine content read)', () => {
  it('queries the `content` read with arg `path` as the ABSOLUTE path (not `target`, not relativized)', async () => {
    // [[decision - 2606251052 ...]]: the hash comes from the `content` read ({ content, hash },
    // catalog-independent), not `resolve_target`. The engine's `abs_arg` takes the absolute path as-is.
    const calls: { op: string; args?: Record<string, unknown> }[] = []
    const broker: EngineBroker = {
      socketPath: '',
      available: () => true,
      mutate: async () => ({}),
      read: async (op, args) => {
        calls.push({ op, args })
        return { type: 'response', ready: true, result: { content: 'hello', hash: 'abc123' } }
      },
    }
    const h = await currentContentHash(broker, '/ws/notes/a.md')
    expect(h).toBe('abc123')
    expect(calls).toEqual([{ op: 'content', args: { path: '/ws/notes/a.md' } }])
  })

  it('returns null when no engine, or the file is unreadable (content result null)', async () => {
    const noEngine: EngineBroker = { socketPath: '', available: () => false, read: async () => ({}), mutate: async () => ({}) }
    expect(await currentContentHash(noEngine, '/ws/a.md')).toBeNull()
    const unreadable: EngineBroker = {
      socketPath: '', available: () => true, mutate: async () => ({}),
      read: async () => ({ type: 'response', ready: true, result: null }),
    }
    expect(await currentContentHash(unreadable, '/ws/a.md')).toBeNull()
  })
})
