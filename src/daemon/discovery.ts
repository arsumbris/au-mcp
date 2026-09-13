// Loadable-plugin discovery (decision 2606231421, the LOADABLE half of the core/loadable
// split). Enumerate the `mcp.tool` (callable) AND `mcp.hook` (observer/mediator/stamper)
// SUBTYPES across the served workspace via the engine `subtypes` read (the split, decision
// 2608242056), dynamic-import each one's `entry` (resolved through the type OWNER), and build
// a Plugin. Ports au-host's projections/{discovery,loader}.ts to the daemon.
//
// CORE tools are NOT discovered here — they are compiled into the daemon and registered
// as manifest literals (the bootstrap floor). FLOOR + ENRICHMENT: a discovered tool whose
// id is already registered (a core tool whose defs are also mounted) is SKIPPED — the
// in-process code wins. So discovery only ever ADDS loadable tools.
//
// The manifest is DERIVED from the type-def + its `plugin-runtime-meta` (decision
// 2606111610); the loaded module supplies ONLY the shape functions (`createPlugin`).

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildIR, emitJsonSchema } from '@arsumbris/type-codegen'
import type { WireTypeDef } from '@arsumbris/type-codegen'

import type { Plugin, PluginContext, PluginManifest, PluginModule, PluginShape, PluginTier } from '@arsumbris/au-mcp-sdk'
import { PLUGIN_CONTRACT_VERSION } from '@arsumbris/au-mcp-sdk'

import type { Daemon } from './daemon.ts'
import { type BrokerLevel, type EngineBroker } from './broker.ts'
import type { ServesContract } from './served-files.ts'

const TOOL_BASE = 'mcp.tool'
const HOOK_BASE = 'mcp.hook'
const RUNTIME_META = 'plugin-runtime-meta'
const PRESENTATION_META = 'tool-presentation-meta'
const SERVES_META = 'serves-files-meta'
const PERMISSIONS_META = 'tool-access-meta'

interface WireMetaBlock {
  type_name: string
  body: { name: string; value: unknown }[]
}

/**
 * Match a meta block by its BASE type name, tolerant of a `::repo` import qualifier. When a tool
 * imports its meta type from a peer (e.g. `plugin-runtime-meta::au-mcp-sdk` instead of a vendored
 * bare copy), the served `type_name` carries the qualifier verbatim; a name never contains `:`, so
 * the base is everything before the first `::`. Discovery keys on the base so a peer-imported meta
 * and a vendored bare one resolve identically.
 */
const metaIs = (b: WireMetaBlock, base: string): boolean => b.type_name.split('::', 1)[0] === base
interface WireSubtype {
  name: string
  repo?: string
  source?: { file?: string }
  meta_blocks?: WireMetaBlock[]
  // schema 18: the required-meta names this non-abstract subtype does NOT satisfy (sorted,
  // `[]` when satisfied, always `[]` on an abstract def). The engine's read-side of
  // `subtype-missing-required-meta` — the harness gates on it instead of hand-tracking.
  unmet_required_meta?: string[]
}

/** Flatten a meta block's `[{name, value}]` body into a record. */
function metaRecord(block: WireMetaBlock): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of block.body) out[field.name] = field.value
  return out
}

/** `<pkg>/type/<file>` -> `<pkg>`: the owning package root from the def source path. */
function packageRootOf(sourceFile: string): string {
  return path.dirname(path.dirname(sourceFile))
}

// The broker level + `scopedBroker` primitive now live in broker.ts (so the grant/scoping
// modules share them without a discovery cycle); re-exported here for existing consumers.
export { scopedBroker, type BrokerLevel } from './broker.ts'
import { scopedBroker } from './broker.ts'

/** The broker level a tool REQUESTS via its `tool-access-meta` meta. Absent meta -> none. */
export function requestedBroker(def: WireSubtype): BrokerLevel {
  const block = def.meta_blocks?.find((b) => metaIs(b, PERMISSIONS_META))
  const v = block ? metaRecord(block).broker : undefined
  return v === 'read' || v === 'read-write' ? v : 'none'
}

