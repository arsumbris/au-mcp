// The `materialize` driver — au-mcp owns ALL orchestration and IO for skill delivery.
//
// Skills are launch-time-STATIC, the mirror of runtime-dynamic tools: a harness scans
// its skill folders once at startup, so skills are written to DISK before launch rather
// than riding the live MCP wire. See [[c - skills are launch-time-static the mirror of
// runtime-dynamic tools]].
//
// The split (spec > Ownership; the same neutral-core / harness-edge line as the tools
// path): the ONLY harness-specific question is "what files does this harness want", which
// is a pure `SkillTransform` the adapter supplies. Everything else — discovery, path
// derivation, the atomic write, the GC, the returned plugin dirs — is neutral and lives
// here. A second harness is then a second pure transform plus a thin entrypoint, with no
// new IO / path / GC code.
//
// The driver EXECUTES in the adapter's process (the adapter imports and calls it); that
// is an execution-context detail, not ownership. au-mcp never calls an adapter — the
// kernel cannot know its adapters.

import * as path from 'node:path'

import { createEngineBroker, type EngineBroker } from '../daemon/broker.ts'
import {
  collectDeadTrees,
  deriveSelKey,
  type GenFile,
  type GenTree,
  genPath as genTreePath,
  workspaceHash,
  writeTreeAtomically,
} from '../gen/tree.ts'
import { discoverSkills, type Skill, type SkippedSkill } from './discover.ts'

/** The gen-tree capability segment for skills: `~/.arsumbris/au-mcp/gen/skill/...`. */
const CAPABILITY = 'skill'

/** One file a transform wants written, relative to the harness subtree root. */
export type SkillFile = GenFile

/** What a harness wants on disk for a skill set. The adapter's ONLY contribution. */
export type SkillTree = GenTree

/** A harness's pure skills -> files mapping. No filesystem, no paths, no GC. */
export type SkillTransform = (skills: Skill[]) => SkillTree

export interface MaterializeResult {
  /** Absolute plugin-root directories, for the launcher to pass to the harness. */
  pluginDirs: string[]
  /** The skills that were materialized. */
  skills: Skill[]
  /** Instances that claimed `mcp.skill` but could not be assembled; never silently dropped. */
  skipped: SkippedSkill[]
  /** Workspace hashes whose gen trees were swept because their engine socket is dead. */
  collected: string[]
}

export interface MaterializeOptions {
  /** Override the engine broker (tests inject a fake; production derives it from `entry`). */
  broker?: EngineBroker
  /** Override the device-global `~/.arsumbris` root (tests isolate HOME). */
  home?: string
  /**
   * An allowlist of skill KEYS (`<owner>:<name>`, see `skillKey`) to materialize.
   * Absent = materialize all (the default). Applied AFTER discovery, BEFORE the
   * transform, so per-owner output and the harness namespacing are untouched: a
   * filtered owner emits fewer skills, an owner with none selected drops out entirely.
   * This is what a host agent-profile passes to launch only its chosen subset.
   */
  select?: string[]
  /**
   * The active agent-profile's name, threaded ONLY for the readable gen-path prefix
   * (`<profileName>-<hash>` vs the bare `adhoc-<hash>`). Optional and cosmetic — absent just
   * yields the `adhoc-` prefix; the hash over `select` carries the actual selection identity.
   */
  profileName?: string
}

/**
 * A skill's stable selection identity, `<owner>:<name>` — the same string the harness
 * invokes it by (`/<owner>:<name>` in CC). It is the key in `skillManifest` and the ref
 * `MaterializeOptions.select` matches, so a picker's selection round-trips verbatim.
 */
export function skillKey(skill: Pick<Skill, 'owner' | 'name'>): string {
  return `${skill.owner}:${skill.name}`
}

