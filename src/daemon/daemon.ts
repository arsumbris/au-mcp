// The kernel daemon: workspace-shared state + the request dispatcher.
//
// Holds the workspace-shared registry (plugins/tools + engine connection, wired
// in later actions) and the session registry. `handle` is the single dispatch
// point the wire server calls per request.
//
// This action (3.4) lands session lifecycle + the dispatcher skeleton. The
// "no plugins yet" branches return correct defaults: with no mediators every
// action is allowed; with no callables an invoke is an error; capabilities are
// empty. Orchestration (3.6), tools (3.7), and the consult-trace query (3.8)
// fill those branches in.

import {
  MCP_CONTRACT_VERSION,
  type ClientRequest,
  type DaemonResponse,
  TURN_BOUNDARY_KIND,
  type MediationContext,
  type SessionStartContext,
  type SessionScope,
  type SessionLaunch,
  type AdapterInfo,
  type Plugin,
  type TraceQuery,
  type ConsultTrace,
  type DormantSession,
  pinnedFileTarget,
} from '@arsumbris/au-mcp-sdk'
import type { WireConnection } from '../wire/server.ts'
import { SessionRegistry, type Session } from './session.ts'
import { createEngineBroker, scopedBroker, type EngineBroker } from './broker.ts'
import { stampInputForWrite } from './stamp.ts'
import { SessionBindings } from './bindings.ts'
import { checkToolInput } from './validate.ts'
import { createPluginRegistry, runMediators, type PluginRegistry } from './registry.ts'
import {
  parseProfileHookConfig,
  parseProfileHookWhitelist,
  parseProfileNameAllowlist,
  parseProfileNativeToolAllowlist,
  resolveProfileHookConfig,
  validateProfileHooks,
  type ProfileRow,
} from './profile-config.ts'
import { defaultKernelPlugins } from '../plugins/index.ts'
import { discoverTools } from './discovery.ts'
import { resolveSessionScope } from './session-scope.ts'
import { isAllowed, toolName } from './tool-visibility.ts'
import { relative } from 'node:path'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { currentContentHash, currentContentMeta, filePathOf } from './read-guard.ts'
import { registerServedFiles } from './served-files.ts'
import { createFreshness } from './freshness.ts'
import { pendingActionToPreviewOp, previewOpToWireArgs, toActionPreview } from './preview.ts'
import type { WirePreviewMutationResult } from '@arsumbris/au-engine-sdk'
import { contentHash } from '@arsumbris/au-engine-sdk'
import {
  appendRecovery,
  loadRecovery,
  sweepRetention,
  listSessions,
  loadSessionRecord,
  persistSessionRecord,
  markSessionDormant,
  retire,
  readRetentionWindowMs,
  writeRetentionWindow,
  RECOVERY_ORPHAN_MAX_AGE_MS,
  RETENTION_DORMANT_MAX_AGE_MS,
  type SessionSummary,
} from './crash-recovery.ts'
import {
  EventKind,
  type SessionEvent,
  type SessionLifecycle,
  type RunLifecycle,
  type ReplayEvent,
  type ApprovalVerdictData,
} from '@arsumbris/au-mcp-sdk'

/**
 * The OBSERVABLE conversation kinds an adapter may REPLAY on a resumed run (the `sessionRehydrate`
 * seam). The kernel refuses any other kind — governance is daemon-sourced and un-forgeable, so it
 * must never arrive via a forgeable replay. Fail-closed: an unrecognized (e.g. plugin-governance)
 * kind is dropped. Deliberately EXCLUDES `tool_denied`, `judgment`, `span_open`/`span_close`,
 * `approval_*`, and any plugin-namespaced kind.
 */
const REPLAYABLE_KINDS = new Set<string>([
  EventKind.SessionStart,
  EventKind.UserPrompt,
  EventKind.AssistantMessage,
  EventKind.ToolStart,
  EventKind.ToolCall,
  EventKind.ToolFailed,
  EventKind.Notification,
  EventKind.Compaction,
  EventKind.SessionEnd,
])
import { osascriptApproval, type ApprovalPrompt } from './approval.ts'

/**
 * A read-only view of a session's launch/governance facts, for the per-call context a LOADABLE
 * plugin gets (it can't close over per-session state, being built once). Per-hook config is no
 * longer here — it rides the typed `hookConfig` channels (decision 2609021429).
 */
function launchOf(info: AdapterInfo, nativeToolAllowlist: string[] | undefined): SessionLaunch {
  return {
    gatePrefix: info.gatePrefix,
    // The native-tool allowlist is resolved DAEMON-SIDE from the active profile at the fresh open
    // (`session.nativeToolAllowlist`), no longer sourced from the retired `AU_MCP_NATIVE_TOOLS` env.
    // A session-less invoke passes `undefined` (unrestricted), like the old AdapterInfo default.
    nativeToolAllowlist,
  }
}

export interface DaemonOptions {
  /** The workspace root this daemon is scoped to (1:1 with the au-engine daemon). */
  workspace: string
  /** Called after a `shutdown` request is acked, so the runtime can stop + exit. */
  onShutdown?: () => void
  /** Engine broker override (tests inject a fake; defaults to the workspace's au-engine). */
  broker?: EngineBroker
  /** Plugins to register at startup. Defaults to the first-party set; tests override. */
  plugins?: Plugin[]
  /** Human-approval surface for `MediationContext.requestApproval`. Defaults to a native macOS
   *  dialog; tests inject a fake so no real dialog is spawned. */
  approval?: ApprovalPrompt
  /** Dormancy retention window (ms): a cleanly-closed session is kept resumable this long, then
   *  retired by the age-sweep. `startDaemon` resolves it from au-mcp's scoped-config (async) and
   *  passes it here; direct callers pass it too. Absent -> the 30-day hard default. */
  retentionWindowMs?: number
}

export interface Daemon {
  /** Dispatch one client request to its response. The wire server calls this. */
  handle(request: ClientRequest, conn: WireConnection): Promise<DaemonResponse>
  /** The workspace this daemon serves. */
  readonly workspace: string
  /** The engine broker (workspace-shared); engine-read tools read through it (P7). */
  readonly broker: EngineBroker
  /** The plugin registry (workspace-shared). */
  readonly registry: PluginRegistry
  /** Open session count (introspection / tests). */
  sessionCount(): number
  /**
   * Retire a session: emit the best-effort `session-retire` signal and GC its durable store. The
   * whole kernel side of retirement — a recorder follows `run-start(isResume)`, so no ledger rename.
   */
  retireSession(session: string): void
  /**
   * Inject an adapter's OBSERVABLE conversation replay into a resumed session's live log, read-only,
   * refusing any non-observable (governance) kind. The adapter supplies identity-free `ReplayEvent`s;
   * the kernel stamps `(run, seq)`. Returns `{ injected, refused }`. Reached over the wire via the
   * `session-rehydrate` request (au-mcp-adapter-cc's resume replay).
   */
  ingestReplay(session: string, events: ReplayEvent[]): { injected: number; refused: number }
}