/** Whether a subtype name sits under the callable `mcp.tool` base. */
const isToolDef = (name: string): boolean => name.startsWith(`${TOOL_BASE}.`)
/** Whether a subtype name sits under the kernel-internal `mcp.hook` base (the split, decision 2608242056). */
const isHookDef = (name: string): boolean => name.startsWith(`${HOOK_BASE}.`)
/** Whether a subtype name is a tool or a hook (a discoverable plugin, not the base itself). */
const isPluginDef = (name: string): boolean => isToolDef(name) || isHookDef(name)
/** The base (`mcp.tool` / `mcp.hook`) a plugin subtype sits under. */
const baseOf = (typeName: string): string => (isHookDef(typeName) ? HOOK_BASE : TOOL_BASE)

/** `mcp.tool.read_file_pinned` / `mcp.hook.au_recorder` -> `mcp.read_file_pinned` / `mcp.au_recorder`: the plugin id (drops the tool/hook segment). */
function idOf(typeName: string): string {
  return `mcp.${typeName.slice(baseOf(typeName).length + 1)}`
}

/** `mcp.tool.au_guide` -> `au_guide`: the BASE tool/hook name (drops the `mcp.<base>.` prefix). */
function baseNameOf(typeName: string): string {
  return typeName.slice(baseOf(typeName).length + 1)
}

/** The agent-facing description from a subtype's `tool-presentation-meta`, or undefined. */
function descriptionOf(def: WireSubtype): string | undefined {
  const block = def.meta_blocks?.find((b) => metaIs(b, PRESENTATION_META))
  if (!block) return undefined
  const desc = metaRecord(block).description
  return typeof desc === 'string' ? desc : undefined
}

/**
 * The proactive trigger from a subtype's `tool-presentation-meta` `guidance` field, or
 * undefined. Optional: most tools have no trigger. Read exactly like the description, so it
 * rides the manifest the same way and the adapter holds no per-tool notes of its own.
 */
function guidanceOf(def: WireSubtype): string | undefined {
  const block = def.meta_blocks?.find((b) => metaIs(b, PRESENTATION_META))
  if (!block) return undefined
  const text = metaRecord(block).guidance
  return typeof text === 'string' && text !== '' ? text : undefined
}

/**
 * Generate the input JSON Schema for EVERY `mcp.tool.<tool>` subtype (id -> schema),
 * from its typed FIELDS. The `subtypes` read is workspace-wide and carries each def's
 * `fields`, so this covers core + loadable + user-repo tools in one pass — the honest
 * replacement for the au-mcp-only static artifact (plan 2606102230 action 5). The schema
 * is emitted by au-type-codegen (the PRODUCER: fields -> object schema, `?`-suffix -> not
 * required, enums, arrays, sealed discriminants) — we do NOT hand-build it here. buildIR
 * tolerates a missing parent (`mcp.tool` base has no fields), so passing the tool subtypes
 * alone yields the correct flat input schemas. A per-tool emit failure is skipped, never fatal.
 */
