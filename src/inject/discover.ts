// Inject discovery — the neutral `mcp.inject` assembly, reassembled in-library.
//
// An inject is a typed INSTANCE (one shape, so instances not subtypes — the mirror of
// `mcp.skill`, and unlike `mcp.tool` whose subtypes' FIELDS are their input schemas).
// Discovery is `instances_of('mcp.inject')`, never `subtypes(...)`. See the mcp.inject spec.
//
// This runs the same ONE-read assembly as skill discovery: `instances_of` with
// `instance: true` + `body: true` splices each match's value layer and prose, and every
// match carries `member` (the owning repo, a STRING). The ROLE that partitions the
// default set (entry/edit are in it, dep/discover are opt-in) is NOT on the instance
// match — it lives on the `members` read, which the engine's own contract says to join
// by name (WIRE: "a consumer needing role calls `members` ONCE and joins by name"). So
// this is a two-read assembly, one more than skills, and the extra read is the price of
// the trust boundary the role expresses.
//
// Everything here is HARNESS-NEUTRAL. What a harness wants on disk is the adapter's pure
// transform; this only produces the vocabulary. Degrades to EMPTY on an unavailable
// engine — no engine means no typed injects, which the spec makes a no-op, not a failure.

import type { WireContributionValue, WireFieldValues, WireMember, WireMemberRoleName } from '@arsumbris/au-engine-sdk'

import type { EngineBroker } from '../daemon/broker.ts'

/** The type every inject instance claims. Owned by au-mcp-sdk (the contract SDK). */
const INJECT_TYPE = 'mcp.inject'

/**
 * One `instances_of` match with the `instance` + `body` splices. The broker centrally
 * unwraps the schema-17 envelope, so `frame.result` is this array directly.
 */
interface InjectMatch {
  /** Absolute path of the instance file. */
  path?: string
  /** The declared name of the owning workspace MEMBER (a string; role is joined separately). */
  member?: string | null
  /** The file's markdown body — prose AFTER frontmatter (spliced by `body: true`). */
  body?: string | null
  /** The spliced `instance` read payload; `effective_values` is the canonical value layer. */
  instance?: { effective_values?: WireFieldValues[] } | null
}

/** An inject's stable selection identity, `<owner>:<name>` — the ref a profile selects by. */
export function injectKey(inject: Pick<Inject, 'owner' | 'name'>): string {
  return `${inject.owner}:${inject.name}`
}

/** One discovered inject, harness-neutral. */
export interface Inject {
  /** Absolute path of the instance file. */
  path: string
  /**
   * The declared name of the workspace MEMBER that owns the instance file — the per-owner
   * grouping key (one synthetic harness plugin per owner repo), same as `Skill.owner`.
   */
  owner: string
  /**
   * The owning member's ROLE, joined from the `members` read.
   *
   * This is the field that has no `mcp.skill` counterpart: it decides whether the inject
   * is in the always-on DEFAULT SET (`entry` / `edit`) or opt-in (`dep` / `discover`).
   * A consumed member offers an inject; it never imposes one. The partition itself is
   * phase 2 — discovery only CARRIES the role, it applies no policy.
   */
  role: WireMemberRoleName
  /** The invocable slug (explicit, not filename-derived). */
  name: string
  /** What this context IS, for the human picker. NOT a trigger — an inject always applies. */
  description: string
  /**
   * How many reference hops out from this instance to follow. 0 (the default) injects the
   * body alone. Absent in the value layer collapses to 0.
   */
  depth: number
  /**
   * Which reference edge kinds a hop walk follows, a closed set over the engine's
   * `references_out` classification. Empty when unset. The type requires it past depth 1;
   * enforcing that is phase 4, not here.
   */
  edgeKinds: string[]
  /**
   * What to show per node in the injected block. `body` (the default) injects prose only;
   * `body-and-frontmatter` injects the whole file. Discovery only CARRIES this; the render
   * that consumes it (mapping to the engine's `body` vs `content` read) is phase 4.
   */
  show: 'body' | 'body-and-frontmatter'
  /** The instance's freeform markdown body — the context that gets injected. */
  body: string
}

/** One instance that claimed `mcp.inject` but could not be assembled into an Inject. */
export interface SkippedInject {
  path: string
  reason: string
}

export interface InjectDiscovery {
  injects: Inject[]
  /** Never silently dropped: the caller reports these so a malformed inject is visible. */
  skipped: SkippedInject[]
}

const EMPTY: InjectDiscovery = { injects: [], skipped: [] }

/**
 * Discover every `mcp.inject` instance in the workspace, owner- and role-attributed and
 * body-carrying, sorted by `(owner, name)` so a materialized tree is deterministic.
 *
 * Two reads: `instances_of` for the injects, `members` for the roles, joined by member
 * name. An inject whose member is absent from the `members` set is SKIPPED, not defaulted
 * to a role — guessing a role is exactly the trust decision this must not make silently.
 */
