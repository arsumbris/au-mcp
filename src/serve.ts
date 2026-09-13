// Bind a daemon to its workspace socket.
//
// Creates the kernel daemon and serves it over the Unix socket at
// `~/.arsumbris/au-mcp/run/<hash>.sock` (device-global, keyed by a hash of the
// workspace path — the SUN_LEN fix; see au-mcp-sdk `socketPath`). The CLI lifecycle
// (start/stop/status) wraps this; tests and host-managed startup call it directly.

import { socketPath } from '@arsumbris/au-mcp-sdk'
import { createDaemon, type Daemon, type DaemonOptions } from './daemon/daemon.ts'
import { createEngineBroker } from './daemon/broker.ts'
import { readRetentionWindowMs, RETENTION_DORMANT_MAX_AGE_MS } from './daemon/crash-recovery.ts'
import { registerLoadableTools } from './daemon/discovery.ts'
import { listen, type WireServer } from './wire/server.ts'

export interface RunningDaemon {
  readonly daemon: Daemon
  readonly server: WireServer
  /** Stop serving and unlink the socket. */
  stop(): Promise<void>
}

/** Create the daemon and start serving it on the workspace socket. */
export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  // Resolve au-mcp's retention window from its scoped-config storage HERE (the async boundary that
  // already awaits `registerLoadableTools`), so `createDaemon` stays sync and takes a plain number.
  // A test/programmatic `retentionWindowMs` override still wins; absent config -> the 30d default.
  const broker = opts.broker ?? createEngineBroker(opts.workspace)
  const retentionWindowMs = opts.retentionWindowMs ?? (await readRetentionWindowMs(broker)) ?? RETENTION_DORMANT_MAX_AGE_MS
  const daemon = createDaemon({ ...opts, broker, retentionWindowMs })
  // Enrich the core literal floor with any loadable tools the served workspace mounts
  // (decision 2606231421). Best-effort: no engine -> no loadable tools, core still runs.
  await registerLoadableTools(daemon)
  const server = await listen(socketPath(opts.workspace), (request, conn) =>
    daemon.handle(request, conn),
  )
  return { daemon, server, stop: () => server.close() }
}
