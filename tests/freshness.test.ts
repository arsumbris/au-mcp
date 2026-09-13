import { describe, it, expect } from 'vitest'
import { createFreshness } from '../src/daemon/freshness.ts'
import type { ChangesHandlers } from '../src/daemon/broker.ts'
import type { Session } from '../src/daemon/session.ts'

// A minimal Session — freshness only reads `id`, `readView`, `servedView`.
const mkSession = (
  id: string,
  readView: Record<string, string> = {},
  servedView: Record<string, string> = {},
): Session =>
  ({
    id,
    readView: new Map(Object.entries(readView)),
    servedView: new Map(Object.entries(servedView)),
  }) as unknown as Session

// A rig capturing the subscription handlers + the notices, driving the change feed by hand.
function rig(initial: Session[]) {
  let live = initial
  let handlers: ChangesHandlers | undefined
  const hashes = new Map<string, string | null>() // path -> current engine hash (absent = gone)
  const reads: string[] = [] // every path a hash was read for
  const notified: Array<{ session: string; paths: string[] }> = []
  const mgr = createFreshness({
    subscribeChanges: (h) => {
      handlers = h
      return () => {}
    },
    sessions: () => live,
    currentHash: async (p) => {
      reads.push(p)
      return hashes.get(p) ?? null
    },
    notify: (session, paths) => notified.push({ session, paths }),
  })
  const flush = () => new Promise((r) => setTimeout(r, 0)) // let the async revalidate settle
  return {
    mgr,
    hashes,
    reads,
    notified,
    setLive: (s: Session[]) => (live = s),
    change: async (delta: Partial<{ added: string[]; removed: string[]; modified: string[] }>) => {
      handlers!.onChange({ added: [], removed: [], modified: [], ...delta })
      await flush()
    },
    reconnect: async () => {
      handlers!.onReconnect()
      await flush()
    },
    started: () => handlers !== undefined,
  }
}

describe('freshness — hash-equality invalidation', () => {
  it('invalidates a stale reader and skips the writer (echo-suppression is free)', async () => {
    const a = mkSession('A', { '/n': 'H0' }) // A read at H0
    const b = mkSession('B', { '/n': 'H1' }) // B wrote it -> holds the post-write hash
    const r = rig([a, b])
    r.hashes.set('/n', 'H1') // current = B's write
    await r.change({ modified: ['/n'] })
    expect(a.readView.has('/n')).toBe(false) // stale reader invalidated
    expect(b.readView.get('/n')).toBe('H1') // writer skipped, entry intact
    expect(r.notified).toEqual([{ session: 'A', paths: ['/n'] }])
  })

  it('invalidates every holder on an out-of-band human edit', async () => {
    const a = mkSession('A', { '/n': 'H0' })
    const r = rig([a])
    r.hashes.set('/n', 'H2') // changed by no session
    await r.change({ modified: ['/n'] })
    expect(a.readView.has('/n')).toBe(false)
    expect(r.notified).toEqual([{ session: 'A', paths: ['/n'] }])
  })

  it('is coalescing-proof: a writer whose hash trails the final hash is invalidated', async () => {
    const b = mkSession('B', { '/n': 'H1' }) // B wrote H1
    const r = rig([b])
    r.hashes.set('/n', 'H2') // then a human edited to H2 (coalesced into one event)
    await r.change({ modified: ['/n'] })
    expect(b.readView.has('/n')).toBe(false) // not wrongly suppressed
    expect(r.notified).toEqual([{ session: 'B', paths: ['/n'] }])
  })

  it('re-opens a served precondition whose file changed', async () => {
    const a = mkSession('A', {}, { '/guide.md': 'G0' })
    const r = rig([a])
    r.hashes.set('/guide.md', 'G1')
    await r.change({ modified: ['/guide.md'] })
    expect(a.servedView.has('/guide.md')).toBe(false)
    expect(r.notified).toEqual([{ session: 'A', paths: ['/guide.md'] }])
  })

  it('invalidates a held path that was removed (current hash is null)', async () => {
    const a = mkSession('A', { '/n': 'H0' })
    const r = rig([a])
    // no hash set -> currentHash returns null (gone) -> never equals a stored string
    await r.change({ removed: ['/n'] })
    expect(a.readView.has('/n')).toBe(false)
    expect(r.notified).toEqual([{ session: 'A', paths: ['/n'] }])
  })

  it('reads no hash and notifies nobody for a changed path no session holds', async () => {
    const a = mkSession('A', { '/n': 'H0' })
    const r = rig([a])
    await r.change({ modified: ['/other'] })
    expect(r.reads).not.toContain('/other') // no holder -> no read
    expect(r.notified).toEqual([])
    expect(a.readView.get('/n')).toBe('H0') // untouched
  })

  it('does not notify a session whose stored hash still matches', async () => {
    const a = mkSession('A', { '/n': 'H0' })
    const r = rig([a])
    r.hashes.set('/n', 'H0') // unchanged
    await r.change({ modified: ['/n'] })
    expect(a.readView.get('/n')).toBe('H0')
    expect(r.notified).toEqual([])
  })
})

describe('freshness — reconnect', () => {
  it('re-validates the whole view on reconnect, invalidating only moved entries', async () => {
    const a = mkSession('A', { '/x': 'H0', '/y': 'H0' })
    const r = rig([a])
    r.hashes.set('/x', 'H0') // unchanged during the gap
    r.hashes.set('/y', 'H9') // changed during the gap
    await r.reconnect()
    expect(a.readView.get('/x')).toBe('H0')
    expect(a.readView.has('/y')).toBe(false)
    expect(r.notified).toEqual([{ session: 'A', paths: ['/y'] }])
  })
})

describe('freshness — no engine', () => {
  it('stays inert when the broker cannot subscribe', () => {
    const notified: unknown[] = []
    const mgr = createFreshness({
      subscribeChanges: undefined,
      sessions: () => [],
      currentHash: async () => null,
      notify: () => notified.push(1),
    })
    expect(() => mgr.stop()).not.toThrow() // stop is a no-op
    expect(notified).toEqual([])
  })
})