export function createDaemon(opts: DaemonOptions): Daemon {
  const sessions = new SessionRegistry()
  // Resolves the session for a session-less invoke (the CC mcp-server shim carries only the launch
  // handle) by mapping the handle to the live session. Bound/rebound at session-open. See bindings.ts.
  const bindings = new SessionBindings()
  const broker = opts.broker ?? createEngineBroker(opts.workspace)
  const approval = opts.approval ?? osascriptApproval
  const registry = createPluginRegistry()
  const plugins = opts.plugins ?? defaultKernelPlugins()
  // The kernel composes ZERO in-process literals by default (defaultKernelPlugins() = []); every
  // tool + floor is a loadable au-mcp-core plugin discovered as a workspace member. This loop runs
  // only over a caller-supplied `plugins` (tests, embedders). Any such plugin with no provenance is
  // stamped 'core' so the adapter reports it as kernel-bundled rather than package-contributed.
  for (const plugin of plugins) {
    plugin.manifest.provenance ??= 'core'
    registry.register(plugin)
  }
  // P4: a declared dep no plugin satisfies is fatal — fail closed, never silent-degrade.
  const missing = registry.missingDeps()
  if (missing.length > 0) {
    throw new Error(`unsatisfied plugin dependencies: ${missing.join(', ')}`)
  }
  // RETENTION age-sweep on start: retire a DORMANT session past its window (default 30d) and an
  // ORPHAN (open/crashed mid-run) past the shorter 24h window. Routed THROUGH `retireSession` (not a
  // bare rm), so each retirement emits the best-effort `session-retire` signal + GC's the store —
  // keeping the kernel store and any recorder consistent. Safe at startup: no session is live yet.
  // The window is resolved by `startDaemon` (async, from scoped-config) and passed in as
  // `retentionWindowMs`; direct callers (tests) pass it too. Absent -> the 30d hard default.
  const dormantWindowMs = opts.retentionWindowMs ?? RETENTION_DORMANT_MAX_AGE_MS
  sweepRetention(opts.workspace, { dormantWindowMs, orphanWindowMs: RECOVERY_ORPHAN_MAX_AGE_MS }, (id) => retireSession(id))

  // Session FRESHNESS (Mechanism 3): hold ONE `changes` subscription and keep each session's
  // read-views honest against external change, by hash-equality (echo-suppression falls out — the
  // writer holds the post-write hash). Invalidations queue a per-session notice, drained onto the
  // next tool result's `additionalContext` (the `observe` reply). Only subscribed when an engine is
  // reachable at startup (the daemon is paired 1:1 with it); a fake/engineless broker stays inert.
  const pendingNotices = new Map<string, Set<string>>()
  const freshness = createFreshness({
    subscribeChanges: broker.available() ? broker.subscribeChanges?.bind(broker) : undefined,
    sessions: () => sessions.all(),
    currentHash: (p) => currentContentHash(broker, p),
    notify: (session, paths) => {
      const set = pendingNotices.get(session) ?? new Set<string>()
      for (const p of paths) set.add(p)
      pendingNotices.set(session, set)
    },
  })

  /** Project a durable-store summary to the host-facing dormant-session shape (drops the internal
   *  `dormant` flag — the list is already dormant-only). */
  const toDormant = (s: SessionSummary): DormantSession => ({
    id: s.id,
    run: s.run,
    lastActiveMs: s.lastActiveMs,
    sizeBytes: s.sizeBytes,
    // The resume discriminator + opaque relaunch ref + the profile to restore, so a host resumes via
    // the right adapter with the same capability surface.
    ...(s.harness !== undefined ? { harness: s.harness } : {}),
    ...(s.resumeRef !== undefined ? { resumeRef: s.resumeRef } : {}),
    ...(s.profile !== undefined ? { profile: s.profile } : {}),
  })

  // --- session CONTINUITY REQUIREMENTS (2b) ---------------------------------------------------
  // A resume that LOST its durable state (retired/wiped) cannot run a capability that needed it.
  // Tier 1 (optional): hide that capability's tools + deny its calls. Tier 2 (required): block all
  // writes. See [[spec - session continuity requirements ...]].

  /** Tier-1 hide set: callable ids that require continuity, when this session lost it. Empty otherwise. */
  function continuityHiddenTools(session: Session): Set<string> {
    if (!session.continuityLost) return new Set()
    return new Set(registry.callableManifests().filter((m) => m.requiresContinuity).map((m) => m.id))
  }

  /**
   * The MANDATORY continuity-needing capabilities that cannot function on this (continuity-lost) session.
   * A capability SELF-DESCRIBES both flags — `requiresContinuity` (needs the durable state) + `critical`
   * (mandatory) — so the requirement is derived by QUERYING the mounted set, NOT from a per-launch
   * `require` list. Opt-out is per-workspace membership (don't mount it). Empty unless continuity is lost.
   * See [[decision - 2608092020 - continuity criticality self-described and queried, not a launch require argument]].
   */
  function mandatoryLostCapabilities(session: Session): string[] {
    if (!session.continuityLost) return []
    return registry
      .allManifests()
      .filter((m) => m.requiresContinuity && m.critical)
      .map((m) => m.provenance ?? m.id)
  }

  /** Tier-2: writes fail closed when a `critical` continuity-needing capability can't run this session. */
  function continuityWriteBlocked(session: Session): boolean {
    return mandatoryLostCapabilities(session).length > 0
  }

  /** The loud notice for a Tier-2 write-block: what happened + how to recover. */
  function continuityBlockNotice(session: Session): string {
    const req = mandatoryLostCapabilities(session).join(', ')
    return (
      `this session's saved state was cleaned up (retired or wiped), so a mandatory capability (${req}) cannot be ` +
      `honored — writes are blocked for this resumed session. Reads still work. Start a NEW session (fully under the ` +
      `required capability from the start), or have an admin override.`
    )
  }

  /** Drain a session's queued freshness notices into one advisory line, or undefined if none. */
  function drainFreshnessNotice(session: string): string | undefined {
    const set = pendingNotices.get(session)
    if (!set || set.size === 0) return undefined
    pendingNotices.delete(session)
    const paths = [...set]
    const head = `${paths.length} file(s) changed outside your last read — re-read before acting on them again:`
    return `${head}\n${paths.map((p) => `- ${p}`).join('\n')}`
  }

  // LAZY loadable-tool discovery (P7-O4 fix). Discovery needs the engine (the `subtypes`
  // read), so a one-time startup pass loses every loadable tool when the daemon starts
  // before the engine socket exists (a startup race). Instead, run it on demand on the
  // first request once the engine is reachable: by the time a client lists capabilities
  // or invokes, the engine is up. Idempotent (registry.has dedups + a done flag); a no-op
  // when already done or no engine. The startup pass in serve.ts stays as an eager best-effort.
  let loadableDiscovered = false
  // FAIL CLOSED (lazy). Loadable discovery is the COMMON path here: the daemon usually
  // starts before the engine socket exists (P7-O4 race), so the eager serve.ts pass finds
  // nothing and the real discovery happens on the first request. If a `critical` governance
  // plugin fails to load, we cannot un-listen — so we POISON the daemon: every request is
  // refused (mediate DENIES, so no tool runs), loudly naming the plugin. Set once, sticky.
  let poisoned: string | null = null
  async function ensureLoadableTools(): Promise<void> {
    if (loadableDiscovered || !broker.available()) return
    try {
      const { loaded, descriptions, guidance, inputSchemas, provenances, serves, failedCritical } = await discoverTools(broker, { workspace: opts.workspace }, (id) => registry.has(id))
      if (failedCritical.length > 0) {
        poisoned = failedCritical.map((f) => `${f.id} (${f.error})`).join(', ')
        process.stderr.write(`au-mcp: critical governance plugin failed to load, refusing every request: ${poisoned}\n`)
        return // do not register a partial set behind a failed gate; handle() refuses from here on.
      }
      for (const plugin of loaded) registry.register(plugin)
      // Serves-contracts ride the discovery pass; the observe path reads them off the registry
      // (decision 2607030037). Read-preconditions are no longer assembled here — the tool-precondition
      // floor is a loadable au-mcp-core plugin that derives its own map from the engine (plan 2608261532).
      registry.setServes(serves)
      // Enrich every registered manifest (core literals + just-loaded loadables) with its
      // agent-facing description + generated inputSchema — same as the eager serve.ts pass, so
      // the lazy path (engine-up-after-startup race) advertises full schemas, not empty ones.
      for (const [id, description] of descriptions) registry.describe(id, description)
      for (const [id, text] of guidance) registry.setGuidance(id, text)
      for (const [id, schema] of inputSchemas) registry.setInputSchema(id, schema)
      // Ownership from the DEF, not from what registered the callable: validation resolves there.
      for (const [id, repo] of provenances) registry.setProvenance(id, repo)
      loadableDiscovered = true // engine was reachable -> a real discovery pass ran
    } catch {
      // engine flickered mid-discovery; leave undiscovered so the next request retries.
    }
  }

  /**
   * Filter a session's live log per a TraceQuery (consult-trace, P5). Filters
   * compose (AND); chronological order is preserved. `thisTurn` keys off the
   * SDK's well-known `TURN_BOUNDARY_KIND`; the trace plugin's vocabulary names
   * its turn-start event the same, so the kernel stays SDK-only.
   */
  function queryLog(session: Session, query: TraceQuery) {
    let events = session.log
    if (query.thisTurn) {
      let start = 0
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].kind === TURN_BOUNDARY_KIND) {
          start = i
          break
        }
      }
      events = events.slice(start)
    }
    if (query.sinceSeq !== undefined) events = events.filter((e) => e.seq >= query.sinceSeq!)
    if (query.kinds && query.kinds.length > 0) {
      const kinds = new Set(query.kinds)
      events = events.filter((e) => kinds.has(e.kind))
    }
    if (query.limit !== undefined && events.length > query.limit) {
      events = events.slice(events.length - query.limit) // the most recent `limit`
    }
    return events
  }

  /**
   * The `consultTrace` closure over one session's live log — the single source for the read a
   * mediator gets (MediationContext), a callable gets (CallableContext), and the consult-trace
   * wire case returns. Factored so the three paths cannot drift on the slice shape.
   */
  function makeConsultTrace(session: Session): ConsultTrace {
    return async (query) => ({ events: queryLog(session, query), headSeq: sessions.headSeq(session.id) })
  }

  /**
   * The full MediationContext for a session — the handles a mediator gets at BOTH `decide`
   * (pre-tool) and `review` (post-tool). Factored so the two turns hand the same context and
   * cannot drift. `emit`/`requestApproval` append through the same governance-recording closure
   * (`record`): a stamped event, crash-persisted (not opt-out), then fanned to observers.
   */
  function mediationContextFor(session: Session): MediationContext {
    const record = (kind: string, data: unknown): void => {
      const stamped = sessions.append(session.id, { kind, run: 0, seq: 0, session: session.id, data })
      if (!stamped) return
      appendRecovery(opts.workspace, session.id, stamped)
      registry.observe(stamped, session.hookConfigs)
    }
    return {
      session: session.id,
      // Run-lifecycle facts a continuity-deciding mediator reads at decide time. `isResume` mirrors
      // the `run-start` fact: `priorRun` is set at open iff that open resumed (open computes
      // `priorRun = resumed ? rec.run : undefined`), so `priorRun !== undefined` === `resumed`.
      run: sessions.runOf(session.id),
      isResume: session.priorRun !== undefined,
      ...(session.priorRun !== undefined ? { priorRun: session.priorRun } : {}),
      launch: launchOf(session.info, session.nativeToolAllowlist),
      // A mediator's OWN typed config from the profile's `hookConfig` (decision 2609021429), keyed by
      // its manifest id — the typed replacement for `launch.config`. A mediator is a singleton, so it
      // gets the FIRST configured instance of its id (or undefined). Reaches both decide + review since
      // both build ctx via this fn. Stashed on the session at the fresh open.
      hookConfig: (pluginId: string) => session.hookConfigs?.get(pluginId)?.[0],
      consultTrace: makeConsultTrace(session),
      // Read-view accessors (ready-made, read-only), the plugin-facing surface of the session's
      // read/served view — parallel to `consultTrace`. `hasRead` is the canonicalized union
      // predicate (read-view ∪ served-view), the precondition floor's input; `readHash` is the
      // exact-path read-time hash (read-view only), the read-before-write staleness input. Built
      // per context so a mediator sees the view as of decide/review time. The kernel keeps
      // MAINTAINING the view (freshness the write seam needs); the DENY policy is the plugin's.
      ...readViewAccessors(session),
      nativeTools: session.info.nativeTools,
      // READ-ONLY engine access: a mediator DECIDES / REVIEWS, it never mutates.
      broker: scopedBroker(broker, 'read'),
      emit: record,
      requestApproval: async (req) => {
        const verdict = await approval(req, session.id)
        const data: ApprovalVerdictData = {
          tool: req.tool,
          input: req.inputSummary,
          tool_use_id: req.toolUseId,
          reason: req.reason,
        }
        record(verdict === 'granted' ? EventKind.ApprovalGranted : EventKind.ApprovalDenied, data)
        return verdict
      },
      accessOf: (action) => {
        const gp = session.info.gatePrefix
        const base = gp && action.tool.startsWith(gp) ? action.tool.slice(gp.length) : action.tool
        return registry.accessOf(base.startsWith('mcp.') ? base : `mcp.${base}`)
      },
      // Mediation-level PREVIEW of the pending write (decide-time, read-only). au-mcp maps the
      // action -> engine mutation and calls `preview_mutation`, projecting the result to the
      // agent-facing `ActionPreview`. Undefined when the action is not a previewable mutation or
      // no engine is reachable — a gate branches on that like it does `broker.available()`.
      previewAction: async (action) => {
        const op = pendingActionToPreviewOp(action, session.info.gatePrefix)
        if (!op || !broker.available()) return undefined
        let frame
        try {
          frame = await broker.read('preview_mutation', previewOpToWireArgs(op))
        } catch {
          return undefined // broker timeout / unreachable -> no preview (never blocks decide)
        }
        if (frame.ready === false || frame.type === 'error' || frame.result == null) return undefined
        return toActionPreview(frame.result as WirePreviewMutationResult)
      },
    }
  }

  /**
   * The handles a SESSION-START hook is given at the fresh open (decision 2609020302). A read-only
   * slice of the mediation context — no PendingAction exists at session open, so no accessOf /
   * previewAction / requestApproval / read-view predicates. A session-start hook queries the graph
   * (`broker`) to COMPUTE inject context; it never mutates and never decides a tool call.
   */
  /**
   * Resolve the session's active agent-profile into its per-hook config map AND its `hooks` whitelist
   * (Phase 6 + 6b, decision 2609020302), from ONE profile read. The daemon holds the broker at
   * session-open, so it reads the profile from the graph. Both empty/absent when there is no profile /
   * no engine / no fields (a bare launch runs only the default + always-on hooks, unrestricted).
   * `whitelist` is `undefined` = no restriction; a set (possibly empty) = only critical hooks + those.
   * See `parseProfileHookConfig` / `parseProfileHookWhitelist` for the confirmed shapes.
   */
  async function profileHooksFor(
    profile: string | undefined,
  ): Promise<{ configs: Map<string, unknown[]>; whitelist: Set<string> | undefined; rows: ProfileRow[] }> {
    if (!profile || !broker.available()) return { configs: new Map(), whitelist: undefined, rows: [] }
    let frame
    try {
      frame = await broker.read('instances_of', { type: 'agent-profile' })
    } catch {
      return { configs: new Map(), whitelist: undefined, rows: [] } // engine hiccup -> unrestricted, never wedge session-open
    }
    if (frame.ready === false || frame.type === 'error') return { configs: new Map(), whitelist: undefined, rows: [] }
    const rows = Array.isArray(frame.result) ? (frame.result as ProfileRow[]) : []
    // resolveProfileHookConfig follows REF entries over the broker (Phase 6b action 3); a ref read
    // that throws must not wedge session-open, so fall back to the inline-only parse on any error.
    const configs = await resolveProfileHookConfig(rows, profile, (op, args) => broker.read(op, args)).catch(() =>
      parseProfileHookConfig(rows, profile),
    )
    return { configs, whitelist: parseProfileHookWhitelist(rows, profile), rows }
  }

  /**
   * The profile's `tools` visibility allowlist (agent-facing names), resolved from the graph on the
   * spot — for the ADVERTISE, which runs at the shim's MCP-server STARTUP, before session-open. At
   * that point there is no session state to gate from, so `list-capabilities` resolves the allowlist
   * directly from the `AU_MCP_PROFILE` locator the adapter forwards (plan 2609072337). Same reduction
   * that stashes `session.toolAllowlist` at open, so advertise and invoke agree. Tri-state: undefined
   * (no profile / no engine / absent field) -> unrestricted. Best-effort: an engine hiccup -> undefined.
   */
  async function profileToolAllowlist(profile: string | undefined): Promise<string[] | undefined> {
    if (!profile || !broker.available()) return undefined
    let frame
    try {
      frame = await broker.read('instances_of', { type: 'agent-profile' })
    } catch {
      return undefined // engine hiccup -> unrestricted, never wedge the advertise
    }
    if (frame.ready === false || frame.type === 'error') return undefined
    const rows = Array.isArray(frame.result) ? (frame.result as ProfileRow[]) : []
    const set = parseProfileNameAllowlist(rows, profile, 'tools')
    return set ? [...set] : undefined
  }

  function sessionStartContextFor(session: Session, scope: SessionScope): SessionStartContext {
    const record = (kind: string, data: unknown): void => {
      const stamped = sessions.append(session.id, { kind, run: 0, seq: 0, session: session.id, data })
      if (!stamped) return
      appendRecovery(opts.workspace, session.id, stamped)
      registry.observe(stamped, session.hookConfigs)
    }
    return {
      session: session.id,
      run: sessions.runOf(session.id),
      isResume: session.priorRun !== undefined,
      ...(session.priorRun !== undefined ? { priorRun: session.priorRun } : {}),
      launch: launchOf(session.info, session.nativeToolAllowlist),
      consultTrace: makeConsultTrace(session),
      // READ-ONLY engine access: a session-start hook COUNTS / INSPECTS the graph, never mutates.
      broker: scopedBroker(broker, 'read'),
      scope,
      emit: record,
    }
  }

  /**
   * The POST-tool review fan-out (B2-i). After an event is stamped, every globally-registered
   * mediator with a `review` method gets a turn to narrate a consequence; their `text` is joined
   * and returned to the adapter, which surfaces it on the tool's own result. Best-effort: a
   * throwing `review` is isolated so it can never take the observe (or the session) — the same
   * contract the observer fan-out holds. Only registered mediators review; the per-request floors
   * (redirect / read-guard / precondition) are decide-only and never implement it.
   */
  async function runReviews(session: Session, event: SessionEvent): Promise<string | undefined> {
    const reviewers = registry.mediators().filter((m) => typeof m.review === 'function')
    if (reviewers.length === 0) return undefined
    const ctx = mediationContextFor(session)
    const texts: string[] = []
    for (const m of reviewers) {
      try {
        const r = await m.review!(event, ctx)
        if (r && r.text) texts.push(r.text)
      } catch {
        // best-effort: a mediator's post-tool voice failing must not take the observe.
      }
    }
    return texts.length > 0 ? texts.join('\n') : undefined
  }

  /**
   * Report a session lifecycle FACT to the observers.
   *
   * The kernel states what happened and stops there. What a `session-close` or a `turn-end`
   * MEANS — regenerate an index, rotate a file, do nothing — belongs to whichever recorder is
   * installed, and a kernel that decided it would make that recorder unreplaceable.
   *
   * Always fans out (the former trace gate is retired — the recorder decides what to keep).
   */
  function announce(session: string, signal: SessionLifecycle): void {
    registry.lifecycle(signal, session, sessions.get(session)?.hookConfigs)
  }

  /**
   * Report a RUN-lifecycle fact (a run boundary or the terminal retirement) to the observers,
   * carrying the run identity. Same best-effort isolation as `announce`; always fans out (the
   * recorder decides what a retire means).
   */
  function announceRun(event: RunLifecycle): void {
    registry.runLifecycle(event, sessions.get(event.session)?.hookConfigs)
  }

  /**
   * Retire a session: emit the best-effort `session-retire` signal (so a recorder MAY GC its own
   * now-orphaned artifacts), then GC the kernel durable store. The whole kernel side of retirement:
   * the kernel touches no recorder's files, and a resume of a retired id later arrives `isResume=false`
   * (no record) so the recorder starts fresh. Called by the retention sweep or a host retire, NOT by
   * close. See [[spec - session retention - dormant sessions are surfaced, age-bounded, and retired
   * by a kernel-store GC the recorder follows]].
   */
  function retireSession(session: string): void {
    const rec = loadSessionRecord(opts.workspace, session)
    announceRun({ kind: 'session-retire', session, lastRun: rec?.run ?? 0 })
    retire(opts.workspace, session)
  }

  /**
   * The kernel side of the adapter's OBSERVABLE-replay seam. On a resumed run the adapter supplies the
   * prior run's observable conversation (from its own transcript) so `consultTrace` shows it; the
   * kernel injects those events READ-ONLY (never advancing the current run's seq, never through the
   * observe path — so the read-views stay empty).
   *
   * IDENTITY IS KERNEL-STAMPED: the adapter's transcript carries no `(run, seq)`, so a `ReplayEvent`
   * has only `{kind, data, at}`. The kernel stamps `run` = the session's PRIOR run (the replayed
   * conversation predates this open) and a fresh monotonic `seq`. Ordering in `consultTrace` is by
   * `at`, so `seq` is a tiebreaker only — the exact value is display bookkeeping, not durable identity
   * (the events never persist). This keeps the adapter from inventing identity it does not have.
   *
   * FORGERY REFUSAL: governance is daemon-sourced and un-forgeable, so a replay must carry OBSERVABLE
   * events only. The kernel refuses (drops) any event whose kind is not in the observable allowlist
   * `REPLAYABLE_KINDS` — fail-closed on anything else, including plugin-emitted governance
   * (`mcp.workflow.*`), `approval_*`, `tool_denied`, and au-provenance's `judgment`/`span_*`. Returns
   * a per-call tally.
   */
  function ingestReplay(session: string, events: ReplayEvent[]): { injected: number; refused: number } {
    // The replayed conversation belongs to the PRIOR run; a fresh/non-resumed session has no prior, so
    // fall back to the current run (a well-behaved adapter only replays on a resume). Absent session ->
    // runOf 0, and injectReplay lands nothing.
    const sess = sessions.get(session)
    const run = sess?.priorRun ?? sessions.runOf(session)
    const observable = events.filter((e) => REPLAYABLE_KINDS.has(e.kind))
    // Seed the seen-key set from the replayed conversation (decision 2609131240). Replay is inert —
    // these events are NOT deduped or recorded — but seeding their keys means the run's first live
    // re-lift of the same events (same `uuid` / `tool_use_id`) no-ops at observe, so a `--resume`
    // never double-records, and it needs no ledger read to know what was already lifted.
    if (sess) for (const e of observable) if (e.dedupeKey !== undefined) sess.seenKeys.add(e.dedupeKey)
    // `injected` reflects what actually LANDED — `injectReplay` returns 0 for an absent session, so
    // the tally never over-reports. `refused` counts only the governance drops (the forgery refusal).
    let seq = 0
    const injected = sessions.injectReplay(
      session,
      observable.map((e) => ({ kind: e.kind, run, seq: ++seq, session, data: e.data, ...(e.at ? { at: e.at } : {}) })),
    )
    return { injected, refused: events.length - observable.length }
  }

  async function handle(request: ClientRequest, _conn: WireConnection): Promise<DaemonResponse> {
    // Ensure loadable tools are discovered before any request acts on the registry
    // (list-capabilities / invoke). Cheap after the first success or when no engine.
    await ensureLoadableTools()
    // FAIL CLOSED: if a `critical` governance plugin failed to load, refuse EVERY request.
    // Discovery ran just above, so the very request that surfaced the failure is refused here
    // — no ungated window. `mediate` returns a DENY DECISION (not a transport error): the
    // adapter fails OPEN to `allow` on a mediate error, so a deny is the only safe refusal;
    // it is also the real chokepoint, since every tool call routes through mediate.
    if (poisoned) {
      const reason = `au-mcp governance unavailable: critical plugin failed to load (${poisoned}). Session refused.`
      if (request.kind === 'mediate') return { kind: 'decision', id: request.id, decision: { kind: 'deny', reason } }
      return { kind: 'error', id: request.id, message: reason }
    }
    switch (request.kind) {
      case 'session-open': {
        // Idempotent; the session persists across connections (CC hooks are
        // short-lived processes). Closed only by an explicit session-close, not
        // on this connection dropping. Governance is the opt-in native-tool redirect (AdapterInfo.nativeToolAllowlist),
        // read per-session at mediate time — no mode-set resolution here.
        const fresh = sessions.get(request.info.session) === undefined
        // RUN IDENTITY: a session is a durable series of runs. Only a dormant->active (fresh
        // in-memory) open advances the run; a reconnect (already live) is idempotent. A RESUME (a
        // clean close set the record dormant, or the adapter asserts `resume`) bumps the run; a
        // daemon-CRASH recovery (a record exists but was never cleanly closed) keeps the same run;
        // a never-seen session is run 1. The counter is persisted UNCONDITIONALLY here, BEFORE any
        // event is stamped, so even an unrestricted, tool-free run records its run (the resume marker).
        //
        // CONCURRENCY INVARIANT (do not add an `await` between this `fresh` check and `sessions.open`
        // below): the bump + persist + open run SYNCHRONOUSLY, so on the single-threaded event loop a
        // second concurrent open for the same id cannot interleave — it runs after, sees the session
        // live (`fresh` false), and does NOT re-bump. Likewise `retireSession` is synchronous, so
        // retire and run-start are mutually exclusive per id without an explicit lock. An `await` in
        // this window would reopen the TOCTOU that double-bumps a concurrent resume.
        let seededRun: number | undefined
        let resumed = false
        let priorRun: number | undefined
        let continuityLost = false
        if (fresh) {
          const rec = loadSessionRecord(opts.workspace, request.info.session)
          resumed = rec !== undefined && (rec.dormant || request.info.resume === true)
          const run = rec === undefined ? 1 : resumed ? rec.run + 1 : rec.run
          priorRun = resumed ? rec!.run : undefined
          // CONTINUITY LOST: the adapter asserts a resume but we hold NO durable record — the state a
          // continuity-needing capability relied on was cleaned up (retired) or wiped. Drives the
          // continuity-requirements response below (hide optional / block required). A normal resume
          // (record present) or a fresh open (no resume asserted) is NOT lost.
          continuityLost = request.info.resume === true && rec === undefined
          persistSessionRecord(opts.workspace, request.info.session, {
            id: request.info.session, run, dormant: false,
            // The producing adapter + its opaque relaunch ref, so `list-dormant` can hand a host the
            // recipe to resume via the right adapter. `harness` is always present; `resumeRef` is set
            // only by an adapter that supports resume. The latest launch's values win on a resume.
            harness: request.info.harness,
            ...(request.info.resumeRef !== undefined ? { resumeRef: request.info.resumeRef } : {}),
            ...(request.info.profile !== undefined ? { profile: request.info.profile } : {}),
          })
          seededRun = run
        }
        const session = sessions.open(request.info, seededRun)
        if (fresh) {
          session.continuityLost = continuityLost
          session.priorRun = priorRun
        }
        // Bind (or REBIND, the /clear case) the launch handle to this session, so a session-less
        // invoke carrying only the handle (the CC mcp-server shim) resolves here.
        if (request.info.handle) bindings.bind(request.info.handle, request.info.session)
        // Rehydrate the persisted governance (emitted) slice on a FRESH open (first-ever, a daemon
        // restart, or a --resume). On a RESUME (new run) it is injected READ-ONLY without advancing
        // seq, so the new run restarts at 1; on a daemon-CRASH recovery (same run) seq continues.
        if (fresh) {
          const recovered = loadRecovery(opts.workspace, session.id)
          if (recovered.length > 0) sessions.rehydrate(session.id, recovered, { continueSeq: !resumed })
          // A new run began (fresh open, not a reconnect): announce it, so a recorder can start a
          // ledger segment and a consumer knows whether to rehydrate its continuity state.
          announceRun({
            kind: 'run-start',
            session: session.id,
            run: seededRun ?? sessions.runOf(session.id),
            isResume: resumed,
            ...(priorRun !== undefined ? { priorRun } : {}),
          })
          // SESSION-START phase (decision 2609020302): run the session-start hooks ONCE, at the fresh
          // open, and STASH their computed inject on the session. The adapter fetches it via
          // `session-start-context`. Past the sessions.open concurrency window (only the fresh->open
          // bump must stay await-free), so awaiting the hooks here is safe. Best-effort: the registry
          // isolates a throwing hook, and with no session-start hooks the phase is a no-op (empty loop),
          // so the common case adds no session-open latency.
          const { configs, whitelist, rows: profileRows } = await profileHooksFor(session.info.profile)
          // Stash the typed config map for the per-call MEDIATOR path (a mediator reads its single
          // config at decide/review via ctx.hookConfig); the session-start phase consumes it below.
          session.hookConfigs = configs
          // ADVISORY profile checks (Phase 6b action 2): log cross-field warnings; never refuse.
          const criticalHookIds = new Set(
            registry.allManifests().filter((m) => m.kind === 'hook' && m.critical).map((m) => m.id),
          )
          for (const w of validateProfileHooks(whitelist, configs.keys(), criticalHookIds)) {
            process.stderr.write(`au-mcp: profile '${session.info.profile}': ${w}\n`)
          }
          // The kernel-resolved session scope (decision 2609071712): active vs mounted tools/skills,
          // members, profile. Resolved ONCE here and handed to every session-start hook via ctx.scope,
          // so no hook re-derives the allowlist. Best-effort: a down engine yields the registry-only set.
          const { scope, toolAllowlist } = await resolveSessionScope({
            broker,
            toolManifestIds: registry.allManifests().filter((m) => m.kind === 'tool').map((m) => m.id),
            profile: session.info.profile,
            profileRows,
          })
          // Stash the profile-derived visibility allowlist on the session (plan 2609072337): the
          // gate now reads THIS, not the retired per-request `allowed` env. Same value that fed
          // `scope.tools.active`, so advertise and gate cannot diverge.
          session.toolAllowlist = toolAllowlist
          // The NATIVE-tool allowlist, resolved daemon-side from the same profile rows (the native
          // twin of `toolAllowlist`), replacing the retired `AU_MCP_NATIVE_TOOLS` env. Feeds
          // `SessionLaunch.nativeToolAllowlist` (the redirect mediator) via `launchOf`.
          session.nativeToolAllowlist = parseProfileNativeToolAllowlist(profileRows, session.info.profile)
          session.sessionStartInject = await registry.sessionStart(sessionStartContextFor(session, scope), configs, whitelist)
        }
        return { kind: 'opened', id: request.id, contractVersion: MCP_CONTRACT_VERSION }
      }

      case 'session-close': {
        // Announced BEFORE closing, so a recorder still sees a live session and the events
        // it is about to act on are complete.
        announce(request.session, 'session-close')
        // This run's episode is paused (the session goes dormant, not retired). Announce it while
        // the session is still live, so its `run` + trace flag are known.
        announceRun({ kind: 'run-end', session: request.session, run: sessions.runOf(request.session) })
        // Reap the handle binding (guarded, so a /clear rebind to the new session survives).
        const closingHandle = sessions.get(request.session)?.info.handle
        if (closingHandle) bindings.unbind(closingHandle, request.session)
        sessions.close(request.session)
        // Reap any undrained freshness notices for this session (they drain on a tool result, so a
        // close before the next call would otherwise leak the Set for the daemon's lifetime).
        pendingNotices.delete(request.session)
        // A clean close leaves the session DORMANT, not gone. Its governance slice + run record are
        // KEPT (for resume rehydration) and only `retire` clears them; here we just flag dormancy and
        // preserve the run index as the resume marker, so a later open bumps the run (resume) rather
        // than reusing it. The orphan age-sweep bounds a session that never resumes.
        markSessionDormant(opts.workspace, request.session)
        return { kind: 'closed', id: request.id }
      }

      case 'turn-end': {
        // A harness lifecycle FACT. The adapter reports that its turn ended and knows nothing
        // about what that causes; nor, now, does the kernel — it forwards the fact and lets
        // whichever recorder is installed decide.
        announce(request.session, 'turn-end')
        return { kind: 'turn-ended', id: request.id }
      }

      case 'mediate': {
        const session = requireSession(request.session)
        // The mediate phase: mediators decide in priority order, first non-allow wins.
        // A mediator may emit() events (e.g. redirect's tool_denied), which the daemon
        // appends to the log + fans to observers — the kernel sequences decide -> record,
        // so deny and trace cannot desync. The context (the emit/approval/broker/accessOf
        // handles) is shared with the post-tool `review` turn via `mediationContextFor`.
        const ctx = mediationContextFor(session)
        // CONTINUITY Tier-2 (required capability lost): fail the session closed on WRITES. A
        // state-touching action (a mutator) is denied with the recovery notice; reads + non-write
        // escapes pass. The runtime sibling of the load-time `poisoned` refusal, scoped to this
        // session + to mutators.
        if (continuityWriteBlocked(session) && ctx.accessOf(request.action) === 'read-write') {
          return { kind: 'decision', id: request.id, decision: { kind: 'deny', reason: continuityBlockNotice(session) } }
        }
        // ALL mediators are now DISCOVERED plugins from au-mcp-core (plan 2608261532, Phase 5):
        // the redirect (mcp.nativeToolRedirect @100), read-before-write (mcp.read-guard @40), and
        // tool-precondition (mcp.tool-precondition @30). They ride `registry.mediators()`,
        // priority-sorted in `runMediators`, and read per-session state via `MediationContext`
        // (`nativeToolAllowlist`, `readHash`/`hasRead`). The kernel wires no floor literal.
        const decision = await runMediators(registry.mediators(), request.action, ctx)
        return { kind: 'decision', id: request.id, decision }
      }

      case 'observe': {
        const session = requireSession(request.session)
        // OBSERVE IDEMPOTENCY (decision 2609131240): an event carrying a `dedupeKey` already seen
        // this session is a silent no-op — not appended, not fanned, not reviewed. This is how a
        // producer that may RE-SUBMIT an event (the CC adapter's transcript re-lift each PostToolUse)
        // stays single-recorded without knowing anything about the ledger. Only LIFTED events carry a
        // key; live fire-once events (a hooked read/tool_call) leave it unset and are never deduped,
        // which is required — those carry the read/served-view enrichment below. The key is OPAQUE:
        // the kernel matches on it and never interprets it.
        //
        // RESERVE the key BEFORE the enrichment awaits below, so two concurrent same-key observes
        // cannot both pass the `has` check and double-record. Reserving eagerly is safe: a keyed
        // (lifted) event needs no enrichment, and if the append below no-ops (session closed during
        // an await) the session is being discarded anyway. Live events carry no key and are untouched.
        const dedupeKey = request.event.dedupeKey
        if (dedupeKey !== undefined) {
          if (session.seenKeys.has(dedupeKey)) return { kind: 'observed', id: request.id }
          session.seenKeys.add(dedupeKey)
        }
        // Enrich a gate read BEFORE the append, so the persisted event carries it:
        // record the read-view hash (read-before-write floor, P6-O6) AND stamp the
        // touched-file pin (`target`) from the read's commit. Best-effort; no engine ->
        // no entry -> the guard denies a later overwrite, and `target` stays unset.
        await enrichReadEvent(session, request.event, broker, opts.workspace)
        // Register any file this call SERVED (via the tool's serves-contract) into the
        // served-view, so calling a serving tool (au_guide) satisfies a read-precondition
        // (decision 2607030037). Session-bound + spoof-resistant: derived from the observed
        // tool name + input, never response text.
        await registerServedFiles(session, request.event, registry.serves(), (p) => currentContentHash(broker, p))
        // NOTE the kernel ENRICHES (above) and does not TRIM. What a recorder keeps — what it
        // elides because git holds it, what it caps — is that recorder's policy, applied to
        // its own copy. So the log below holds the whole event and a second recorder is
        // possible at all.
        // act -> observe: stamp into the live log (always — floors + mediator consults + the
        // read/served view need it), then fan out to observers. UNCONDITIONAL: capture is always-on
        // substrate (the live log); whether a mounted observer (au-provenance's recorder) PERSISTS is
        // its own concern, not a kernel env. The former `AU_MCP_TRACE` gate is retired (plan 2608221145
        // Phase 6 / the launch-surface decision).
        const stamped = sessions.append(request.session, request.event)
        if (stamped) registry.observe(stamped, session.hookConfigs)
        // POST-tool review (B2-i): give registered mediators a turn to narrate a consequence of
        // this event; their text rides back on the `observed` response for the adapter to surface
        // as PostToolUse `additionalContext`. Runs on the STAMPED event (real seq); trace-gating
        // does NOT apply — a review is governance-adjacent (a gate verdict), not an on-disk record.
        const reviewText = stamped ? await runReviews(session, stamped) : undefined
        // FRESHNESS: fold in any queued "this file changed under you — re-read it" notices for this
        // session, so the advice rides the same `additionalContext` channel as a mediator's voice.
        const freshNote = drainFreshnessNotice(request.session)
        const text = [reviewText, freshNote].filter(Boolean).join('\n\n') || undefined
        return { kind: 'observed', id: request.id, ...(text ? { text } : {}) }
      }

      case 'invoke': {
        // The call's own context (the session + its launch facts). Resolve rule: a bound handle maps
        // to its live session; a raw session id from a direct caller falls through; a session-less
        // invoke (a workspace-scoped callable) stays session-less. Resolved UP FRONT so the visibility
        // + CONTINUITY gates run before mount/validate — a hidden tool is denied for THAT reason, not
        // reported as "not mounted".
        const invSessionId =
          request.session !== undefined ? (bindings.resolve(request.session) ?? request.session) : undefined
        const invSession = invSessionId ? sessions.get(invSessionId) : undefined
        const invInfo = invSession?.info
        // The allowlist gates the CALL too, not just the advertise, so a tool a caller never
        // advertised cannot be reached by naming it. Sourced from the profile-derived SESSION
        // allowlist (plan 2609072337). A session-less invoke carries no allowlist -> unrestricted
        // (it is a workspace-scoped callable, outside a profiled agent session). The daemon checks
        // independently of any adapter's own guard, keeping it authoritative for every client.
        if (!isAllowed(invSession?.toolAllowlist, request.tool)) {
          return {
            kind: 'invoked',
            id: request.id,
            result: `tool not available in this session: ${toolName(request.tool)}`,
            isError: true,
          }
        }
        // CONTINUITY (2b): a resumed session that LOST its durable state cannot use a continuity-needing
        // tool (Tier 1, denied independently of the advertise so a named-directly call is still
        // refused), and cannot write at all when a REQUIRED capability is unavailable (Tier 2). Reads
        // pass. Legible reasons over an opaque failure.
        if (invSession) {
          if (continuityHiddenTools(invSession).has(request.tool)) {
            return {
              kind: 'invoked',
              id: request.id,
              result: `${toolName(request.tool)} needs session continuity, which was cleaned up for this resumed session — it is unavailable here. Start a new session.`,
              isError: true,
            }
          }
          if (continuityWriteBlocked(invSession) && registry.accessOf(request.tool) === 'read-write') {
            return { kind: 'invoked', id: request.id, result: continuityBlockNotice(invSession), isError: true }
          }
        }
        const plugin = registry.callable(request.tool)
        // A tool that passed the allowlist but is not a registered callable is REFERENCED but
        // not mounted: its owner package is not a member of this workspace, so discovery never
        // registered it. Return a uniform, legible tool result (isError) instead of a raw throw
        // that surfaces as an opaque wire `error` — the agent (and a human) can then act on
        // "mount the owner" rather than reverse-engineering a protocol failure. B1-A: the kernel
        // owns this legibility once, so no mediator hand-rolls a subtypes diff to detect it.
        if (!plugin?.invoke) {
          return {
            kind: 'invoked',
            id: request.id,
            result: `tool ${toolName(request.tool)} is referenced but not mounted in this workspace (its owner package is not a member here)`,
            isError: true,
          }
        }
        // Gate-side validation: refuse a malformed input against mcp.tool.<tool> before
        // acting. Scope to the tool's OWNER repo (its manifest `provenance`): every tool's def
        // lives in the package that shipped it (au-mcp owns none).
        const invalid = await checkToolInput(broker, request.tool, request.input, plugin.manifest.provenance)
        if (invalid) return { kind: 'invoked', id: request.id, result: invalid, isError: true }
        // STAMP ATTACH (the stamper shape): on a governed write, sanitize the input then run the
        // registered stampers, injecting their stamp un-forgeably (overwriting any agent-supplied
        // one), AFTER gate-side validation so the stamp is daemon-internal, not agent schema. The
        // strip is unconditional for a stampable write (a session-less one gets no stamp but is
        // still sanitized); a non-write / non-stampable tool is untouched (returns undefined).
        let effInput = request.input
        const injected = await stampInputForWrite(request.tool, request.input, registry.stampers(), {
          session: invSessionId,
          launch: invInfo ? launchOf(invInfo, invSession?.nativeToolAllowlist) : undefined,
          now: () => new Date().toISOString(),
          hookConfigs: invSession?.hookConfigs,
        })
        if (injected !== undefined) effInput = injected
        const result = await plugin.invoke(effInput, {
          session: invSessionId,
          launch: invInfo ? launchOf(invInfo, invSession?.nativeToolAllowlist) : undefined,
          // A read-only trace handle when the call carries a session, so a status/reporting
          // callable computes its own payload instead of leaning on a mediator inject.
          consultTrace: invSession ? makeConsultTrace(invSession) : undefined,
        })
        // WRITE-BUMP (session FRESHNESS): a governed write reports the post-write hash of the file it
        // touched, so this session's `readView` reflects what it just wrote — no re-read needed before
        // re-writing it, and the freshness hash-compare then skips this session as the writer (its
        // stored hash equals current). Applied session-bound HERE (where the session is known) and
        // never surfaced to the agent. A delete/rename voids the old path's entry.
        if (invSession && result.readViewUpdate) {
          const u = result.readViewUpdate
          if (u.set) invSession.readView.set(u.set.path, u.set.hash)
          if (u.remove) for (const p of u.remove) invSession.readView.delete(p)
        }
        return { kind: 'invoked', id: request.id, result: result.content, isError: result.isError }
      }

      case 'consult-trace': {
        const session = requireSession(request.session)
        return { kind: 'trace', id: request.id, slice: await makeConsultTrace(session)(request.query) }
      }

      case 'session-guards': {
        // Governance posture from the native-tool allowlist. `denyNative` -> a whitelist is set, so
        // unlisted native tools are forced through the gate (an input-layer hook can also block an
        // @-mention). The adapter injects the "use the gate" note when this is set. Present (`[]` or
        // `[names]`) -> restricted; absent -> all native tools available.
        const session = requireSession(request.session)
        return { kind: 'guards', id: request.id, denyNative: session.nativeToolAllowlist !== undefined }
      }

      case 'session-start-context': {
        // The COMPUTED session-start inject blocks (decision 2609020302), stashed at the fresh open by
        // the session-start phase. Lenient: an unknown / not-yet-opened session yields `[]` (no inject),
        // never an error — a missing session-start context must not wedge the adapter's SessionStart hook.
        const session = sessions.get(request.session)
        return { kind: 'session-start-context', id: request.id, inject: session?.sessionStartInject ?? [] }
      }

      case 'list-capabilities': {
        // The active profile's tool ALLOWLIST decides what this advertise carries, so two agent
        // sessions on one daemon see different tool sets (plan 2609072337). Covers core and loadable
        // tools alike. Absent profile field / no profile -> every tool; empty -> none; a subset -> those.
        // CONTINUITY Tier-1: on a continuity-lost session, hide the tools of any capability that
        // needs the durable state it lost (the call is also denied at invoke, so hiding is UX not the
        // gate). Resolve the session from the handle/id like invoke does; session-less -> no hiding.
        const lcId = request.session !== undefined ? (bindings.resolve(request.session) ?? request.session) : undefined
        const lcSession = lcId ? sessions.get(lcId) : undefined
        // Visibility source, in precedence: an OPEN session's resolved allowlist; else the profile
        // LOCATOR resolved on the spot (the advertise runs at startup, before session-open — plan
        // 2609072337 Adjustment); else unrestricted (no session, no profile -> a bare launch).
        const lcAllowed = lcSession
          ? lcSession.toolAllowlist
          : request.profile !== undefined
            ? await profileToolAllowlist(request.profile)
            : undefined
        const hidden = lcSession ? continuityHiddenTools(lcSession) : new Set<string>()
        const callables = registry
          .callableManifests()
          .filter((m) => isAllowed(lcAllowed, m.id))
          .filter((m) => !hidden.has(m.id))
        return {
          kind: 'capabilities',
          id: request.id,
          callables,
          redirects: [],
        }
      }

      case 'ping': {
        // Control: no session. Reports liveness + version + which workspace.
        return {
          kind: 'pong',
          id: request.id,
          contractVersion: MCP_CONTRACT_VERSION,
          workspace: opts.workspace,
        }
      }

      case 'shutdown': {
        // Tear down the held freshness subscription + its connection, then ack and stop on the next
        // tick so the ack frame flushes.
        freshness.stop()
        broker.close?.()
        if (opts.onShutdown) setImmediate(opts.onShutdown)
        return { kind: 'shutdown-ack', id: request.id }
      }

      case 'list-dormant': {
        // Control-plane (host): the DORMANT (cleanly-closed, resumable) sessions to show for
        // resume-or-clean-up. Session-less, read-only, not an agent tool.
        const sessions = listSessions(opts.workspace).filter((s) => s.dormant).map(toDormant)
        return { kind: 'dormant-sessions', id: request.id, sessions }
      }

      case 'retention-preview': {
        // Control-plane: the blast radius of a proposed retention window — which dormant sessions it
        // WOULD retire — shown before the policy change applies. Read-only, retires nothing.
        const now = Date.now()
        const sessions = listSessions(opts.workspace)
          .filter((s) => s.dormant && now - s.lastActiveMs > request.windowMs)
          .map(toDormant)
        return { kind: 'retention-preview', id: request.id, sessions }
      }

      case 'retire-session': {
        // Control-plane (host/app, user-directed): end a dormant session for good now. NOT an agent
        // tool — it reaches the daemon only over the control socket, never through the tool path.
        retireSession(request.session)
        return { kind: 'retired', id: request.id, session: request.session }
      }

      case 'retention-config': {
        // Control-plane: au-mcp's current retention window, read from its OWN scoped-config storage
        // (the caller names no storage). Falls to the 30d hard default when unset.
        const ms = (await readRetentionWindowMs(broker)) ?? RETENTION_DORMANT_MAX_AGE_MS
        return { kind: 'retention-config', id: request.id, windowMs: ms, windowDays: Math.round(ms / 86_400_000) }
      }

      case 'set-retention-window': {
        // Control-plane (host/app, user-directed): persist a new window (whole days) via au-mcp's own
        // scoped-config storage (governed, committed). NOT an agent tool.
        // Validate at the wire boundary — the type is `Number{>=1 & integer}` but the wire takes any
        // number; a bad value would write a `dormancy_days:` the reader's regex rejects, silently
        // degrading to the 30d default. Reject it loudly instead.
        const days = request.windowDays
        if (!Number.isInteger(days) || days < 1) {
          throw new Error(`set-retention-window: windowDays must be a positive integer, got ${days}`)
        }
        await writeRetentionWindow(broker, days) // throws on a rejected write
        // Report the APPLIED window (re-read), never the request — so a degraded write surfaces honestly.
        const ms = (await readRetentionWindowMs(broker)) ?? RETENTION_DORMANT_MAX_AGE_MS
        return { kind: 'retention-config', id: request.id, windowMs: ms, windowDays: Math.round(ms / 86_400_000) }
      }

      case 'session-rehydrate': {
        // The adapter replays a resumed session's OBSERVABLE conversation. Inert: injected read-only
        // for consultTrace, governance kinds refused, the read-views untouched. Arrives after
        // session-open (which rehydrated the governance slice), so it augments rather than races it.
        const { injected, refused } = ingestReplay(request.session, request.events)
        return { kind: 'rehydrated', id: request.id, injected, refused }
      }
    }
  }

  /** Throw a wire error (relayed by the server) when a request names an unknown session. */
  function requireSession(id: string) {
    const session = sessions.get(id)
    if (!session) throw new Error(`unknown session: ${id}`)
    return session
  }

  return {
    handle,
    workspace: opts.workspace,
    broker,
    registry,
    sessionCount: () => sessions.size,
    retireSession,
    ingestReplay,
  }
}

