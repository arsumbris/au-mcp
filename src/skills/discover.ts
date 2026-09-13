// Skill discovery — the neutral `mcp.skill` assembly, reassembled in-library.
//
// A skill is a typed INSTANCE (one shape, so instances not subtypes — the mirror of
// `mcp.tool`, whose subtypes' FIELDS are their input schemas). Discovery is therefore
// `instances_of('mcp.skill')`, never `subtypes(...)`. See the mcp.skill spec.
//
// ONE read does it (schema 17): `instances_of` with `instance: true` + `body: true`
// splices each match's value layer and prose, and every match carries `member` (the
// owning repo). The old 1+3N fan-out (a STANDIN over `resolved` / `resolve_member` /
// `content`) is retired — the engine composes it in a single pass.
//
// Everything here is HARNESS-NEUTRAL. What a harness wants on disk is the adapter's
// pure transform; this only produces the vocabulary.

import type { WireContributionValue, WireFieldValues } from '@arsumbris/au-engine-sdk'

import type { EngineBroker } from '../daemon/broker.ts'

/** The type every skill instance claims. Owned by au-mcp-sdk (the contract SDK). */
const SKILL_TYPE = 'mcp.skill'

/**
 * One schema-17 `instances_of` match with the `instance` + `body` splices. The broker
 * returns raw match records; this is the subset the assembly reads.
 */
interface SkillMatch {
  /** Absolute path of the instance file. */
  path?: string
  /** The declared name of the owning workspace MEMBER (always present on a file match). */
  member?: string | null
  /** The file's markdown body — prose AFTER frontmatter (spliced by `body: true`). */
  body?: string | null
  /** The spliced `instance` read payload; `effective_values` is the canonical value layer. */
  instance?: { effective_values?: WireFieldValues[] } | null
}

/** One discovered skill, harness-neutral. */
export interface Skill {
  /** Absolute path of the instance file. */
  path: string
  /**
   * The declared name of the workspace MEMBER that owns the instance file — the
   * per-owner grouping key (one synthetic harness plugin per owner repo).
   *
   * From the match's `member`, NOT its `type_owners`: `type_owners` names the repos
   * defining the TYPE identity (au-mcp-sdk for every skill), a different question with
   * the same answer every time.
   */
  owner: string
  /** The invocable slug (explicit, not filename-derived). */
  name: string
  /** The when-to-use trigger a harness matches on to auto-invoke. */
  description: string
  /** DISCOVERY axis: the `mcp.tool` def names this skill is about. Graph-only, never materialized. */
  relatedTools: string[]
  /** PERMISSIONS axis: the `mcp.tool` def names pre-approved while the skill is active. */
  allowedTools: string[]
  /** The instance's freeform markdown body — the skill instructions themselves. */
  body: string
}

/** One instance that claimed `mcp.skill` but could not be assembled into a Skill. */
export interface SkippedSkill {
  path: string
  reason: string
}

export interface SkillDiscovery {
  skills: Skill[]
  /** Never silently dropped: the caller reports these so a malformed skill is visible. */
  skipped: SkippedSkill[]
}

const EMPTY: SkillDiscovery = { skills: [], skipped: [] }

/**
 * Discover every `mcp.skill` instance in the workspace, owner-attributed and
 * body-carrying, sorted by `(owner, name)` so a materialized tree is deterministic.
 *
 * Degrades to EMPTY on an unavailable / erroring engine rather than throwing: no
 * engine means no typed skills to materialize, which the spec makes a no-op, not a
 * failure.
 */
export async function discoverSkills(broker: EngineBroker): Promise<SkillDiscovery> {
  if (!broker.available()) return EMPTY

  const matches = await readSkillMatches(broker)
  if (matches.length === 0) return EMPTY

  const skills: Skill[] = []
  const skipped: SkippedSkill[] = []
  for (const match of matches) {
    const assembled = assemble(match)
    if ('reason' in assembled) skipped.push({ path: match.path ?? '(unknown)', reason: assembled.reason })
    else skills.push(assembled)
  }

  skills.sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name))
  skipped.sort((a, b) => a.path.localeCompare(b.path))
  return { skills, skipped }
}

/**
 * The `mcp.skill` file matches, each carrying its value layer + prose in one read.
 *
 * `origins: ['file']` is REQUIRED. The default also returns `nested` (inline records
 * inside another instance's field) and `meta` (a type-def's meta block) matches; only a
 * FILE instance has the markdown body that IS the skill's instructions, so a nested
 * record claiming mcp.skill would yield a bodyless skill.
 *
 * `instance: true` splices the engine's canonical value layer (`effective_values`) — it
 * folds BODY contributions in with the frontmatter, and yields `reference` containers
 * for the def-ref fields. `body: true` splices the prose after frontmatter.
 */
async function readSkillMatches(broker: EngineBroker): Promise<SkillMatch[]> {
  const frame = await broker
    .read('instances_of', { type: SKILL_TYPE, origins: ['file'], instance: true, body: true })
    .catch(() => null)
  if (!frame || frame.ready === false || frame.type === 'error') return []
  const arr = Array.isArray(frame.result) ? (frame.result as SkillMatch[]) : []
  // Dedupe by path: a bare type name matches every same-named identity.
  const seen = new Set<string>()
  return arr.filter((m) => {
    const p = m.path
    if (!p || seen.has(p)) return false
    seen.add(p)
    return true
  })
}

/** Assemble one match into a Skill, or report why it could not be. Pure. */
function assemble(match: SkillMatch): Skill | { reason: string } {
  const values = match.instance?.effective_values
  if (!values) return { reason: 'instance value layer unavailable' }

  const name = scalar(values, 'name')
  if (!name) return { reason: 'no `name` value (required by mcp.skill)' }
  const description = scalar(values, 'description')
  if (!description) return { reason: 'no `description` value (required by mcp.skill)' }

  if (!match.member) return { reason: 'instance lies under no declared workspace member' }
  if (match.body == null) return { reason: 'no body (content unavailable)' }

  return {
    path: match.path ?? '',
    owner: match.member,
    name,
    description,
    relatedTools: defRefs(values, 'related-tools'),
    allowedTools: defRefs(values, 'allowed-tools'),
    // `body` is already the prose after frontmatter; drop only a leading blank line.
    body: match.body.replace(/^\n+/, ''),
  }
}

/** A single-cardinality string field's value; empty when absent or not a scalar string. */
function scalar(values: WireFieldValues[], field: string): string {
  const first = containers(values, field)[0]
  return first?.kind === 'scalar' && typeof first.value === 'string' ? first.value.trim() : ''
}

/**
 * A `type<mcp.tool>*[]` field's target DEF NAMES (e.g. `mcp.tool.shout`), in authored
 * order. The harness-facing tool name is the ADAPTER's mapping, never ours.
 *
 * The value layer yields one `reference` container per element with a resolved `target`
 * (VERIFIED against the live engine), so read the reference branch directly — no
 * wikilink-string parsing.
 */
function defRefs(values: WireFieldValues[], field: string): string[] {
  const names: string[] = []
  for (const value of containers(values, field)) {
    if (value.kind === 'reference') names.push(value.target)
  }
  return names
}

function containers(values: WireFieldValues[], field: string): WireContributionValue[] {
  return (values.find((v) => v.field === field)?.containers ?? []).map((c) => c.value)
}
