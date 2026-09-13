// Resolve an agent-profile's typed hook config into a per-hook config map (Phase 6, decision
// 2609020302). This replaces the untyped AU_MCP_PLUGIN_CONFIG channel for hooks: the daemon reads
// the active profile from the graph at session-open and groups its `hookConfig` entries by the hook
// they configure.
//
// PURE over the `instances_of('agent-profile')` result rows — the shapes confirmed against the real
// engine (hook-whitelist-probe, schema 28). A row is:
//   { path, fields: { name?, hooks?, hookConfig? } }
// - `hookConfig` (mcp.hook&[+]): a list where an INLINE entry is a FLAT record
//     { type: 'mcp.hook.<x>::<repo>', ...configFields }
//   and a REF entry is a raw wikilink STRING '[[<instance>]]' (the engine does NOT follow it here —
//   the daemon follow-reads it, see Phase 6b action 3).
// - `hooks` (type<mcp.hook>*[]): the whitelist, a list of raw def-ref wikilink STRINGS
//     '[[mcp.hook.<x>::<repo>]]'
//   (again unresolved). ABSENT = no restriction; present = exactly those non-critical hooks.

/** One agent-profile instance row, as `instances_of` returns it (only the fields we read). */
export interface ProfileRow {
  path?: string
  fields?: { name?: unknown; hooks?: unknown; hookConfig?: unknown; tools?: unknown; skills?: unknown; nativeToolAllowlist?: unknown }
}

/** `mcp.hook.instance-count-notice` -> `mcp.instance-count-notice` (the plugin manifest id, mirroring discovery's `idOf`). */
function hookIdOf(bareTypeName: string): string {
  const HOOK_PREFIX = 'mcp.hook.'
  return bareTypeName.startsWith(HOOK_PREFIX) ? `mcp.${bareTypeName.slice(HOOK_PREFIX.length)}` : bareTypeName
}

/** A hook TYPE reference (a `[[name::repo]]` wikilink string, or the bare type name) -> its manifest id.
 *  Strips the `[[ ]]` wrapper and any `::repo` qualifier, then maps the bare def name via `hookIdOf`. */
function manifestIdOfHookRef(ref: string): string {
  const inner = ref.trim().replace(/^\[\[/, '').replace(/\]\]$/, '')
  return hookIdOf(inner.split('::')[0].trim())
}

/** Find the active profile's row by `AU_MCP_PROFILE` (matched on `fields.name` or `path`). */
function profileRow(rows: ProfileRow[], profile: string | undefined): ProfileRow | undefined {
  if (!profile) return undefined
  return rows.find((r) => r.fields?.name === profile || r.path === profile)
}

/**
 * Group the active profile's `hookConfig` entries by the hook MANIFEST ID they configure, so the
 * daemon can run each session-start hook once per configured instance with its typed fields.
 *
 * `profile` (from `AU_MCP_PROFILE`) matches a row by its `fields.name` or its `path`. Returns an empty
 * map for no profile / no match / no `hookConfig`. Each config value is the entry VERBATIM — the hook
 * narrows it to its own au-type-codegen'd config type; the extra `type` key is ignored by the hook.
 */
/** True when an entry is an INLINE config record (an object carrying a string `type`), vs a REF
 *  entry (a bare `[[...]]` wikilink string the daemon follow-reads). */
function isInlineRecord(entry: unknown): entry is { type: string } {
  return !!entry && typeof entry === 'object' && typeof (entry as { type?: unknown }).type === 'string'
}

/** Group a flat list of inline config records by the hook MANIFEST ID their `type` claims, keeping
 *  order (N instances of one type stay in authoring order). Pure. */
function groupHookConfigRecords(records: Array<{ type: string }>): Map<string, unknown[]> {
  const map = new Map<string, unknown[]>()
  for (const rec of records) {
    const id = manifestIdOfHookRef(rec.type)
    const list = map.get(id) ?? []
    list.push(rec)
    map.set(id, list)
  }
  return map
}

export function parseProfileHookConfig(rows: ProfileRow[], profile: string | undefined): Map<string, unknown[]> {
  const row = profileRow(rows, profile)
  const entries = row?.fields?.hookConfig
  if (!Array.isArray(entries)) return new Map()
  // INLINE entries only — a REF entry is a wikilink STRING with no `type`, followed by
  // `resolveProfileHookConfig` (Phase 6b action 3), which needs the broker this pure fn lacks.
  return groupHookConfigRecords(entries.filter(isInlineRecord))
}

/** A minimal engine-read fn (the broker's `read`, or a test fake): `op` + args -> a frame with `result`. */
export type EngineReadFn = (op: string, args?: Record<string, unknown>) => Promise<{ result?: unknown }>