/** The read/served view slice the read-view accessors need (narrowed so they are unit-testable). */
export interface ReadViewSession {
  /** Absolute read path -> engine hash at read time (raw agent path key). */
  readView: Map<string, string>
  /** Canonical served path -> hash (a serves-contract call). */
  servedView: Map<string, string>
}

/**
 * A predicate: is `path` already in this session's read-view (real read_file_pinned) or served-view
 * (a serves-contract call)? Canonicalizes (realpath) both sides so an engine-resolved onFiles
 * path matches the agent's read path across symlinks. The served-view is stored canonical
 * already; a read-view key is the raw agent path, canonicalized here.
 */
function sessionHasRead(session: ReadViewSession): (path: string) => boolean {
  const canon = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const seen = new Set<string>()
  for (const key of session.readView.keys()) seen.add(canon(key))
  for (const key of session.servedView.keys()) seen.add(canon(key))
  return (path) => seen.has(canon(path))
}

/**
 * The plugin-facing read-view accessors placed on `MediationContext` (`hasRead` + `readHash`),
 * built for one session. Factored + exported so the exact wiring a mediator receives is unit-
 * testable, not just the underlying `sessionHasRead`.
 * - `hasRead`: the canonicalized union predicate (read-view ∪ served-view) — the tool-precondition
 *   floor's input.
 * - `readHash`: the exact-path read-time hash (read-view only, no realpath, no served-view) — the
 *   read-before-write staleness input; mirrors read-guard's own `readView.get(path)` lookup.
 */
