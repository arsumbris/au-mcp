// The write-stamp attach — the kernel side of the `stamper` shape.
//
// A stamper (a plugin declaring the `stamper` shape) contributes stamps to a governed write:
// records the engine folds into the write's OWN commit. The stamp needs write-time facts only
// the daemon knows (the session, whether the write created / edited / renamed the file, the old
// path). So the daemon assembles a `WriteContext`, runs every registered stamper, and INJECTS the
// resulting stamp into the write tool's input before invoke — UN-FORGEABLY: it overwrites any
// agent-supplied `stamp`, so the agent can never forge one. See [[spec - stamper shape - consumer
// plugins fold stamps into governed writes]].
//
// The attach lives on the INVOKE path (not a mediator): invoke carries `{ tool, input, session }`
// in one request, so the stamp is computed and attached with no mediate->invoke channel.

import { existsSync } from 'node:fs'
import type { AttributionEntry, Plugin, SessionLaunch, Stamp, StampResult, WriteContext, WriteKind } from '@arsumbris/au-mcp-sdk'

/** Normalize a stamper's return (a bare `Stamp[]` or a `StampResult`) to the struct form. */
function asStampResult(out: Stamp[] | StampResult | undefined): StampResult | undefined {
  if (Array.isArray(out)) return { stamps: out }
  if (out && typeof out === 'object' && Array.isArray((out as StampResult).stamps)) return out as StampResult
  return undefined
}

/** How a stampable verb locates its primary file + old path, and its fixed kind (if unambiguous). */
interface VerbSpec {
  /** Fixed KIND. Undefined = derive from existence (write_file: absent -> create, else edit). */
  kind?: WriteKind
  /** The input key holding the file the stamp lands on (the write's primary file). */
  pathKey: string
  /** The input key holding the OLD path, on a rename. */
  fromKey?: string
}

// The write verbs a stamper sees, keyed by PLUGIN ID (the invoke path names a tool by its plugin id).
//
// write_file / edit_file / rename map 1:1 to create / edit / rename on a single primary file — the
// kinds the provenance SPINE is built on, and the verbs the engine `stamps` / `ensure_mixins` riders
// accept. delete_file is ALSO here, but purely for commit-level `attribution` (a delete has no
// surviving file to stamp or type): the injection below suppresses stamps + mixins on a delete, so
// only its attribution rides. rename_type is still excluded (the engine rider omits it).
//
// The refactor verbs (assign_block_id, rename_block_id, promote, inline) stay DEFERRED: promote/inline
// are multi-file sagas that CREATE a new file, so "which file, which kind" is genuinely ambiguous, an
// open question to settle with the consumer that owns file-change semantics (au-provenance).
const STAMPABLE: Record<string, VerbSpec> = {
  'mcp.write_file': { pathKey: 'file_path' }, // create | edit, by target existence
  'mcp.edit_file': { kind: 'edit', pathKey: 'file_path' },
  'mcp.rename': { kind: 'rename', pathKey: 'to', fromKey: 'file_path' },
  'mcp.delete_file': { kind: 'delete', pathKey: 'file_path' }, // attribution-only (no stamp / mixin)
}

const strField = (rec: Record<string, unknown>, key: string): string | undefined =>
  typeof rec[key] === 'string' ? (rec[key] as string) : undefined

/**
 * Compute and inject the stamp(s) for a governed write, or return `undefined` to pass the input
 * through unchanged (a non-stampable tool, or a malformed input with no resolvable path).
 *
 * For a stampable write it ALWAYS returns a sanitized input:
 * - with the daemon-computed `stamps` LIST (+ any `ensure_mixins` rider) and/or the `attribution`
 *   LIST (commit trailers) when the stampers produced them, or
 * - with any agent-supplied `stamp`/`stamps`/`ensure_mixins`(`_strict`)/`attribution` STRIPPED when
 *   they did not. Either way the agent's own value never survives — un-forgeability is structural.
 *
 * A DELETE is attribution-ONLY: it reaches the stampers (so they can attribute the deletion commit)
 * but the injection drops any stamp / mixin they returned, since the engine `delete_file` rider
 * accepts neither and there is no surviving file to carry them.
 *
 * The full list is carried: every stamper's stamps fold into the write's ONE commit (engine schema
 * 24's `stamps` rider), so a second stamper coexists by appending rather than issuing a second write.
 * `ensure_mixins` (engine schema 25) rides the SAME write beside the stamps: a stamper that TYPES a
 * file returns a `StampResult` naming the `::repo` mixin(s) to ensure on its `type:` claim, so a
 * stamped field lands DECLARED rather than advisory-invalid.
 */
