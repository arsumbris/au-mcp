import { describe, it, expect } from 'vitest'
import { SessionBindings } from '../src/daemon/bindings.ts'

describe('SessionBindings (handle -> session resolution)', () => {
  it('resolves a bound handle to its session id', () => {
    const b = new SessionBindings()
    b.bind('h1', 's1')
    expect(b.resolve('h1')).toBe('s1')
  })

  it('returns undefined for an unbound key (a raw session id falls through in the daemon)', () => {
    const b = new SessionBindings()
    b.bind('h1', 's1')
    expect(b.resolve('s1')).toBeUndefined()
    expect(b.resolve('nope')).toBeUndefined()
  })

  it('rebinds the same handle to a new session (the /clear case)', () => {
    const b = new SessionBindings()
    b.bind('h1', 's1')
    b.bind('h1', 's2')
    expect(b.resolve('h1')).toBe('s2')
  })

  it('unbind drops the binding only when it still points at THIS session', () => {
    const b = new SessionBindings()
    b.bind('h1', 's1')
    b.unbind('h1', 's1')
    expect(b.resolve('h1')).toBeUndefined()
  })

  it('unbind is a no-op when a rebind already repointed the handle (stale close guard)', () => {
    const b = new SessionBindings()
    b.bind('h1', 's1')
    b.bind('h1', 's2') // /clear rebind
    b.unbind('h1', 's1') // the old session's late close must NOT clobber the rebind
    expect(b.resolve('h1')).toBe('s2')
  })

  it('keeps distinct handles independent (concurrent launches)', () => {
    const b = new SessionBindings()
    b.bind('hA', 'sA')
    b.bind('hB', 'sB')
    expect(b.resolve('hA')).toBe('sA')
    expect(b.resolve('hB')).toBe('sB')
  })
})
