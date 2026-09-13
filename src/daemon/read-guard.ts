// Read-view content helpers for the daemon's read-before-write bookkeeping.
//
// The read-before-write GUARD (the mediator) migrated to au-mcp-core as the loadable
// `mcp.read-guard` plugin (plan 2608261532, Phase 5.1). What stays here is the kernel-side
// machinery the daemon still owns: resolving a path's CURRENT engine content hash, and pulling a
// file path out of a tool input. These feed the read-view ENRICHMENT (`enrichReadEvent`) and the
// served-view registration — the freshness bookkeeping the kernel maintains as MECHANISM, so a
// mediator can read it via `MediationContext.readHash` / `hasRead` without daemon privilege.
//
// (The filename is kept to avoid churning the daemon import; Phase 6 kernel-thinning may rename it.)

import type { EngineBroker } from './broker.ts'

/** Pull a string `file_path` out of a tool input, or null. */
export function filePathOf(input: unknown): string | null {
  if (input && typeof input === 'object' && 'file_path' in input) {
    const p = (input as { file_path?: unknown }).file_path
    if (typeof p === 'string') return p
  }
  return null
}

/**
 * A path's current engine content hash via the `content` read, or null (no engine /
 * unreadable / error). The `content` read returns `{ content, hash }` from ONE coherent
 * disk read, and the hash is CATALOG-INDEPENDENT — present whenever the file is readable,
 * with no dependence on a build having indexed it ([[decision - 2606251052 - read_file
 * routes through the engine content read]]). This replaced `resolve_target`, whose hash
 * was catalog-dependent (null for an un-indexed file -> a false read-before-write denial).
 * The `content` read's arg is `path`, taken as-is by the engine's `abs_arg`, so the
 * ABSOLUTE path is passed directly (no relativize). `hash` is the mutation channel's
 * `expected_hash` source.
 */
export async function currentContentHash(broker: EngineBroker, absPath: string): Promise<string | null> {
  return (await currentContentMeta(broker, absPath))?.hash ?? null
}

/**
 * A path's `{ hash, commit }` via the `content` read, or null (no engine / unreadable /
 * error). Same single coherent read as `currentContentHash`, also surfacing the `commit`:
 * HEAD of the repo owning the path, `null` off a git working tree ([[message - 260626143108
 * - content read returns commit::au-engine]]). The bytes are the working tree's (possibly
 * dirty against HEAD); `commit` is HEAD — so a read pin is a best-effort HEAD anchor, not
 * byte-exact (a mutation pin is exact, it just committed). Used to stamp a read's
 * touched-file `target` server-side at observe.
 */
export async function currentContentMeta(
  broker: EngineBroker,
  absPath: string,
): Promise<{ hash: string; commit: string | null } | null> {
  if (!broker.available()) return null
  try {
    const frame = await broker.read('content', { path: absPath })
    if (frame.ready === false || frame.type === 'error') return null
    const result = frame.result as { hash?: unknown; commit?: unknown } | null
    if (!result || typeof result.hash !== 'string') return null
    return { hash: result.hash, commit: typeof result.commit === 'string' ? result.commit : null }
  } catch {
    return null
  }
}
