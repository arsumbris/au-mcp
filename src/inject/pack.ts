// The inject PACKER — neutral, harness-agnostic (au-mcp owns packing; the adapter supplies
// the budget and the rendered blocks). It greedily fills already-rendered blocks into slots
// no larger than a per-slot character budget, splits a single oversized block at line
// boundaries, and — only when a `maxSlots` cap is set — reports what did not fit.
//
// A "block" is one fully-rendered unit of injected context (the `<injected file [[stem::repo]]>`
// envelope + its body). Blocks are ATOMIC for dropping: a block is either fully packed (across
// as many slots as its size needs) or fully dropped, never half-injected.
//
// The budget exists because a harness caps each session-start hook's output, so the content is
// spread across N hooks. The per-slot budget and the cap are the harness's to choose; the greedy
// fill, the split, and the loud overflow are neutral and live here. See [[spec - mcp.inject -
// typed instances whose bodies land in context at session start, hop-expanded and packed across
// generated hook slots::au-harness]].

/** One rendered block to pack. `key` / `addr` identify it in the overflow report. */
export interface PackBlock {
  /** Stable identity for the dropped report, e.g. `<owner>:<name>` or a node key. */
  key: string
  /** The resolvable `[[stem::repo]]` address, for the agent-facing overflow naming. */
  addr: string
  /** The fully rendered block text (envelope + body). What actually gets injected. */
  text: string
}

export interface PackResult {
  /** Each slot's concatenated text, no larger than the budget. One slot => one hook. */
  slots: string[]
  /** Blocks that did not fit under `maxSlots`. Empty when no cap, or nothing overflowed. */
  dropped: PackBlock[]
}

export interface PackOptions {
  /** The per-slot character budget (a harness's per-hook cap, minus headroom). */
  budget: number
  /**
   * The maximum number of slots to emit. Absent = UNBOUNDED (generate as many as the content
   * needs, nothing dropped). When set, blocks past the cap are dropped and named — the prepaid
   * cost lever a profile tunes.
   */
  maxSlots?: number
}

/** The separator between two blocks sharing a slot — a blank line keeps envelopes legible. */
const SEP = '\n'

/**
 * Pack rendered blocks into budget-sized slots.
 *
 * Greedy: append a block to the current slot when it fits, else open a new slot. A block larger
 * than the budget on its own is split at line boundaries into consecutive slots (its envelope's
 * open tag rides the first piece, the close tag the last). A `maxSlots` cap drops whole blocks
 * from the frontier onward — atomically, so a split block is never half-emitted.
 */
export function packBlocks(blocks: PackBlock[], opts: PackOptions): PackResult {
  const { budget, maxSlots } = opts
  const slots: string[] = []
  const dropped: PackBlock[] = []
  let capped = false

  for (const block of blocks) {
    if (capped) {
      dropped.push(block)
      continue
    }
    // The slots THIS block needs, computed against a fresh copy of the current state so a
    // cap rejection leaves the accumulated slots untouched (atomic drop).
    const trial = planBlock(slots, block.text, budget)
    if (maxSlots !== undefined && trial.length > maxSlots) {
      // This block cannot fit within the cap; it and every following block drop.
      capped = true
      dropped.push(block)
      continue
    }
    slots.length = 0
    slots.push(...trial)
  }

  return { slots, dropped }
}

/**
 * Return the full slot array after placing `text` on top of `current`, without mutating it.
 *
 * A block that fits in the last slot's remaining room is appended there; otherwise it starts a
 * new slot. A block wider than the budget is split at line boundaries (a single over-wide line
 * is hard-split as a last resort, mirroring the eidos required-reading splitter).
 */
function planBlock(current: string[], text: string, budget: number): string[] {
  const slots = [...current]

  if (text.length <= budget) {
    const last = slots.length - 1
    if (last >= 0 && slots[last].length + SEP.length + text.length <= budget) {
      slots[last] = `${slots[last]}${SEP}${text}`
    } else {
      slots.push(text)
    }
    return slots
  }

  // Oversized: split into <=budget pieces at line boundaries, each its own slot.
  let piece = ''
  const flush = (): void => {
    if (piece) {
      slots.push(piece)
      piece = ''
    }
  }
  for (const line of splitKeepingNewlines(text)) {
    for (const unit of line.length <= budget ? [line] : hardSplit(line, budget)) {
      if (piece && piece.length + unit.length > budget) flush()
      piece += unit
    }
  }
  flush()
  return slots
}

/** Split into lines, KEEPING the trailing newline on each, so rejoining is lossless. */
function splitKeepingNewlines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Last-resort hard split of a single line wider than the budget. */
function hardSplit(line: string, budget: number): string[] {
  const out: string[] = []
  for (let i = 0; i < line.length; i += budget) out.push(line.slice(i, i + budget))
  return out
}