/** Strip a `[[ ]]` wikilink wrapper, keeping the inner target (its `::repo` / fragments intact for
 *  `resolve_target`). A bare (unwrapped) string passes through. */
function wikilinkTarget(ref: string): string {
  return ref.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim()
}

/** Flatten an `instance` read's view into an inline-shaped config record `{ type, ...fields }`, or
 *  undefined when it carries no type claim. `effective_values` is the engine's provenance-rich value
 *  shape; each field's resolved value is `containers[0].value.value`. */
function recordFromInstanceView(view: unknown): { type: string } | undefined {
  const v = view as { claim?: unknown; effective_values?: unknown }
  const claim = Array.isArray(v?.claim) ? v.claim.find((c) => typeof c === 'string') : undefined
  if (typeof claim !== 'string') return undefined
  const rec: Record<string, unknown> = { type: claim }
  const evs = Array.isArray(v?.effective_values) ? v.effective_values : []
  for (const ev of evs) {
    const field = (ev as { field?: unknown })?.field
    if (typeof field !== 'string') continue
    const container = Array.isArray((ev as { containers?: unknown }).containers) ? (ev as { containers: unknown[] }).containers[0] : undefined
    const value = fieldValueFromContainer(container)
    if (value !== undefined) rec[field] = value
  }
  return rec as { type: string }
}

/** Read a field's resolved value from an `instance` read's value container. A SCALAR/list carries
 *  `value`; a REFERENCE (a `*` / `type*` def-ref) carries `{ kind: 'reference', target }`, which we
 *  reconstruct to a `[[target]]` wikilink so a followed-ref field matches the INLINE authoring form
 *  (the consumer strips the wikilink the same way for both). */
function fieldValueFromContainer(container: unknown): unknown {
  const v = (container as { value?: unknown })?.value
  if (!v || typeof v !== 'object') return undefined
  if ('value' in (v as object)) return (v as { value: unknown }).value
  const ref = v as { kind?: unknown; target?: unknown }
  if (ref.kind === 'reference' && typeof ref.target === 'string') return `[[${ref.target}]]`
  return undefined
}

/** Follow a REF `hookConfig` entry (a `[[instance]]` wikilink) to its inline-shaped config record,
 *  via the engine resolve verb: `resolve_target` (name -> path, scoped to the profile's file as
 *  `origin`) then `instance` (path -> claim + values). Undefined when it does not resolve. */
async function followHookRef(ref: string, origin: string | undefined, read: EngineReadFn): Promise<{ type: string } | undefined> {
  const target = wikilinkTarget(ref)
  if (!target) return undefined
  const rt = await read('resolve_target', { target, ...(origin ? { origin } : {}) })
  const path = (rt.result as { path?: unknown })?.path
  if (typeof path !== 'string') return undefined
  const inst = await read('instance', { path })
  return recordFromInstanceView(inst.result)
}

/**
 * The full config resolve (Phase 6b action 3): like `parseProfileHookConfig`, but ALSO follows REF
 * entries (the `&` inline-or-ref shape) via the engine resolve verb, so a shared standalone hook
 * instance configures its hook too. INLINE and followed-REF records interleave in authoring order.
 * A ref that does not resolve is skipped (best-effort — a bad ref never wedges session-open).
 */
export async function resolveProfileHookConfig(
  rows: ProfileRow[],
  profile: string | undefined,
  read: EngineReadFn,
): Promise<Map<string, unknown[]>> {
  const row = profileRow(rows, profile)
  const entries = row?.fields?.hookConfig
  if (!Array.isArray(entries)) return new Map()
  const records: Array<{ type: string }> = []
  for (const entry of entries) {
    if (isInlineRecord(entry)) records.push(entry)
    else if (typeof entry === 'string') {
      const rec = await followHookRef(entry, row?.path, read)
      if (rec) records.push(rec)
    }
  }
  return groupHookConfigRecords(records)
}

/**
 * Advisory cross-field checks on a profile's hook selection (Phase 6b action 2). ADVISORY by
 * decision 2609021655: a violating config is IGNORED + warned, never a hard refusal — matching the
 * family's open-world posture (the engine validator never rejects on diagnostics). Engine typing
 * already covers per-field correctness (bad field, dangling ref); this adds the two cross-field
 * SEMANTIC rules the type system can't express:
 * - a `critical` hook listed in the `hooks` whitelist is REDUNDANT (it always runs) -> warn.
 * - a `hookConfig` entry whose hook is absent from a PRESENT whitelist (and not critical) has its
 *   config IGNORED (the whitelist filter skips that hook at the session-start phase) -> warn.
 *
 * Neither rule can fire without a whitelist, so an unrestricted profile (`whitelist` undefined) is
 * always clean. Returns human-readable warning lines for the daemon to log at session-open.
 */