export function readViewAccessors(session: ReadViewSession): {
  hasRead: (path: string) => boolean
  readHash: (path: string) => string | undefined
} {
  return {
    hasRead: sessionHasRead(session),
    readHash: (path) => session.readView.get(path),
  }
}

/** What `enrichReadEvent` needs off a session (narrowed so it is unit-testable). */
interface ReadEnrichSession {
  info: { gatePrefix?: string }
  readView: Map<string, string>
}

/**
 * On a read observe, arm the session read-view (P6-O6) so a later overwrite of that path can be
 * checked against what the session saw. TWO paths, by how the read arrived:
 *
 *   - PINNED (the gate `read_file_pinned`): route through the engine `content` read, which yields
 *     { hash, commit } in one coherent read. Record the hash AND stamp the touched-file pin
 *     `data.target` from `commit` — the provenance edge "this op read version <commit> of <path>".
 *     Pays the engine round-trip; keeps the traced read-edge.
 *   - FAST (a NATIVE read the adapter stamped `access: 'read'`, e.g. Claude Code's `Read`): compute
 *     the hash LOCALLY from the file bytes via the SDK `contentHash` (engine-identical, no engine
 *     round-trip). Arms the CAS hash ONLY — no commit fetched, so NO provenance pin. Keyed on
 *     `access`, the harness-agnostic signal the adapter stamps, never a harness tool name.
 *
 * Best-effort throughout: skips non-reads, missing paths, and any unreadable / unresolvable file
 * (the guard then denies the overwrite). The pin is the engine `file*@` form
 * `[[<repo-relative-path>::@<commit>]]` (this-repo scope); `commit` is HEAD of the owning repo,
 * null off-git (then `target` stays unset). A read pin is best-effort: the bytes are the working
 * tree's (possibly dirty), the pin anchors HEAD — a mutation pin is exact. The daemon stamps it
 * server-side here, with no agent-response round-trip.
 */
