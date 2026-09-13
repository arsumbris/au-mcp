// The engine broker — the daemon's one connection to au-engine (P7).
//
// Backed by @arsumbris/au-engine-sdk's DaemonClient (the canonical engine client),
// used CONNECT-PER-CALL: each read/mutation opens a short-lived client, runs one
// op, and closes. Stateless, so it is transparently robust to the engine
// restarting (decision 2606241601). A held, auto-reconnecting connection
// (engine-sdk's manageConnection) is the later upgrade if read-churn or
// subscriptions ever warrant it; the broker has neither today.
//
// This retires the hand-rolled socket + framing: the SDK owns the wire (framing,
// id correlation, the schema_version handshake). The EngineBroker interface is
// UNCHANGED, so callers (the au_* reads, validate, read-guard, discovery, modes,
// the file mutations) are untouched — they still see read(op,args)->EngineFrame
// and mutate(verb,args)->EngineFrame. (A later increment, bundled with the
// type<T>* swap, moves discovery/modes onto engine-sdk's TYPED read-helpers and
// drops the local hand-mirrored wire types — see decision 2606241601, split Y.)
//
// Two behaviors are preserved across the swap:
// - a per-call TIMEOUT (DaemonClient.read has none): the op is raced against a timer.
// - the EngineFrame error contract: a read's WireError and a mutation's {ok:false}
//   map back to an `{ type: 'error', message }` frame (callers branch on
//   frame.type / frame.ready), rather than the SDK's typed rejections.

import { existsSync } from 'node:fs'

import { DaemonClient, manageConnection, persistentSubscription } from '@arsumbris/au-engine-sdk'
import type { TypedMutate, Stamp, AttributionEntry, ManagedConnection, ChangesHint } from '@arsumbris/au-engine-sdk'
import { WireError } from '@arsumbris/au-engine-sdk/wire'
import type { ChangeEventFrame } from '@arsumbris/au-engine-sdk/wire'
import type { Stamp as McpStamp, AttributionEntry as McpAttributionEntry } from '@arsumbris/au-mcp-sdk'

import { engineSocketPath } from '../paths.ts'

// PARITY GUARD (the mirror pin). mcp-sdk MIRRORS the engine `Stamp` rider without depending on
// engine-sdk (like the frame codec + FNV hash), so the two `Stamp` shapes could silently drift.
// au-mcp is the one layer that sees BOTH: a stamper produces the mcp-sdk Stamp, this broker folds
// it via the engine-sdk write method. Assert they stay MUTUALLY assignable, so any divergence fails
// the au-mcp typecheck here rather than passing a mis-shaped record to the engine.
type _Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _stampParity: _Mutual<McpStamp, Stamp> = true
void _stampParity
// Same mirror pin for the `attribution` rider (schema 26): mcp-sdk mirrors the engine
// `AttributionEntry` without depending on engine-sdk; assert they stay mutually assignable so a
// drift fails the au-mcp typecheck here rather than passing a mis-shaped trailer to the engine.
const _attributionParity: _Mutual<McpAttributionEntry, AttributionEntry> = true
void _attributionParity

/** A frame the engine daemon sends back. */
export interface EngineFrame {
  type?: string
  ready?: boolean
  result?: unknown
  [key: string]: unknown
}

/**
 * The schema-17 result envelope: every read's `result` carries its payload under
 * the read's OWN name, so `result[verb]` reaches it (the broker unwraps centrally
 * in `read`, mirroring the SDK's `issueRead`). These THREE reads carry
 * envelope-level metadata BESIDE the payload key, so their whole `result` object
 * is passed through unwrapped — else `count` / `aborted_at_load` / `base` vanish.
 * Mirror of the SDK's `unwrap: false` set (`read-helpers.ts` — `instances`,
 * `candidates`, `subtypes`); keep in lockstep with it.
 */
const ENVELOPE_METADATA_READS = new Set(['instances', 'candidates', 'subtypes'])