export function validateProfileHooks(
  whitelist: Set<string> | undefined,
  configuredIds: Iterable<string>,
  criticalIds: Set<string>,
): string[] {
  if (!whitelist) return []
  const warnings: string[] = []
  for (const id of whitelist) {
    if (criticalIds.has(id)) {
      warnings.push(`hook '${id}' is critical (it always runs) — listing it in the 'hooks' whitelist is redundant`)
    }
  }
  for (const id of configuredIds) {
    if (!whitelist.has(id) && !criticalIds.has(id)) {
      warnings.push(`hookConfig configures '${id}', which the 'hooks' whitelist excludes — the hook will not run, so its config is ignored`)
    }
  }
  return warnings
}

/**
 * The active profile's `hooks` WHITELIST as a set of hook MANIFEST IDS, or `undefined` when the field
 * is absent (no restriction — every hook runs). The off-switch for NON-critical hooks (Phase 6b,
 * decision 2609020302): a `critical` hook always runs regardless.
 *
 * Tri-state, mirroring the profile's `tools` allowlist:
 * - field ABSENT -> `undefined` (no restriction; every non-critical hook runs).
 * - `[]` -> an empty set (only critical hooks run).
 * - `[refs]` -> those ids (plus the always-run critical hooks).
 *
 * Entries are raw def-ref wikilink strings (`'[[mcp.hook.<x>::<repo>]]'`); non-string entries are skipped.
 */
export function parseProfileHookWhitelist(rows: ProfileRow[], profile: string | undefined): Set<string> | undefined {
  const row = profileRow(rows, profile)
  const entries = row?.fields?.hooks
  if (!Array.isArray(entries)) return undefined
  const set = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    set.add(manifestIdOfHookRef(entry))
  }
  return set
}

/** Reduce a `type<mcp.tool>*` / `type<mcp.skill>*` def-ref to the session-local HANDLE (short name):
 *  strip `[[ ]]`, any `::repo` / `#head` / `^id`, then the `mcp.tool.` / `mcp.hook.` type prefix. So the
 *  full type name a ref resolves to (`mcp.tool.read_file_pinned`) matches the registry's short tool names
 *  (`read_file_pinned`), which is what the tool-visibility allowlist is keyed on. `[[mcp.tool.read_file_pinned::r]]`
 *  -> `read_file_pinned`; a skill instance ref (`[[my-skill]]`) has no prefix and passes through. */
function bareDefName(ref: string): string {
  const t = wikilinkTarget(ref).split('::')[0].split('#')[0].split('^')[0].trim()
  if (t.startsWith('mcp.tool.')) return t.slice('mcp.tool.'.length)
  if (t.startsWith('mcp.hook.')) return t.slice('mcp.hook.'.length)
  return t
}

/**
 * The active profile's `tools` or `skills` allowlist as a set of bare def NAMES, or `undefined` when
 * the field is absent (no restriction). Tri-state, mirroring `parseProfileHookWhitelist`:
 * - field ABSENT -> `undefined` (unrestricted; every mounted tool/skill is active).
 * - `[]` -> an empty set (none active).
 * - `[refs]` -> the reduced names.
 * Entries are `type<mcp.tool>*` / `type<mcp.skill>*` def-refs (`[[name::repo]]` wikilinks); non-string
 * entries are skipped. The reduced names intersect with the registry's mounted tool / skill names.
 */
export function parseProfileNameAllowlist(
  rows: ProfileRow[],
  profile: string | undefined,
  field: 'tools' | 'skills',
): Set<string> | undefined {
  const entries = profileRow(rows, profile)?.fields?.[field]
  if (!Array.isArray(entries)) return undefined
  const set = new Set<string>()
  for (const entry of entries) if (typeof entry === 'string') set.add(bareDefName(entry))
  return set
}

/**
 * The active profile's `nativeToolAllowlist` as raw native-tool NAMES, or `undefined` when the field
 * is absent. The native twin of `parseProfileNameAllowlist` — resolved daemon-side from the profile
 * graph, replacing the retired `AU_MCP_NATIVE_TOOLS` env. Tri-state:
 * - field ABSENT -> `undefined` (every native tool allowed, the hard default).
 * - `[]` -> `[]` (no native tool allowed; the agent is pointed at the au_* gate tools).
 * - `[names]` -> exactly those.
 * Entries are plain adapter-declared native-tool names (`Read`, `Bash`, `WebFetch`), NOT engine
 * def-refs — so no `bareDefName` reduction; non-string entries are skipped.
 */
export function parseProfileNativeToolAllowlist(rows: ProfileRow[], profile: string | undefined): string[] | undefined {
  const entries = profileRow(rows, profile)?.fields?.nativeToolAllowlist
  if (!Array.isArray(entries)) return undefined
  return entries.filter((e): e is string => typeof e === 'string')
}
