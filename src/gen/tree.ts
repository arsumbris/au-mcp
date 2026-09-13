// The generated-tree mechanism — capability-agnostic FS + GC, shared by every
// launch-materialized capability (skills, injects, ...).
//
// A capability materializes a per-launch tree of synthetic harness plugins under
// `~/.arsumbris/au-mcp/gen/<capability>/<workspace-hash>/<harness>/<selection-key>/`, then hands
// the launcher the plugin dirs. What DIFFERS per capability is discovery and the item -> files
// transform;
// what is IDENTICAL is the path derivation, the atomic wipe-rewrite, and the socket-keyed
// GC. That identical part lives here so there is ONE driver, not one per capability.
//
// `<workspace-hash>` is the SAME hash that keys the engine socket, which is load-bearing:
// the socket is then the exact liveness signal for the GC, with no registry or sidecar.
// See [[spec - mcp.inject - typed instances whose bodies land in context at session start,
// hop-expanded and packed across generated hook slots::au-harness]] and the sibling
// mcp.skill spec.

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

import { auDeviceDirCustom, socketFileName, socketPathForHash } from '@arsumbris/au-engine-sdk'

/** One file a transform wants written, relative to the harness subtree root. */
export interface GenFile {
  relPath: string
  content: string
}

/** What a harness wants on disk for a materialized set. The adapter's ONLY contribution. */
export interface GenTree {
  files: GenFile[]
  /**
   * Subtree-relative directories that are plugin ROOTS, each becoming one absolute path in
   * the result. For Claude Code these are the synthetic plugins the launcher passes as
   * `--plugin-dir`.
   */
  pluginRoots: string[]
}

/**
 * Our gen-tree device dir, `$HOME/.arsumbris/au-mcp/gen/`. `gen` is a free-form category
 * (not one of engine-sdk's blessed `AU_CATEGORIES`), so it rides `auDeviceDirCustom` —
 * the SDK owns the `.arsumbris/<owner>/<category>` shape + the raw-`$HOME` derivation, we
 * only name the tenant. `home` is threaded for test isolation (undefined -> `$HOME`).
 */
const genRoot = (home?: string): string => auDeviceDirCustom('au-mcp', 'gen', home)

/** The socket-keyed workspace hash: `socketFileName` without its `.sock` extension. */
export function workspaceHash(entry: string): string {
  return socketFileName(fs.realpathSync(entry)).replace(/\.sock$/, '')
}

/** A profile name coerced to one safe path segment: only `[A-Za-z0-9._-]`, the rest to `-`. */
const sanitizeSegment = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-')

/**
 * The selection-key segment for a materialized tree. The gen tree CONTENT is a function of
 * the selected item set, so the PATH must fold that selection in; otherwise two launches with
 * different selections on one workspace + harness clobber each other at a shared path. See
 * [[decision - 2609131516 - the gen tree is keyed by a per-capability selection, not just
 * workspace and harness]].
 *
 * - An ABSENT selection (`undefined`) -> the sentinel `all`: the no-explicit-selection bucket
 *   (materialize-all for skills, the role-scoped default-set for injects — "all" names the
 *   bucket, not literally every item).
 * - A PRESENT selection (even an empty array, a deliberately empty profile) -> `<prefix>-<hash>`.
 *   The hash is over the SORTED refs, so ordering never forks the key; identical selections
 *   share a bucket, different ones coexist. `prefix` is the profile name when one is threaded,
 *   else `adhoc`; it is cosmetic (self-explaining gen dir), the hash carries identity.
 *
 * Per-capability: skills and injects each derive their own key from their own `select`, never
 * cross-keyed.
 */
export function deriveSelKey(select?: string[], profileName?: string): string {
  if (select === undefined) return 'all'
  const hash = crypto.createHash('sha256').update([...select].sort().join('\n')).digest('hex').slice(0, 10)
  const prefix = profileName ? sanitizeSegment(profileName) : 'adhoc'
  return `${prefix}-${hash}`
}

/**
 * The generated tree for one capability, workspace, harness, and selection:
 * `~/.arsumbris/au-mcp/gen/<capability>/<workspace-hash>/<harnessKey>/<selKey>/`.
 *
 * `capability` is the sole segment that separates one capability's trees from another's
 * (`skill`, `inject`, ...), so their GC sweeps stay independent. `selKey` (see `deriveSelKey`)
 * separates different selections so concurrent different-profile launches never collide;
 * it sits BELOW `harnessKey` because GC deletes the whole `<workspace-hash>` subtree wholesale,
 * so the deeper segment is swept for free.
 */
