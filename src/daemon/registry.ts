// The plugin registry + phase orchestration.
//
// One manifest shape (decision 2606111610): a registered Plugin is its manifest
// plus the functions for its declared shapes. The registry indexes each plugin
// by shape and runs the fixed kernel phases (P3): mediate -> act -> observe,
// plus the session-start phase at session-open.
// Within a phase, order by TIER (gate -> floor -> policy, earlier first), then by
// name (decision 2609020302 — named tiers replaced the old raw int priority).
//
// First-party plugins (Phase 3.7) register a manifest LITERAL in-process; the
// knowledge-base typed-instance discovery arm (load `entry`) is the same shape, landing
// with user-authored plugins.

import type {
  Plugin,
  PluginManifest,
  ToolManifest,
  PendingAction,
  Decision,
  SessionEvent,
  SessionLifecycle,
  RunLifecycle,
  MediationContext,
  SessionStartContext,
  PluginTier,
  ToolAccess,
} from '@arsumbris/au-mcp-sdk'
import type { ServesContract } from './served-files.ts'

export interface PluginRegistry {
  /** Add a plugin, indexing it by each shape its manifest declares. */
  register(plugin: Plugin): void
  /** Whether a plugin with this id is registered (floor+enrichment dedup, decision 2606231421). */
  has(id: string): boolean
  /** Declared deps that no registered plugin satisfies (P4: fail-closed on these). */
  missingDeps(): string[]
  /** Callable manifests, for list-capabilities. Tools only (a hook is never advertised). */
  callableManifests(): ToolManifest[]
  /** Every registered plugin's manifest (all shapes), for cross-shape checks like continuity. */
  allManifests(): PluginManifest[]
  /** A callable plugin by id, or undefined. */
  callable(id: string): Plugin | undefined
  /** Set a registered plugin's agent-facing description (from its `tool-presentation-meta`). */
  describe(id: string, description: string): void
  /** Set a registered plugin's proactive trigger (from its `tool-presentation-meta` `guidance`). */
  setGuidance(id: string, guidance: string): void
  /** Set a registered plugin's input JSON Schema (generated from its `mcp.tool.<tool>` fields). */
  setInputSchema(id: string, schema: Record<string, unknown>): void
  /** Stamp which repo OWNS a tool's def. Load-bearing: input validation resolves there. */
  setProvenance(id: string, repo: string): void
  /** A registered tool's DECLARED engine access (`manifest.access`), or undefined if unknown. */
  accessOf(id: string): ToolAccess | undefined
  /** Store the discovered serves-contracts (base tool name -> contract). Replaces prior. */
  setServes(map: Map<string, ServesContract>): void
  /** The discovered serves-contracts (base tool name -> contract). */
  serves(): Map<string, ServesContract>
  /** The mediate phase: mediators by priority; the first non-allow decision wins. */
  mediate(action: PendingAction, ctx: MediationContext): Promise<Decision>
  /** The globally-registered mediators (deployment-mandated). The daemon composes these
   *  with a session's mode-derived mediators (Phase 6.3). */
  mediators(): Plugin[]
  /** The registered stampers: plugins that augment a governed write with stamps (the stamper shape). */
  stampers(): Plugin[]
  /** The observe phase: every observer sees the event, in priority order. `configs` is the session's
   *  typed hookConfig map; each observer gets its OWN config (its manifest id's first instance) as the
   *  second `onEvent` arg — the observer-phase config delivery (decision 2609021429). */
  observe(event: SessionEvent, configs?: Map<string, unknown[]>): void
  /** Fan a session lifecycle fact to every observer that wants one. `configs` delivers each its own
   *  typed hookConfig (as in `observe`). */
  lifecycle(signal: SessionLifecycle, session: string, configs?: Map<string, unknown[]>): void
  /** Fan a RUN-lifecycle fact (run-start / run-end / session-retire) to every observer that wants one.
   *  `configs` delivers each its own typed hookConfig (as in `observe`). */
  runLifecycle(event: RunLifecycle, configs?: Map<string, unknown[]>): void
  /** The session-start phase: run every session-start hook in tier order at session-open, collecting
   *  their computed inject blocks. `configs` maps a hook's manifest id to its typed config instances
   *  (from the active profile's `hookConfig`): the hook runs once PER config instance, or once with
   *  `undefined` if it has none. `whitelist` is the profile's `hooks` off-switch (Phase 6b): when
   *  present, a NON-critical hook runs only if its id is in the set; a `critical` hook always runs;
   *  `undefined` = no restriction. Best-effort (a throwing hook is isolated + contributes nothing). */
  sessionStart(ctx: SessionStartContext, configs: Map<string, unknown[]>, whitelist?: Set<string>): Promise<string[]>
}

// TIER ordering (decision 2609020302): gate decides first (outermost), then floor, then
// policy. Earlier tier = lower rank = runs first. Absent tier defaults to `policy` (a plain
// plugin sorts after the gate + floors). Within a tier, order deterministically by id.
const TIER_RANK: Record<PluginTier, number> = { gate: 0, floor: 1, policy: 2 }
const rankOf = (p: Plugin) => TIER_RANK[p.manifest.tier ?? 'policy']
const byTier = (a: Plugin, b: Plugin) => rankOf(a) - rankOf(b) || a.manifest.id.localeCompare(b.manifest.id)

/**
 * Run a set of mediators in tier order; the first non-allow decision wins
 * (short-circuit). Shared by the global registry phase and the daemon's per-session
 * mode-derived mediators (Phase 6.3). Empty set -> allow. (Merging multiple injects
 * is deferred until composition conflict semantics are resolved at the wing.)
 */
