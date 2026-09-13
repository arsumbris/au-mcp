// Inject EXPANSION — turn each discovered inject into the set of BLOCKS that will be injected.
//
// A depth-0 inject is one block: its own body. A depth-N inject fans out over the reference
// graph via the engine's `neighborhood` read, and EVERY reached node becomes its own block —
// the seed at depth 0, its neighbours at depth 1, and so on. The flagship is a MOC that IS the
// inject: `depth: 1` reaches the rules it lists. See [[spec - mcp.inject - typed instances whose
// bodies land in context at session start, hop-expanded and packed across generated hook
// slots::au-harness]].
//
// This is neutral au-mcp work (it drives the engine); the adapter only RENDERS a block (the
// addressed envelope) and packs. Expansion runs in `materializeInjects`, which holds the broker;
// the transform stays a pure blocks -> files mapping.

import type { EngineBroker } from '../daemon/broker.ts'
import { type Inject, injectKey } from './discover.ts'

/**
 * One node's injectable content, PRE-render. The adapter wraps `body` in the
 * `<injected file [[stem::repo]]>` envelope; `stem` + `repo` are its resolvable address, `key`
 * its identity in the overflow report.
 */
export interface InjectBlock {
  /** Stable identity for the dropped report: the inject key for a seed, the node path for a hop. */
  key: string
  /** The address stem (a file basename without `.md`). */
  stem: string
  /** The address repo (the owning member). */
  repo: string
  /** The injectable text: the node's prose body, or its whole file when `show: body-and-frontmatter`. */
  body: string
}

/** The wikilink target stem of a repo path: its basename without the `.md` extension. */
export function fileStem(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath
  return base.replace(/\.md$/i, '')
}

/** One node of the `neighborhood` result this expander reads. */
interface WalkNode {
  path?: string
  repo?: string | null
  depth?: number
  file_kind?: string
  body?: string | null
  content?: string | null
}

/**
 * Expand the selected injects into the flat, ordered block list to pack.
 *
 * Depth 0 uses the body discovery already fetched (no extra read). Depth >= 1 walks the graph:
 * `neighborhood(path, direction: out, depth, kinds, <body|content per show>)`, then every node
 * with injectable text becomes a block, seed-first (BFS min-depth order). A node with no text
 * (an asset reached by a `file*` edge, or a null body) is NOT injectable and is skipped — null
 * is not zero content. A walk that errors (e.g. a depth >= 2 inject with no `edge-kinds`, which
 * the engine rejects) degrades to the seed block alone, so the inject's own content is never
 * lost to a hop failure.
 */
export async function expandInjects(injects: Inject[], broker: EngineBroker): Promise<InjectBlock[]> {
  const blocks: InjectBlock[] = []
  for (const inject of injects) {
    if (!inject.depth || inject.depth < 1) {
      blocks.push(seedBlock(inject))
      continue
    }
    const walked = await walkInject(inject, broker)
    if (walked === null || walked.length === 0) blocks.push(seedBlock(inject))
    else blocks.push(...walked)
  }
  return blocks
}

/** The seed's own block, from the body discovery already holds (depth-0 path + walk fallback). */
function seedBlock(inject: Inject): InjectBlock {
  return { key: injectKey(inject), stem: fileStem(inject.path), repo: inject.owner, body: inject.body }
}

/**
 * The prepaid byte cost of an inject WITHOUT fetching its content — for the host picker's cost
 * meter. Depth 0 is the body discovery already holds. Depth >= 1 runs the UNENRICHED walk (no
 * `body`/`content`), summing each node's size field, which the engine populates on an unenriched
 * walk precisely so a picker can cost a hop without paying the transfer (the "size before
 * content" seam). `show` picks the field: `body_bytes` (prose) or `bytes` (whole file). Any walk
 * failure degrades to the seed body length, mirroring expansion.
 */
export async function sizeInject(inject: Inject, broker: EngineBroker): Promise<number> {
  if (!inject.depth || inject.depth < 1) return inject.body.length

  const sizeField: 'bytes' | 'body_bytes' = inject.show === 'body-and-frontmatter' ? 'bytes' : 'body_bytes'
  const args: Record<string, unknown> = { path: inject.path, direction: 'out', depth: inject.depth }
  if (inject.edgeKinds.length > 0) args.kinds = inject.edgeKinds

  let frame: Awaited<ReturnType<EngineBroker['read']>>
  try {
    frame = await broker.read('neighborhood', args)
  } catch {
    return inject.body.length
  }
  if (frame.ready === false || frame.type === 'error') return inject.body.length

  const result = frame.result as { nodes?: Array<Record<string, unknown>> } | null
  const nodes = Array.isArray(result?.nodes) ? result.nodes : []
  let sum = 0
  for (const node of nodes) {
    const size = node[sizeField]
    if (typeof size === 'number') sum += size // a null size (asset) contributes nothing
  }
  return sum || inject.body.length
}

/**
 * Walk one inject and return its nodes as blocks, or null on a walk error (caller falls back to
 * the seed). `show` picks the enrichment: `body` (prose) or `content` (whole file). Both surface
 * the whole file's frontmatter for a hopped node when asked; the seed inject's own frontmatter is
 * dispatch, so a seed block always uses the stripped body regardless — but here the seed node
 * comes back through the same walk, so `show: body-and-frontmatter` does surface it (documented).
 */
async function walkInject(inject: Inject, broker: EngineBroker): Promise<InjectBlock[] | null> {
  const enrich: 'content' | 'body' = inject.show === 'body-and-frontmatter' ? 'content' : 'body'
  const args: Record<string, unknown> = { path: inject.path, direction: 'out', depth: inject.depth, [enrich]: true }
  if (inject.edgeKinds.length > 0) args.kinds = inject.edgeKinds

  let frame: Awaited<ReturnType<EngineBroker['read']>>
  try {
    frame = await broker.read('neighborhood', args)
  } catch {
    return null
  }
  if (frame.ready === false || frame.type === 'error') return null

  const result = frame.result as { nodes?: WalkNode[] } | null
  const nodes = Array.isArray(result?.nodes) ? result.nodes : []

  // Seed-first (BFS min-depth) order; ties by path for determinism.
  const sorted = [...nodes].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || (a.path ?? '').localeCompare(b.path ?? ''))

  const blocks: InjectBlock[] = []
  for (const node of sorted) {
    const text = node[enrich]
    // Not injectable: an asset / null-content node. Null is not zero content — skip it.
    if (typeof text !== 'string' || text.trim().length === 0) continue
    const path = node.path
    if (!path) continue
    blocks.push({
      key: path,
      stem: fileStem(path),
      // An own-repo node carries no `repo` qualifier; it lives in the seed's repo.
      repo: node.repo ?? inject.owner,
      body: text,
    })
  }
  return blocks
}