export function genPath(
  entry: string,
  capability: string,
  harnessKey: string,
  selKey: string,
  home?: string,
): string {
  return path.join(genRoot(home), capability, workspaceHash(entry), harnessKey, selKey)
}

/**
 * Build the tree in a sibling temp dir, then swap it into place by rename, so a concurrent
 * launch on the same workspace never scans a half-written tree. The temp dir is a SIBLING
 * so the rename stays within one filesystem, where it is atomic.
 *
 * The swap is replace-not-merge: a removed item must vanish from the tree, so the previous
 * generation is moved aside and deleted rather than written over.
 */
export function writeTreeAtomically(target: string, tree: GenTree): void {
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.staging-`))
  const retired = `${staging}-retired`

  try {
    for (const file of tree.files) {
      const dest = path.join(staging, file.relPath)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, file.content)
    }
    // Move any current generation aside first: rename onto a non-empty dir fails.
    const hadPrevious = fs.existsSync(target)
    if (hadPrevious) fs.renameSync(target, retired)
    try {
      fs.renameSync(staging, target)
    } catch (err) {
      if (hadPrevious) fs.renameSync(retired, target) // put the old generation back
      throw err
    }
    fs.rmSync(retired, { recursive: true, force: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Sweep sibling gen trees of ONE capability whose workspace is not in use, returning the
 * hashes deleted.
 *
 * A gen tree is EPHEMERAL — re-derived on every launch — so it is safe to delete whenever
 * its workspace is idle, and the engine socket is the exact "in use" signal:
 * `au-mcp/gen/<capability>/<hash>/` is needed iff the engine's `au-engine/run/<hash>.sock`
 * is LIVE. One hash keys both, so no registry, sidecar, or LRU exists to drift. Liveness is
 * CONNECTABILITY, not file existence — a crashed daemon leaves a stale `.sock` behind.
 */
export async function collectDeadTrees(home: string | undefined, capability: string, keep: string): Promise<string[]> {
  const capRoot = path.join(genRoot(home), capability)
  let hashes: string[]
  try {
    hashes = fs.readdirSync(capRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return [] // no gen root yet: nothing to sweep
  }

  const collected: string[] = []
  for (const hash of hashes) {
    if (hash === keep) continue // never sweep the workspace we are materializing for
    if (await isSocketLive(home, hash)) continue
    try {
      fs.rmSync(path.join(capRoot, hash), { recursive: true, force: true })
      collected.push(hash)
    } catch {
      // A tree we cannot delete is harmless (just disk); the next launch retries.
    }
  }
  return collected
}

/**
 * Whether a workspace hash's engine socket is connectable.
 *
 * Existence alone is NOT liveness: a crashed daemon leaves a stale `.sock` that would
 * otherwise pin a dead workspace's tree forever.
 */
function isSocketLive(home: string | undefined, hash: string): Promise<boolean> {
  // The engine socket dir is engine-sdk's to own, so we ask it for the path rather than
  // re-deriving `au-engine/run/` here. `socketPathForHash` is the hash-keyed door onto the
  // same path `socketPath(entry)` builds (we hold the workspace hash, not the entry); the
  // `home` override lets our test isolation pass a temp home. This replaced a hand-built
  // path that silently drifted when the engine moved `sockets/` -> `au-engine/run/`.
  const socket = socketPathForHash(hash, home)
  if (!fs.existsSync(socket)) return Promise.resolve(false)
  return connectable(socket)
}

/**
 * The errnos that PROVE nothing is serving at a socket path.
 * - `ECONNREFUSED` — the socket inode outlived its process (a SIGKILLed daemon never unlinks).
 * - `ENOTSOCK` — a regular file or directory sits at the path; never a daemon.
 * - `ENOENT` — it vanished between the existence check and the connect.
 */
const DEAD_ERRNOS = new Set(['ECONNREFUSED', 'ENOTSOCK', 'ENOENT'])

/**
 * Connect-probe a UNIX socket. Only a PROVEN-dead outcome sweeps: the bias on anything
 * ambiguous (a timeout, an unexpected errno) is LIVE, because a wrongly-kept tree costs
 * only disk while a wrongly-swept one breaks a running session.
 */
function connectable(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(socket)
    const settle = (live: boolean): void => {
      clearTimeout(timer)
      conn.destroy()
      resolve(live)
    }
    const timer = setTimeout(() => settle(true), 1500)
    conn.on('connect', () => settle(true))
    conn.on('error', (err: NodeJS.ErrnoException) => settle(!DEAD_ERRNOS.has(err.code ?? '')))
  })
}