export async function runMediators(
  mediators: Plugin[],
  action: PendingAction,
  ctx: MediationContext,
): Promise<Decision> {
  for (const plugin of [...mediators].sort(byTier)) {
    const decision = await plugin.decide!(action, ctx)
    if (decision.kind !== 'allow') return decision
  }
  return { kind: 'allow' }
}

export function createPluginRegistry(): PluginRegistry {
  const all = new Map<string, Plugin>()
  const callables = new Map<string, Plugin>()
  const mediators: Plugin[] = []
  const observers: Plugin[] = []
  const stampers: Plugin[] = []
  const sessionStarters: Plugin[] = []
  let serves = new Map<string, ServesContract>()

  return {
    register(plugin) {
      const m = plugin.manifest
      all.set(m.id, plugin)
      // Dispatch on KIND (the split, decision 2608242056): a TOOL is a callable; a HOOK is
      // indexed into the mediate/act/observe phases by each shape it declares.
      if (m.kind === 'tool') {
        callables.set(m.id, plugin)
      } else {
        if (m.shapes.includes('mediator')) {
          mediators.push(plugin)
          mediators.sort(byTier)
        }
        if (m.shapes.includes('observer')) {
          observers.push(plugin)
          observers.sort(byTier)
        }
        if (m.shapes.includes('stamper')) {
          stampers.push(plugin)
          stampers.sort(byTier)
        }
        if (m.shapes.includes('session-start')) {
          sessionStarters.push(plugin)
          sessionStarters.sort(byTier)
        }
      }
    },

    missingDeps() {
      const missing = new Set<string>()
      for (const plugin of all.values()) {
        for (const dep of plugin.manifest.dependsOn ?? []) {
          if (!all.has(dep)) missing.add(dep)
        }
      }
      return [...missing]
    },

    has: (id) => all.has(id),
    callableManifests: () =>
      [...callables.values()].map((p) => p.manifest).filter((m): m is ToolManifest => m.kind === 'tool'),
    allManifests: () => [...all.values()].map((p) => p.manifest),
    callable: (id) => callables.get(id),
    accessOf: (id) => {
      const m = all.get(id)?.manifest
      return m && m.kind === 'tool' ? m.access : undefined
    },
    describe(id, description) {
      const plugin = all.get(id)
      // description rides a TOOL's presentation; a hook has none, so this is a no-op for hooks.
      if (plugin && plugin.manifest.kind === 'tool') plugin.manifest.description = description
    },
    setGuidance(id, guidance) {
      const plugin = all.get(id)
      if (plugin && plugin.manifest.kind === 'tool') plugin.manifest.guidance = guidance
    },
    setProvenance(id, repo) {
      const plugin = all.get(id)
      if (plugin) plugin.manifest.provenance = repo
    },
    setInputSchema(id, schema) {
      const plugin = all.get(id)
      if (plugin && plugin.manifest.kind === 'tool') plugin.manifest.inputSchema = schema
    },
    setServes(map) {
      serves = map
    },
    serves: () => serves,

    mediate: (action, ctx) => runMediators(mediators, action, ctx),
    mediators: () => [...mediators],
    stampers: () => [...stampers],

    observe(event, configs) {
      // Each observer gets its OWN typed config (its manifest id's first hookConfig instance, or
      // undefined) — the observer-phase config delivery (e.g. the recorder gates persistence on `mode`).
      for (const plugin of observers) plugin.onEvent!(event, configs?.get(plugin.manifest.id)?.[0])
    },
    lifecycle(signal, session, configs) {
      for (const plugin of observers) {
        if (!plugin.onLifecycle) continue
        try {
          plugin.onLifecycle(signal, session, configs?.get(plugin.manifest.id)?.[0])
        } catch {
          // An observer's reaction is its own business, and a failing one must not take the
          // session with it. Capture degrades; the kernel does not.
        }
      }
    },
    runLifecycle(event, configs) {
      for (const plugin of observers) {
        if (!plugin.onRun) continue
        try {
          plugin.onRun(event, configs?.get(plugin.manifest.id)?.[0])
        } catch {
          // Best-effort, same as `lifecycle`: a throwing run-lifecycle handler must not take the session.
        }
      }
    },
    async sessionStart(ctx, configs, whitelist) {
      // Run each session-start hook in tier order, once PER configured instance (or once with
      // undefined if it has no `hookConfig`), collecting its inject blocks. Best-effort: a throwing
      // (or engine-unreachable) hook is isolated and contributes nothing, so a bad hook can never
      // take the session open — it just yields no inject.
      const blocks: string[] = []
      for (const plugin of sessionStarters) {
        if (!plugin.onSessionStart) continue
        // The `hooks` whitelist (Phase 6b): when present, a NON-critical hook runs only if listed.
        // A `critical` hook is MANDATORY and always runs — the whitelist cannot exclude it.
        if (whitelist && !plugin.manifest.critical && !whitelist.has(plugin.manifest.id)) continue
        const list = configs.get(plugin.manifest.id)
        const runs = list && list.length > 0 ? list : [undefined]
        for (const config of runs) {
          try {
            const result = await plugin.onSessionStart(ctx, config)
            if (result?.inject) blocks.push(...result.inject)
          } catch {
            // isolated: this run injects nothing, the rest still run.
          }
        }
      }
      return blocks
    },
  }
}