function schemasOf(subtypes: WireSubtype[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const seen = new Set<string>()
  const toolDefs = subtypes.filter((d) => d.name.startsWith(`${TOOL_BASE}.`) && !seen.has(d.name) && seen.add(d.name))
  if (toolDefs.length === 0) return out
  let ir: ReturnType<typeof buildIR>
  try {
    ir = buildIR(toolDefs as unknown as WireTypeDef[])
  } catch {
    return out // a malformed graph -> no schemas ride the manifest; the adapter falls back
  }
  for (const def of toolDefs) {
    try {
      out.set(idOf(def.name), emitJsonSchema(ir, def.name) as unknown as Record<string, unknown>)
    } catch {
      // skip one tool's schema; keep the rest (the adapter falls back to the open schema)
    }
  }
  return out
}

/**
 * Derive the manifest from the subtype name + its plugin-runtime-meta. null if unusable.
 * The agent-facing DESCRIPTION is NOT set here — it rides the `tool-presentation-meta` and
 * is applied to every registered manifest (first-party + loadable) by `registerLoadableTools`
 * (decision 2606251602). `name` is the id; it is only the adapter's description-fallback.
 */
const isTier = (v: unknown): v is PluginTier => v === 'gate' || v === 'floor' || v === 'policy'

function manifestFrom(typeName: string, meta: Record<string, unknown>): { manifest: PluginManifest; entry: string } | null {
  const entry = meta.entry
  const contractVersion = meta.contractVersion
  if (typeof entry !== 'string' || !entry) return null
  if (typeof contractVersion !== 'number') return null
  const common = {
    id: idOf(typeName),
    name: idOf(typeName),
    contractVersion,
    ...(Array.isArray(meta.deps) ? { dependsOn: meta.deps as string[] } : {}),
    ...(isTier(meta.tier) ? { tier: meta.tier } : {}),
    ...(meta.critical === true ? { critical: true } : {}),
    ...(meta.requiresContinuity === true ? { requiresContinuity: true } : {}),
  }
  // The base decides the KIND (split decision 2608242056): an `mcp.hook` is a kernel-internal
  // capability that MUST declare its `shapes` (a subset of observer/mediator/stamper); an
  // `mcp.tool` is the agent-facing callable and declares NO shape (callable is not a shape).
  if (isHookDef(typeName)) {
    const shapes = meta.shapes
    if (!Array.isArray(shapes) || shapes.length === 0) return null
    return { manifest: { ...common, kind: 'hook', shapes: shapes as PluginShape[] }, entry }
  }
  return { manifest: { ...common, kind: 'tool' }, entry }
}

/** A loadable tool that resolved to a runnable Plugin, plus the dedup-skipped ids. */
export interface DiscoveryResult {
  /** Loadable plugins ready to register (their entry exported a `createPlugin`). */
  loaded: Plugin[]
  /** Ids skipped because `isRegistered` already holds them (a caller-supplied literal shadows the loadable). */
  skipped: string[]
  /** Every `mcp.tool` subtype's agent-facing description (id -> text), from `tool-presentation-meta`. */
  descriptions: Map<string, string>
  /** Every `mcp.tool` subtype's proactive trigger (id -> text), from `tool-presentation-meta`. Sparse. */
  guidance: Map<string, string>
  /** Every `mcp.tool` subtype's input JSON Schema (id -> schema), generated from its fields. */
  inputSchemas: Map<string, Record<string, unknown>>
  /**
   * Which repo OWNS each tool's def, for EVERY discovered subtype rather than only the
   * dynamically loaded ones.
   *
   * Load-bearing rather than cosmetic: input validation resolves `mcp.tool.<tool>` in this
   * repo, and resolving in the wrong one fails closed — the tool is refused. A first-party
   * plugin that is REGISTERED by the composition root but whose def lives in its own package
   * is exactly that case, and it is invisible to an availability check, which only inspects
   * what is advertised rather than what happens on invoke.
   */
  provenances: Map<string, string>
  /**
   * Tool id -> the required-meta names its subtype does not satisfy, from the engine's
   * `unmet_required_meta` (schema 18). For the `mcp.tool` base's `required: tool-presentation-meta`
   * this is `['tool-presentation-meta']` on any concrete tool missing its description. Only
   * non-empty entries are recorded — the engine computes the gate, the harness no longer does.
   */
  unmetRequiredMeta: Map<string, string[]>
  /** Serves-contracts: BASE tool name -> `{ pathTemplate, packageRoot }` (from `serves-files-meta`). */
  serves: Map<string, ServesContract>
  /**
   * `critical` loadables whose discovery FAILED (createPlugin threw, or the entry exported
   * no `createPlugin`). Non-empty means fail-closed: the caller (`registerLoadableTools`)
   * refuses to serve rather than silently run a session without the governance plugin. A
   * non-critical failure is NOT recorded here — it stays a best-effort skip. See
   * `PluginManifest.critical`.
   */
  failedCritical: { id: string; error: string }[]
}

/**
 * Discover loadable tools: every `mcp.tool` subtype in the served workspace that carries
 * a `plugin-runtime-meta` block, dynamic-imported into a Plugin. `isRegistered` lets the
 * caller skip a tool whose id is ALREADY registered BEFORE importing — a dedup for the seam
 * where an embedder or test pre-registered a plugin (via `opts.plugins`) that a loadable of
 * the same id would otherwise shadow. Returns empty when the engine is unreachable. Per-tool
 * failures are skipped, never fatal.
 */
export async function discoverTools(
  broker: EngineBroker,
  ctx: PluginContext,
  isRegistered: (id: string) => boolean = () => false,
): Promise<DiscoveryResult> {
  const empty: DiscoveryResult = {
    loaded: [], skipped: [], descriptions: new Map(), guidance: new Map(), inputSchemas: new Map(),
    provenances: new Map(), unmetRequiredMeta: new Map(),
    serves: new Map(), failedCritical: [],
  }
  if (!broker.available()) return empty
  // Read BOTH agent-facing bases (the split, decision 2608242056): `mcp.tool` = the callable
  // tools, `mcp.hook` = the observer/mediator/stamper hooks. A per-base failure yields no
  // subtypes for that base; both failing leaves `subtypes` empty, which produces the empty
  // result naturally (the kernel serves nothing until au-mcp-core mounts).
  const readBase = async (base: string): Promise<WireSubtype[]> => {
    try {
      const frame = await broker.read('subtypes', { base })
      if (frame.ready === false || frame.type === 'error') return []
      const result = frame.result as { subtypes?: WireSubtype[] } | undefined
      return Array.isArray(result?.subtypes) ? result.subtypes : []
    } catch {
      return []
    }
  }
  const [toolSubs, hookSubs] = await Promise.all([readBase(TOOL_BASE), readBase(HOOK_BASE)])
  const subtypes: WireSubtype[] = [...toolSubs, ...hookSubs]

  // Input schema for EVERY tool subtype (core + loadable), generated from its typed fields
  // by au-type-codegen, applied to the matching registered manifest by registerLoadableTools.
  // Rides the manifest exactly like the description (decision 2606251602 / plan action 5).
  const inputSchemas = schemasOf(subtypes)
  // The def's own repo is the authority on ownership, whatever registered the callable. Every
  // agent-facing def now lives in a package (au-mcp owns none), so provenance IS the owning repo;
  // the kernel-bundled 'core' label only ever attaches to a caller-supplied literal, stamped at
  // registration in daemon.ts, never to a discovered def.
  const provenances = new Map<string, string>()
  for (const def of subtypes) {
    if (!isPluginDef(def.name) || !def.repo) continue
    provenances.set(idOf(def.name), def.repo)
  }

  const loaded: Plugin[] = []
  const skipped: string[] = []
  // Description is collected for EVERY tool subtype (first-party + loadable), so it can be
  // applied to the matching registered manifest — the leaf comes from the def's meta, not a
  // downstream table (decision 2606251602). Whether a tool DECLARED its required presentation
  // meta is now the ENGINE's call: the `mcp.tool` base declares `required: tool-presentation-meta`,
  // and the engine reports each concrete subtype's `unmet_required_meta` on the subtypes view.
  const descriptions = new Map<string, string>()
  const guidance = new Map<string, string>()
  const unmetRequiredMeta = new Map<string, string[]>()
  // Serves-contracts are collected for EVERY tool subtype, BEFORE the runtime-meta gate below —
  // a tool can declare a serves-contract off its typed def independent of being loadable.
  const serves = new Map<string, ServesContract>()
  // Fail-closed accounting: a `critical` loadable whose discovery fails is recorded here so
  // the caller can refuse to serve, instead of the silent skip a non-critical failure gets.
  const failedCritical: { id: string; error: string }[] = []
  for (const def of subtypes) {
    if (!isPluginDef(def.name)) continue // a base itself / unrelated
    const id = idOf(def.name)
    const desc = descriptionOf(def)
    if (desc) descriptions.set(id, desc)
    const guide = guidanceOf(def)
    if (guide) guidance.set(id, guide)
    // The description GATE is the engine's: `unmet_required_meta` names the required metas this
    // concrete subtype fails to declare (`tool-presentation-meta` among them for a description-less tool).
    if (Array.isArray(def.unmet_required_meta) && def.unmet_required_meta.length > 0) {
      unmetRequiredMeta.set(id, def.unmet_required_meta)
    }

    // Serves-contract: what this tool serves as a function of input (the daemon recomputes the
    // served file at observe). packageRoot is where the def lives (the template resolves against it).
    const servesBlock = def.meta_blocks?.find((b) => metaIs(b, SERVES_META))
    if (servesBlock && def.source?.file) {
      const pathTemplate = metaRecord(servesBlock).pathTemplate
      if (typeof pathTemplate === 'string' && pathTemplate) {
        serves.set(baseNameOf(def.name), { pathTemplate, packageRoot: packageRootOf(def.source.file) })
      }
    }
    const block = def.meta_blocks?.find((b) => metaIs(b, RUNTIME_META))
    if (!block) continue // no runtime meta -> not loadable code (an unrelated subtype)
    if (!def.source?.file) continue
    const derived = manifestFrom(def.name, metaRecord(block))
    if (!derived) continue
    // Enforce the kernel<->plugin handshake: exact equality against the kernel-expected
    // PLUGIN_CONTRACT_VERSION (loud fail-closed, no override — decision 2609091649). A skewed
    // plugin is REFUSED, never loaded at the wrong contract. Routed through the existing
    // critical/non-critical ethos: a `critical` plugin fails the daemon closed (refuse to
    // serve, like a critical load failure); a non-critical one is skipped with a loud warning.
    if (derived.manifest.contractVersion !== PLUGIN_CONTRACT_VERSION) {
      const msg = `plugin contract v${derived.manifest.contractVersion} != kernel-expected v${PLUGIN_CONTRACT_VERSION}`
      if (derived.manifest.critical) failedCritical.push({ id: derived.manifest.id, error: msg })
      else process.stderr.write(`au-mcp: skipping ${derived.manifest.id}: ${msg}\n`)
      continue
    }
    // Provenance: a loadable tool is CONTRIBUTED by the package that owns its def (the
    // subtype's owner repo).
    derived.manifest.provenance = def.repo ?? derived.manifest.provenance
    // Access: the SAME `tool-access-meta` level the tool declares for its own scoped broker
    // (below) also rides its manifest, so a mediator classifies it at decide. `requestedBroker`
    // reads the def's meta. TOOLS only — a hook declares no tool-access-meta and gets a
    // read-only broker from the daemon.
    if (derived.manifest.kind === 'tool') derived.manifest.access = requestedBroker(def)
    if (isRegistered(derived.manifest.id)) {
      skipped.push(derived.manifest.id) // a caller-supplied literal already holds this id; don't import
      continue
    }
    const entryPath = path.resolve(packageRootOf(def.source.file), derived.entry)
    try {
      const module = (await import(pathToFileURL(entryPath).href)) as Partial<PluginModule>
      if (typeof module.createPlugin !== 'function') {
        // entry exports no createPlugin -> not loadable. Fatal only if the def marked itself critical.
        if (derived.manifest.critical) failedCritical.push({ id: derived.manifest.id, error: 'entry exports no createPlugin' })
        continue
      }
      // The tool gets exactly the engine access its own def DECLARES, fixed for its
      // lifetime in this daemon. A tool declaring nothing gets no broker. There is no
      // human knob here: which tools a session has is the allowlist's separate axis
      // (tool-visibility spec), and it never changes what a tool may do once loaded.
      const runtime = module.createPlugin({ ...ctx, broker: scopedBroker(broker, requestedBroker(def)) })
      loaded.push({ manifest: derived.manifest, ...runtime })
    } catch (err) {
      // import/construct failed. A non-critical tool is skipped (keep the rest); a `critical`
      // one is recorded so the caller fails closed rather than run a session without it.
      if (derived.manifest.critical) failedCritical.push({ id: derived.manifest.id, error: err instanceof Error ? err.message : String(err) })
      continue
    }
  }
  return { loaded, skipped, descriptions, guidance, inputSchemas, provenances, unmetRequiredMeta, serves, failedCritical }
}

/**
 * Discover loadable tools and register them into the daemon, skipping ids already
 * registered (a caller-supplied literal shadows a loadable of the same id). Returns
 * what was added/skipped. Called by `startDaemon` after any caller-supplied set.
 */
export async function registerLoadableTools(daemon: Daemon): Promise<{ added: string[]; skipped: string[] }> {
  const { loaded, skipped, descriptions, guidance, inputSchemas, provenances, unmetRequiredMeta, serves, failedCritical } = await discoverTools(
    daemon.broker,
    { workspace: daemon.workspace },
    (id) => daemon.registry.has(id),
  )
  // FAIL CLOSED (eager): a `critical` governance plugin that failed to load must not be
  // silently skipped. Throw BEFORE the caller binds the socket (serve.ts) — the daemon
  // refuses to serve rather than run a session ungated. Symmetric with the static-dep abort
  // in createDaemon. (The lazy path, ensureLoadableTools, poisons the running daemon instead,
  // since it cannot un-listen; it is the COMMON path under the engine-startup race.)
  if (failedCritical.length > 0) {
    const detail = failedCritical.map((f) => `${f.id} (${f.error})`).join(', ')
    throw new Error(`au-mcp: critical governance plugin failed to load, refusing to serve: ${detail}`)
  }
  daemon.registry.setServes(serves)
  const added: string[] = []
  for (const plugin of loaded) {
    daemon.registry.register(plugin)
    added.push(plugin.manifest.id)
  }
  // Apply each tool's agent-facing description from its `tool-presentation-meta` onto the
  // registered manifest — uniformly across first-party literals + just-loaded loadables
  // (decision 2606251602). The adapter then forwards manifest.description, holding no table.
  for (const [id, description] of descriptions) daemon.registry.describe(id, description)
  // Same for the optional proactive trigger, so the session's orientation names guidance only
  // for tools it actually has, and no downstream layer keys notes by tool name.
  for (const [id, text] of guidance) daemon.registry.setGuidance(id, text)
  // Same for the input JSON Schema, generated from each tool's typed fields (plan action 5):
  // it rides the manifest, so loadable tools advertise their real inputs, not an empty schema.
  for (const [id, schema] of inputSchemas) daemon.registry.setInputSchema(id, schema)
  for (const [id, repo] of provenances) daemon.registry.setProvenance(id, repo)
  // The `mcp.tool` base declares `required: tool-presentation-meta` (schema 18), so the ENGINE now
  // enforces "every non-abstract tool declares its description meta" — a gap fires
  // `subtype-missing-required-meta` and surfaces as `unmet_required_meta` on the subtypes view.
  // The harness just reports the registered offenders (previously the harness hand-checked this
  // itself; engine ask [[message - 260625160011 - base type declaring required meta on its subtypes::au-engine]] is now closed).
  const missing = [...unmetRequiredMeta].filter(([id]) => daemon.registry.has(id))
  if (missing.length > 0) {
    const detail = missing.map(([id, unmet]) => `${id} (${unmet.join(', ')})`).join(', ')
    process.stderr.write(`au-mcp: tools with unmet required meta (engine subtype-missing-required-meta): ${detail}\n`)
  }
  return { added, skipped }
}
