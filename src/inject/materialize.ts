// The inject `materialize` driver — the launch-time delivery of always-on context.
//
// Structurally the twin of the skills driver, on the SAME shared tree core (path
// derivation, atomic wipe-rewrite, socket-keyed GC). What differs is only the capability
// segment (`gen/inject/...`) and that the item is an Inject, not a Skill. A harness
// supplies its own pure transform; everything IO is here and neutral.
//
// See [[spec - mcp.inject - typed instances whose bodies land in context at session start,
// hop-expanded and packed across generated hook slots::au-harness]].

import * as path from 'node:path'

import { createEngineBroker, type EngineBroker } from '../daemon/broker.ts'
import { collectDeadTrees, deriveSelKey, type GenTree, genPath as genTreePath, workspaceHash, writeTreeAtomically } from '../gen/tree.ts'
import { discoverInjects, type Inject, injectKey, type SkippedInject } from './discover.ts'
import { expandInjects, type InjectBlock, sizeInject } from './expand.ts'
import type { WireMemberRoleName } from '@arsumbris/au-engine-sdk'

/** The gen-tree capability segment for injects: `~/.arsumbris/au-mcp/gen/inject/...`. */
const CAPABILITY = 'inject'

/** One block the packer could not fit under the harness's slot cap. Named, never silent. */
export interface DroppedInject {
  /** The block's stable identity (`<owner>:<name>` or a hop-node key). */
  key: string
  /** Its resolvable `[[stem::repo]]` address, for the overflow report on both channels. */
  addr: string
}

/** What a harness's transform returns: the file tree PLUS what overflowed the budget. */
export interface InjectTree extends GenTree {
  /** Blocks dropped under the slot cap. Empty when uncapped (the default) or nothing overflowed. */
  dropped: DroppedInject[]
}

/**
 * A harness's pure BLOCKS -> files mapping. No filesystem, no paths, no GC.
 *
 * The transform receives the EXPANDED blocks (seed + hopped-to nodes), not the raw injects —
 * hop expansion is au-mcp's (it drives the engine), so the transform only renders each block's
 * envelope and packs. See `expandInjects`.
 */
export type InjectTransform = (blocks: InjectBlock[]) => InjectTree

// `injectKey` now lives in discover.ts (next to `Inject`), to break the materialize <-> expand
// import cycle. Re-exported (imported above) so existing importers are unaffected.
export { injectKey }

/**
 * Whether an inject is in the always-on DEFAULT SET — the trust boundary.
 *
 * `entry` and `edit` members are authoring surfaces the human owns, so their injects fire on
 * a bare launch. `dep` and `discover` members are CONSUMED (a dependency, a discovery mount),
 * so a bare launch never runs their standing context — they OFFER, and enter only by explicit
 * selection. A consumed member must not be able to put instructions in an agent's head with no
 * trigger and nobody opting in. Same partition as the engine's `editable` axis, role-derived.
 */
export function inDefaultSet(inject: Pick<Inject, 'role'>): boolean {
  return inject.role === 'entry' || inject.role === 'edit'
}

export interface MaterializeInjectsResult {
  /** Absolute plugin-root directories, for the launcher to pass to the harness. */
  pluginDirs: string[]
  /** The injects that were materialized. */
  injects: Inject[]
  /** Instances that claimed `mcp.inject` but could not be assembled; never silently dropped. */
  skipped: SkippedInject[]
  /** Workspace hashes whose gen trees were swept because their engine socket is dead. */
  collected: string[]
  /**
   * Blocks the transform's packer dropped over the slot budget — the OUT-OF-BAND overflow
   * channel. The launcher surfaces this to the HUMAN (a profile over budget is corrected where
   * it is set), while the agent gets the same set IN-BAND via a final generated slot. Empty
   * under the default (uncapped) launch.
   */
  dropped: DroppedInject[]
}

export interface MaterializeInjectsOptions {
  /** Override the engine broker (tests inject a fake; production derives it from `entry`). */
  broker?: EngineBroker
  /** Override the device-global `~/.arsumbris` root (tests isolate HOME). */
  home?: string
  /**
   * An allowlist of inject KEYS (`<owner>:<name>`) to materialize. Absent = materialize
   * all (the default). Applied AFTER discovery, so the full discovery still drives
   * `skipped` — an authoring error surfaces even when the broken inject was not selected.
   * This is what a host agent-profile passes to inject only its chosen subset.
   */
  select?: string[]
  /**
   * The active agent-profile's name, threaded ONLY for the readable gen-path prefix
   * (`<profileName>-<hash>` vs the bare `adhoc-<hash>`). Optional and cosmetic — the hash over
   * `select` carries the selection identity. Hashed INDEPENDENTLY of the skills selection.
   */
  profileName?: string
}