export async function enrichReadEvent(
  session: ReadEnrichSession,
  event: SessionEvent,
  broker: EngineBroker,
  workspace: string,
): Promise<void> {
  if (event.kind !== EventKind.ToolCall) return
  const data = event.data as { tool?: unknown; input?: unknown; target?: string; access?: string } | undefined
  if (!data) return
  const path = filePathOf(data.input)
  if (!path) return
  const prefix = session.info.gatePrefix

  // PINNED read: the gate `read_file_pinned` routes through the engine `content` read (hash + commit).
  if (prefix && data.tool === `${prefix}read_file_pinned`) {
    const meta = await currentContentMeta(broker, path)
    if (!meta) return
    session.readView.set(path, meta.hash) // keyed by the ABSOLUTE path (matches the write's file_path)
    const target = pinnedFileTarget({ path: relative(workspace, path), commit: meta.commit ?? undefined })
    if (target) {
      data.target = target
      // State the DIRECTION here, where it is known, so no consumer has to classify a tool
      // name to tell a read edge from a write edge (see ToolCallData.access).
      data.access = 'read'
    }
    return
  }

  // FAST read: a native read the adapter classified `access: 'read'`. Hash locally via the SDK
  // `contentHash` (engine-identical), no engine round-trip, no provenance pin. Same ABSOLUTE-path
  // key the write's `file_path` will present.
  if (data.access === 'read') {
    try {
      session.readView.set(path, contentHash(await readFile(path)))
    } catch {
      // best-effort: an unreadable / absent file arms nothing (the guard then denies the overwrite).
    }
  }
}