export async function discoverInjects(broker: EngineBroker): Promise<InjectDiscovery> {
  if (!broker.available()) return EMPTY

  const matches = await readInjectMatches(broker)
  if (matches.length === 0) return EMPTY

  const rolesByMember = await readMemberRoles(broker)

  const injects: Inject[] = []
  const skipped: SkippedInject[] = []
  for (const match of matches) {
    const assembled = assemble(match, rolesByMember)
    if ('reason' in assembled) skipped.push({ path: match.path ?? '(unknown)', reason: assembled.reason })
    else injects.push(assembled)
  }

  injects.sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name))
  skipped.sort((a, b) => a.path.localeCompare(b.path))
  return { injects, skipped }
}

/**
 * The `mcp.inject` file matches, each carrying its value layer + prose in one read.
 *
 * `origins: ['file']` is REQUIRED, exactly as in skill discovery: the default also returns
 * `nested` (an inline record inside another instance's field) and `meta` matches, and only
 * a FILE instance has the markdown body that IS the inject's content. A nested record
 * claiming mcp.inject would otherwise yield a bodyless inject.
 */
async function readInjectMatches(broker: EngineBroker): Promise<InjectMatch[]> {
  const frame = await broker
    .read('instances_of', { type: INJECT_TYPE, origins: ['file'], instance: true, body: true })
    .catch(() => null)
  if (!frame || frame.ready === false || frame.type === 'error') return []
  const arr = Array.isArray(frame.result) ? (frame.result as InjectMatch[]) : []
  // Dedupe by path: a bare type name matches every same-named identity.
  const seen = new Set<string>()
  return arr.filter((m) => {
    const p = m.path
    if (!p || seen.has(p)) return false
    seen.add(p)
    return true
  })
}

/**
 * The member-name -> role map from the `members` read.
 *
 * On an erroring / not-ready frame this returns an EMPTY map rather than throwing, so a
 * transient `members` failure skips every inject with a clear reason instead of taking the
 * discovery down. That is the safe direction: an inject with an unknown role must not enter
 * a session, so "role unavailable" degrading to "skipped" is correct, never "defaulted in".
 */
async function readMemberRoles(broker: EngineBroker): Promise<Map<string, WireMemberRoleName>> {
  const frame = await broker.read('members').catch(() => null)
  if (!frame || frame.ready === false || frame.type === 'error') return new Map()
  const arr = Array.isArray(frame.result) ? (frame.result as WireMember[]) : []
  return new Map(arr.map((m) => [m.repo, m.role]))
}

/** Assemble one match into an Inject, or report why it could not be. Pure. */
function assemble(match: InjectMatch, roles: Map<string, WireMemberRoleName>): Inject | { reason: string } {
  const values = match.instance?.effective_values
  if (!values) return { reason: 'instance value layer unavailable' }

  const name = scalar(values, 'name')
  if (!name) return { reason: 'no `name` value (required by mcp.inject)' }
  const description = scalar(values, 'description')
  if (!description) return { reason: 'no `description` value (required by mcp.inject)' }

  if (!match.member) return { reason: 'instance lies under no declared workspace member' }
  const role = roles.get(match.member)
  if (!role) return { reason: `owning member '${match.member}' has no known role` }

  if (match.body == null) return { reason: 'no body (content unavailable)' }

  return {
    path: match.path ?? '',
    owner: match.member,
    role,
    name,
    description,
    depth: numeric(values, 'depth'),
    edgeKinds: enumList(values, 'edge-kinds'),
    // A single-select enum; absent (the common case) is the clean `body` default.
    show: scalar(values, 'show') === 'body-and-frontmatter' ? 'body-and-frontmatter' : 'body',
    // `body` is already the prose after frontmatter; drop only a leading blank line.
    body: match.body.replace(/^\n+/, ''),
  }
}

/** A single-cardinality string field's value; empty when absent or not a scalar string. */
function scalar(values: WireFieldValues[], field: string): string {
  const first = containers(values, field)[0]
  return first?.kind === 'scalar' && typeof first.value === 'string' ? first.value.trim() : ''
}

/** A single-cardinality Number field's value; 0 when absent or not numeric. */
function numeric(values: WireFieldValues[], field: string): number {
  const first = containers(values, field)[0]
  return first?.kind === 'scalar' && typeof first.value === 'number' ? first.value : 0
}

/** An enum-list field's scalar members, in authored order; empty when the field is unset. */
function enumList(values: WireFieldValues[], field: string): string[] {
  const out: string[] = []
  for (const value of containers(values, field)) {
    if (value.kind === 'scalar' && typeof value.value === 'string') out.push(value.value)
  }
  return out
}

function containers(values: WireFieldValues[], field: string): WireContributionValue[] {
  return (values.find((v) => v.field === field)?.containers ?? []).map((c) => c.value)
}