/**
 * The generated inject tree for one workspace, harness, and selection:
 * `~/.arsumbris/au-mcp/gen/inject/<workspace-hash>/<harnessKey>/<selKey>/`. Pins the shared core
 * to `inject`; the selection is hashed independently of the skills selection (never cross-keyed).
 */
export function genPath(entry: string, harnessKey: string, selKey: string, home?: string): string {
  return genTreePath(entry, CAPABILITY, harnessKey, selKey, home)
}

/** One inject's public facts, projected for a host picker. No body (it can be large). */
export interface InjectManifestEntry {
  /** `<owner>:<name>`, the selection ref the `--inject` filter matches (see `injectKey`). */
  key: string
  owner: string
  name: string
  /** What this context is, for the human deciding whether to pay for it. NOT a trigger. */
  description: string
  /** The owning member's role. Distinguishes the always-on DEFAULT SET (entry/edit) from opt-in (dep/discover). */
  role: WireMemberRoleName
  /**
   * The estimated PREPAID byte cost, WITHOUT fetching content — a hop inject is sized via the
   * unenriched walk. This is the picker's cost meter; unlike skills and tools, an inject's cost
   * is paid on every session before the first turn, so it must be visible while the human chooses.
   */
  bytes: number
  /** Absolute path of the instance file. */
  path: string
}

/** What discovery found for a workspace, for a host to render its inject picker + a debug surface. */
export interface InjectManifest {
  injects: InjectManifestEntry[]
  /** Instances that claimed `mcp.inject` but could not be assembled, with reasons — visible-by-absence. */
  skipped: SkippedInject[]
}

/**
 * The discovered-inject manifest for a workspace: every `mcp.inject` (key, owner, name,
 * description, role, estimated bytes) plus the skipped instances and why. A READ-ONLY sibling of
 * `materializeInjects` — it discovers, sizes, and projects, writing nothing.
 *
 * The host renders its agent-profile inject picker from this (it never walks the generated CC
 * tree). `role` drives the default-set vs opt-in split in the picker; `bytes` drives the cost
 * meter; `skipped` is the "I authored X, why is it absent" debug surface.
 */
export async function injectManifest(
  entry: string,
  options: Pick<MaterializeInjectsOptions, 'broker'> = {},
): Promise<InjectManifest> {
  const broker = options.broker ?? createEngineBroker(entry)
  const { injects, skipped } = await discoverInjects(broker)
  const entries = await Promise.all(
    injects.map(async (i): Promise<InjectManifestEntry> => ({
      key: injectKey(i),
      owner: i.owner,
      name: i.name,
      description: i.description,
      role: i.role,
      bytes: await sizeInject(i, broker),
      path: i.path,
    })),
  )
  return { injects: entries, skipped }
}

/**
 * Discover this workspace's injects, shape them with the harness's transform, write the
 * tree ATOMICALLY, sweep dead-socket siblings, and return the absolute plugin dirs.
 *
 * An empty inject set is a valid, quiet outcome: the tree is replaced with an empty one
 * and no plugin dirs come back, so the harness launches with no extra context.
 */
export async function materializeInjects(
  entry: string,
  harnessKey: string,
  transform: InjectTransform,
  options: MaterializeInjectsOptions = {},
): Promise<MaterializeInjectsResult> {
  const broker = options.broker ?? createEngineBroker(entry)
  const { injects: discovered, skipped } = await discoverInjects(broker)

  // The OPEN model (agent-profile): an explicit selection is EXACT — it names precisely which
  // injects fire, and naming a `dep`/`discover` inject is how a human opts that consumed one in.
  // No selection is the role-scoped DEFAULT SET: only the editable authoring surfaces
  // (`entry`/`edit`), so a bare launch never runs a dependency's standing context.
  const select = options.select
  const injects = select
    ? discovered.filter((i) => select.includes(injectKey(i)))
    : discovered.filter(inDefaultSet)

  // Expand each inject to its blocks (seed + hops) BEFORE the pure transform: the walk drives
  // the engine, which the transform must not. The transform then only renders + packs.
  const blocks = await expandInjects(injects, broker)
  const tree = transform(blocks)
  const selKey = deriveSelKey(select, options.profileName)
  const target = genPath(entry, harnessKey, selKey, options.home)
  writeTreeAtomically(target, tree)

  const collected = await collectDeadTrees(options.home, CAPABILITY, workspaceHash(entry))

  return {
    pluginDirs: tree.pluginRoots.map((root) => path.join(target, root)),
    injects,
    skipped,
    collected,
    dropped: tree.dropped,
  }
}