export interface EngineBroker {
  /** The engine socket this broker dials. */
  readonly socketPath: string
  /** Whether an engine appears reachable (socket present) for this workspace. */
  available(): boolean
  /** One read: connect a short-lived client, send `{ read, ...args }`, await the response frame, close. */
  read(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<EngineFrame>
  /**
   * One mutation through the engine's mutation channel: connect, dispatch the
   * verb to the SDK's typed method (`write_file`/`edit_file`/`delete_file`/
   * `assign_block_id`, plus the refactor sagas), await
   * the outcome, close. The gate's state-touching callables route here instead of
   * writing fs directly — the one governed write path
   * ([[decision - 2606222008 ...]]). `expected_hash` rides in `args` for CAS.
   */
  mutate(verb: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<EngineFrame>
  /**
   * Hold ONE auto-reconnecting `changes` subscription for the workspace (session FRESHNESS,
   * Mechanism 3). `onChange` fires per `knowledge-base-changed` with the file delta; `onReconnect`
   * fires when the channel comes back after a drop (the channel has NO initial value, so the gap is
   * unknown and a consumer re-validates in full). Returns a stop function. Optional: a broker with no
   * engine (or a test fake) may omit it, and freshness then simply does not subscribe.
   */
  subscribeChanges?(handlers: ChangesHandlers): () => void
  /** Tear down any held connection (the `changes` subscription). Idempotent. Optional. */
  close?(): void
}

/** The freshness consumer's view of the `changes` feed — the file delta, plus a reconnect signal. */
export interface ChangesHandlers {
  /** One `knowledge-base-changed`: the net file delta (paths absolute, per the engine feed). */
  onChange(delta: { added: string[]; removed: string[]; modified: string[] }): void
  /** The subscription re-established after a drop; the gap is unknown, so re-validate in full. */
  onReconnect(): void
}

/**
 * A read-only view of a broker: `read` and `available` pass through, `mutate` is denied.
 * The daemon hands this to a loadable tool granted `broker: read` (see the tool-access-meta
 * spec) — engine reads without the governed mutation channel.
 */
export function readOnlyBroker(inner: EngineBroker): EngineBroker {
  return {
    socketPath: inner.socketPath,
    available: () => inner.available(),
    read: (op, args, timeoutMs) => inner.read(op, args, timeoutMs),
    mutate: async () => ({ type: 'error', message: 'broker: read-only grant (mutate denied by tool-access-meta)' }),
  }
}

/** The engine-broker access a tool may hold: none / read-only / read-write. */
export type BrokerLevel = 'none' | 'read' | 'read-write'

/**
 * Scope the kernel broker to a granted level, for a tool's PluginContext.
 * `read-write` -> the full broker; `read` -> a read-only broker (mutate denied); `none` -> no
 * broker at all. The base primitive both the fixed (discovery) and per-session (session-broker)
 * scoping build on. Lives here (beside `EngineBroker`/`readOnlyBroker`) so the grant/scoping
 * modules can share it without importing `discovery` — which would cycle.
 */
export function scopedBroker(broker: EngineBroker, level: BrokerLevel): EngineBroker | undefined {
  if (level === 'read-write') return broker
  if (level === 'read') return readOnlyBroker(broker)
  return undefined
}

/**
 * A broker dialing the au-engine daemon for `entry` — the workspace ENTRY the
 * engine was started with (a folder-repo DIRECTORY carrying `.arsumbris/repo.yaml`,
 * schema 16). `engineSocketPath` (engine-sdk's `socketPath`) hashes it to
 * the same out-of-repo socket the daemon binds, and `DaemonClient.connect` takes
 * the identical entry — so `available()` and the connection agree by construction.
 */
export function createEngineBroker(entry: string): EngineBroker {
  const socketPath = engineSocketPath(entry)

  // Connect-per-call: open a client, run one op raced against a timeout, close.
  const exchange = async <T>(run: (client: DaemonClient) => Promise<T>, label: string, timeoutMs: number): Promise<T> => {
    const client = await DaemonClient.connect(entry)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        run(client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`engine ${label} timed out`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      client.close()
    }
  }

  // The held connection for the ONE `changes` subscription (freshness). Lazily created on the first
  // `subscribeChanges` and owned here so `close()` can tear it down. Distinct from the connect-per-call
  // path above, which stays stateless.
  let changesConn: ManagedConnection<DaemonClient> | undefined
  let stopChanges: (() => void) | undefined

  return {
    socketPath,
    available: () => existsSync(socketPath),
    subscribeChanges: (handlers: ChangesHandlers): (() => void) => {
      // One managed connection, one persistent subscription. `persistentSubscription` reconnects
      // internally on a transient drop and re-acks; the FIRST ack is the initial subscribe, every
      // LATER ack is a reconnect (the gap missed events, so the consumer re-validates in full).
      changesConn ??= manageConnection(() => DaemonClient.connect(entry))
      const conn = changesConn
      let acked = false
      stopChanges = persistentSubscription(
        () => conn.acquire(),
        { subscribe: 'changes' },
        {
          onAck: () => {
            if (acked) handlers.onReconnect()
            acked = true
          },
          onChangeEvent: (frame: ChangeEventFrame) => {
            const hint = frame.scope_hint as ChangesHint | undefined
            if (!hint) return
            handlers.onChange({
              added: hint.added ?? [],
              removed: hint.removed ?? [],
              modified: hint.modified ?? [],
            })
          },
        },
      )
      return () => {
        stopChanges?.()
        stopChanges = undefined
      }
    },
    close: () => {
      stopChanges?.()
      stopChanges = undefined
      changesConn?.close()
      changesConn = undefined
    },
    read: (op, args = {}, timeoutMs = 4000) =>
      exchange((client) => client.read({ read: op, ...args }), `read '${op}'`, timeoutMs).then(
        (raw) => {
          const frame = raw as unknown as EngineFrame
          // Central schema-17 unwrap (the migration's lever): the ready frame's
          // `result` is the envelope `{ <op>: payload, ...siblings }`. Reach the
          // payload uniformly as `result[op]` so every downstream consumer sees
          // the payload at `frame.result` — as it did pre-envelope. The three
          // metadata reads keep their whole envelope (sibling keys beside the
          // payload). A `ready:false` (deriving) or error frame has no `result`
          // to unwrap, so the guard skips it.
          if (frame.ready !== false && frame.result != null && !ENVELOPE_METADATA_READS.has(op)) {
            frame.result = (frame.result as Record<string, unknown>)[op]
          }
          return frame
        },
        (err) => {
          // A wire error frame -> the EngineFrame error contract callers branch on.
          if (err instanceof WireError) return { type: 'error', message: err.message }
          throw err // transport failure or timeout
        },
      ),
    mutate: (verb, args = {}, timeoutMs = 4000) =>
      exchange((client) => runMutation(client, verb, args), `mutate '${verb}'`, timeoutMs).then(mutateToFrame),
  }
}

/**
 * Dispatch a mutation verb to the DaemonClient's typed method. The wire is
 * IDENTICAL to the old generic `{ mutate: verb, ...args }` (the SDK's methods
 * send the same envelope), so the governed write path + CAS guard are unchanged.
 */
function runMutation(client: DaemonClient, verb: string, args: Record<string, unknown>): Promise<TypedMutate> {
  const path = String(args.path ?? '')
  const expectedHash = typeof args.expected_hash === 'string' ? args.expected_hash : undefined
  // The daemon-injected stamps LIST (the stamper shape), when this write carries any. The mcp-sdk
  // Stamps a stamper produced ride here as engine-sdk Stamps (the mirror-pin above proves the element
  // shapes match); all fold into the write's ONE commit (engine schema 24's `stamps` rider).
  const stamps = (args.stamps ?? undefined) as Stamp[] | undefined
  // The daemon-injected `ensure_mixins` rider (engine schema 25), the type-claim sibling of `stamps`.
  // Carried on the same three verbs the SDK accepts it on (write_file / edit_file / rename); mapped
  // to the engine-sdk camelCase options. The optional strict flag is omitted unless explicit, so the
  // engine default (strict) stands.
  const ensureMixins = Array.isArray(args.ensure_mixins) && args.ensure_mixins.length > 0
    ? (args.ensure_mixins as string[])
    : undefined
  const mixinOpts =
    ensureMixins !== undefined
      ? {
          ensureMixins,
          ...(typeof args.ensure_mixins_strict === 'boolean' ? { ensureMixinsStrict: args.ensure_mixins_strict } : {}),
        }
      : {}
  // The daemon-injected `attribution` rider (engine schema 26), the commit-trailer sibling of `stamps`.
  // Carried on write_file / edit_file / delete_file (the verbs the engine attribution rider accepts);
  // mapped to the engine-sdk camelCase option. Absent/empty -> no option (the engine writes no trailer).
  const attribution =
    Array.isArray(args.attribution) && args.attribution.length > 0 ? (args.attribution as AttributionEntry[]) : undefined
  switch (verb) {
    case 'write_file':
      return client.writeFile(path, String(args.content ?? ''), {
        ...(expectedHash !== undefined ? { expectedHash } : {}),
        ...(stamps ? { stamps } : {}),
        ...mixinOpts,
        ...(attribution ? { attribution } : {}),
      })
    case 'edit_file':
      return client.editFile(path, String(args.old_string ?? ''), String(args.new_string ?? ''), {
        replaceAll: args.replace_all === true,
        ...(stamps ? { stamps } : {}),
        ...mixinOpts,
        ...(attribution ? { attribution } : {}),
      })
    case 'delete_file':
      // BREAKING SDK absorb: deleteFile(path, expectedHash?) -> deleteFile(path, DeleteFileOptions?).
      // `delete_file` takes no stamps / ensure_mixins, only the guard + attribution.
      return client.deleteFile(path, {
        ...(expectedHash !== undefined ? { expectedHash } : {}),
        ...(attribution ? { attribution } : {}),
      })
    case 'assign_block_id':
      return client.assignBlockId(path, Number(args.at))
    case 'rename':
      return client.rename(path, String(args.to ?? ''), { ...(stamps ? { stamps } : {}), ...mixinOpts })
    case 'rename_type':
      return client.renameType(String(args.old_name ?? ''), String(args.new_name ?? ''))
    case 'promote': {
      // Exactly one locator: `block_id` (a record with an id) or `at` (a byte offset). The
      // engine enforces the exactly-one rule; we forward whichever the tool supplied.
      const locator = typeof args.block_id === 'string' ? { blockId: args.block_id } : { at: Number(args.at) }
      return client.promote(path, String(args.to ?? ''), locator)
    }
    case 'inline':
      return client.inline(path, String(args.into ?? ''), args.at !== undefined ? Number(args.at) : undefined)
    case 'rename_block_id':
      return client.renameBlockId(path, String(args.block_id ?? ''), String(args.to_block_id ?? ''))
    case 'set_config':
      // A CONSUMER's own scoped-config file (au-mcp's retention window, ...). The write dual of the
      // engine `config` read; out-of-band (floored), repo scope commits per mutation. We forward the
      // whole-file `content` shape (the retention writer's); the keyed `edit` body is unused here.
      return client.setConfig(
        {
          scope: args.scope as 'machine' | 'repo',
          consumer: String(args.consumer ?? ''),
          file: String(args.file ?? ''),
          type: String(args.type ?? ''),
          ...(args.root !== undefined ? { root: String(args.root) } : {}),
        },
        { content: String(args.content ?? '') },
        expectedHash !== undefined ? { expectedHash } : undefined,
      )
    default:
      return Promise.reject(new Error(`unknown mutation verb '${verb}'`))
  }
}

/** Map a TypedMutate back to the EngineFrame contract `mutationResult()` branches on. */
function mutateToFrame(outcome: TypedMutate): EngineFrame {
  if ('ok' in outcome) return { type: 'error', message: outcome.error }
  if (!outcome.ready) return { ready: false }
  return { ready: true, result: outcome.result }
}
