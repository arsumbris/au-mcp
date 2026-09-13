import { describe, it, expect } from 'vitest'

import { packBlocks, type PackBlock } from '../src/inject/pack.ts'

const block = (key: string, text: string): PackBlock => ({ key, addr: `[[${key}]]`, text })

describe('packBlocks', () => {
  it('packs several small blocks into ONE slot when they fit', () => {
    const { slots, dropped } = packBlocks([block('a', 'aaa'), block('b', 'bbb'), block('c', 'ccc')], { budget: 100 })
    expect(slots).toHaveLength(1)
    expect(slots[0]).toBe('aaa\nbbb\nccc')
    expect(dropped).toEqual([])
  })

  it('opens a new slot when the next block would overflow the current one', () => {
    // budget 10: 'aaaaa'(5) + sep(1) + 'bbbbb'(5) = 11 > 10, so b starts a new slot.
    const { slots } = packBlocks([block('a', 'aaaaa'), block('b', 'bbbbb')], { budget: 10 })
    expect(slots).toEqual(['aaaaa', 'bbbbb'])
  })

  it('splits a single oversized block at line boundaries across slots', () => {
    const big = block('big', 'line1\nline2\nline3\nline4\n')
    // budget 12 holds two 6-char lines ('line1\n'+'line2\n' = 12) per slot.
    const { slots, dropped } = packBlocks([big], { budget: 12 })
    expect(dropped).toEqual([])
    expect(slots.length).toBeGreaterThan(1)
    // Rejoining the slots reproduces the block's text exactly (lossless split).
    expect(slots.join('')).toBe('line1\nline2\nline3\nline4\n')
    // No slot exceeds the budget.
    expect(slots.every((s) => s.length <= 12)).toBe(true)
  })

  it('hard-splits a single line wider than the budget as a last resort', () => {
    const { slots } = packBlocks([block('wide', 'x'.repeat(25))], { budget: 10 })
    expect(slots.every((s) => s.length <= 10)).toBe(true)
    expect(slots.join('')).toBe('x'.repeat(25))
  })

  it('is UNBOUNDED by default: nothing drops however many slots it takes', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => block(`b${i}`, 'z'.repeat(9)))
    const { slots, dropped } = packBlocks(blocks, { budget: 10 })
    expect(dropped).toEqual([]) // no cap => no drops
    expect(slots).toHaveLength(50) // each 9-char block needs its own slot (9+1+9 > 10)
  })

  it('drops whole blocks past a maxSlots cap, in order, and names them', () => {
    const blocks = [block('a', 'aaaaa'), block('b', 'bbbbb'), block('c', 'ccccc'), block('d', 'ddddd')]
    // budget 5 => each block fills a slot; cap at 2 slots keeps a,b and drops c,d.
    const { slots, dropped } = packBlocks(blocks, { budget: 5, maxSlots: 2 })
    expect(slots).toEqual(['aaaaa', 'bbbbb'])
    expect(dropped.map((d) => d.key)).toEqual(['c', 'd'])
  })

  it('drops a block ATOMICALLY when its split would exceed the cap (never half-emitted)', () => {
    // 'a' fills slot 1; the big block would need 2 more slots (3 total) but cap is 2.
    const big = block('big', 'L1\nL2\nL3\nL4\n') // 12 chars, budget 6 => 2 slots
    const { slots, dropped } = packBlocks([block('a', 'aaaaaa'), big], { budget: 6, maxSlots: 2 })
    expect(slots).toEqual(['aaaaaa']) // only the first block; the big one did not partially land
    expect(dropped.map((d) => d.key)).toEqual(['big'])
  })

  it('surfaces the address on each dropped block (for the agent-facing overflow report)', () => {
    const { dropped } = packBlocks([block('x', 'xx'), block('y', 'yy')], { budget: 2, maxSlots: 1 })
    expect(dropped[0]).toMatchObject({ key: 'y', addr: '[[y]]' })
  })

  it('no blocks => no slots, no drops', () => {
    expect(packBlocks([], { budget: 100 })).toEqual({ slots: [], dropped: [] })
  })
})