export async function stampInputForWrite(
  tool: string,
  input: unknown,
  stampers: Plugin[],
  call: { session?: string; launch?: SessionLaunch; now: () => string; hookConfigs?: Map<string, unknown[]> },
): Promise<unknown | undefined> {
  const spec = STAMPABLE[tool]
  if (!spec) return undefined // not a stampable write: pass through untouched
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const path = strField(rec, spec.pathKey)
  if (!path) return undefined // malformed; gate-side validation handles it, nothing to stamp
  const stamps: Stamp[] = []
  const mixins: string[] = []
  const attribution: AttributionEntry[] = []
  // A delete carries commit `attribution` ONLY: the engine `delete_file` rider takes no stamp / mixin
  // (no surviving file), so we run the stampers for their attribution but drop any stamp / mixin.
  const attributionOnly = spec.kind === 'delete'
  // Strict resolution over the mixin CONTRIBUTORS (stampers that ensured ≥1 mixin). The write goes
  // LENIENT only when every contributor EXPLICITLY voted lenient; a strict-or-UNSET vote keeps it
  // strict (the engine default), erring safe. Counting contributors (not raw votes) is what makes an
  // unset flag count as strict rather than being ignored.
  let mixinContributors = 0
  let lenientVotes = 0
  // Stampers need the session (the record is keyed to it), so they run only for a session-bound
  // write. A session-LESS write produces no stamp but is still sanitized below — the strip is
  // unconditional, so an agent can never smuggle a forged stamp in on any stampable write.
  if (call.session && call.launch) {
    const kind: WriteKind = spec.kind ?? (existsSync(path) ? 'edit' : 'create')
    const from = spec.fromKey ? strField(rec, spec.fromKey) : undefined
    const ctx: WriteContext = {
      session: call.session,
      kind,
      path,
      launch: call.launch,
      // A stamper's typed hookConfig (decision 2609021429), keyed by its manifest id — the typed
      // replacement for launch.config (e.g. the provenance stamper's `mode`).
      hookConfig: (pluginId: string) => call.hookConfigs?.get(pluginId)?.[0],
      ...(from ? { from } : {}),
      // `at` orders renames. The engine COMMIT time is unavailable before the write, so the daemon's
      // write-time clock stands in (essentially the same moment; the rider is injected pre-commit).
      ...(kind === 'rename' ? { at: call.now() } : {}),
    }
    for (const plugin of stampers) {
      if (!plugin.stamp) continue
      const result = asStampResult(await plugin.stamp(ctx))
      if (!result) continue
      stamps.push(...result.stamps)
      // Commit-level attribution (schema 26): collected on EVERY governed write incl. delete. The
      // stamper owns the content (session / span); the kernel only folds + injects un-forgeably.
      if (result.attribution && result.attribution.length > 0) attribution.push(...result.attribution)
      // ensure_mixins rides the SAME three verbs the engine rider accepts. STAMPABLE is already
      // scoped to write_file / edit_file / rename (all three accept it), so no per-verb filter here;
      // a future stampable verb the engine rider rejects would need one.
      const contributed = result.ensureMixins ?? []
      if (contributed.length > 0) {
        for (const m of contributed) if (!mixins.includes(m)) mixins.push(m)
        mixinContributors++
        if (result.ensureMixinsStrict === false) lenientVotes++
      }
    }
  }
  const injected: Record<string, unknown> = { ...rec }
  delete injected.stamp // the singular key is retired; never let a stray one survive
  // Stamps + mixins ride create / edit / rename only; a delete drops them (engine rider rejects them,
  // no surviving file). The strip is unconditional so an agent can never smuggle a forged value in.
  if (!attributionOnly && stamps.length > 0) injected.stamps = stamps
  else delete injected.stamps // strip any agent-supplied stamps when none was produced (un-forgeable)
  // The mixin rider is un-forgeable too: strip any agent-supplied value, re-inject only the computed
  // one. Absent/empty union (or a delete) -> both keys dropped (engine sees no mixin).
  delete injected.ensure_mixins
  delete injected.ensure_mixins_strict
  if (!attributionOnly && mixins.length > 0) {
    injected.ensure_mixins = mixins
    // One per-write flag over the union. With today's single-stamper ceiling this is that stamper's
    // own vote. For N heterogeneous contributors it goes lenient only when ALL of them explicitly
    // voted lenient; otherwise the key is omitted and the engine default (strict) stands.
    if (mixinContributors > 0 && lenientVotes === mixinContributors) injected.ensure_mixins_strict = false
  }
  // Attribution (commit trailers) is un-forgeable too, and rides EVERY governed write incl. delete:
  // strip any agent-supplied value, re-inject only the stamper-produced one. Empty -> key dropped.
  delete injected.attribution
  if (attribution.length > 0) injected.attribution = attribution
  return injected
}