/** One skill's public facts, projected for a host picker (no body — it can be large). */
export interface SkillManifestEntry {
  /** `<owner>:<name>`, the selection ref (see `skillKey`). */
  key: string
  owner: string
  name: string
  description: string
  /**
   * The pre-approved tools, as AGENT-FACING base names (`shout`, `au_host_intent_fire`) — the
   * neutral cross-harness identity that matches the tool manifest, NOT the harness-mangled
   * name. Empty when the skill pre-approves none.
   */
  allowedTools: string[]
  /** Absolute path of the instance file. */
  path: string
}

/** What discovery found for a workspace, for a host to render a picker + a debug surface. */
export interface SkillManifest {
  skills: SkillManifestEntry[]
  /** Instances that claimed `mcp.skill` but could not be assembled, with reasons. */
  skipped: SkippedSkill[]
}

/** Strip the `mcp.tool.` prefix off a def-ref name to the agent-facing base tool name. */
const baseToolName = (defRef: string): string => defRef.replace(/^mcp\.tool\./, '')

/**
 * The discovered-skill manifest for a workspace: enumerate every `mcp.skill` (owner, name,
 * description, pre-approved tools) plus the skipped instances and why. A READ-ONLY sibling
 * of `materialize` — it discovers and projects, writing nothing and sweeping nothing.
 *
 * The host renders its agent-profile picker from this instead of walking the generated CC
 * plugin trees + re-parsing frontmatter (which would couple it to the harness layout au-mcp
 * owns). The `skipped` set is its discovery-debug surface: "I authored X, why is it absent?".
 */
export async function skillManifest(
  entry: string,
  options: Pick<MaterializeOptions, 'broker'> = {},
): Promise<SkillManifest> {
  const broker = options.broker ?? createEngineBroker(entry)
  const { skills, skipped } = await discoverSkills(broker)
  return {
    skills: skills.map((s) => ({
      key: skillKey(s),
      owner: s.owner,
      name: s.name,
      description: s.description,
      allowedTools: s.allowedTools.map(baseToolName),
      path: s.path,
    })),
    skipped,
  }
}

/**
 * The generated skill tree for one workspace, harness, and selection:
 * `~/.arsumbris/au-mcp/gen/skill/<workspace-hash>/<harnessKey>/<selKey>/`. A thin wrapper pinning
 * the shared tree mechanism to the `skill` capability, kept as the skills path's public name.
 */
export function genPath(entry: string, harnessKey: string, selKey: string, home?: string): string {
  return genTreePath(entry, CAPABILITY, harnessKey, selKey, home)
}

/**
 * Discover this workspace's skills, shape them with the harness's transform, write the
 * tree ATOMICALLY, sweep dead-socket siblings, and return the absolute plugin dirs.
 *
 * An empty skill set is a valid, quiet outcome: the tree is replaced with an empty one
 * and no plugin dirs come back, so the harness simply launches with no extra skills.
 */
export async function materialize(
  entry: string,
  harnessKey: string,
  transform: SkillTransform,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const broker = options.broker ?? createEngineBroker(entry)
  const { skills: discovered, skipped } = await discoverSkills(broker)

  // Selection filter (host agent-profiles): materialize only the chosen subset. The full
  // discovery still drives `skipped`, so an authoring error is reported even when the
  // broken skill was not selected.
  const select = options.select
  const skills = select ? discovered.filter((s) => select.includes(skillKey(s))) : discovered

  const tree = transform(skills)
  const selKey = deriveSelKey(select, options.profileName)
  const target = genPath(entry, harnessKey, selKey, options.home)
  writeTreeAtomically(target, tree)

  // Materialize-time sweep: the backstop that catches crashed / killed daemons. The
  // launcher's teardown delete is the fast path; this alone suffices.
  const collected = await collectDeadTrees(options.home, CAPABILITY, workspaceHash(entry))

  return {
    pluginDirs: tree.pluginRoots.map((root) => path.join(target, root)),
    skills,
    skipped,
    collected,
  }
}
