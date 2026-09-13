#!/usr/bin/env node
// au-mcp CLI — start / stop / status the daemon for a workspace.
//
// Lifecycle consistent with the engine daemon: `start` serves the socket (and
// reclaims a stale one, in the wire server), `stop` asks it to shut down over
// the socket, `status` pings for liveness + version. The workspace defaults to
// the current directory.

import { resolve } from 'node:path'
import { createDaemonClient, connectSocket, socketPath } from '@arsumbris/au-mcp-sdk'
import { startDaemon, type RunningDaemon } from './serve.ts'

/** Serve the daemon until stopped by signal or a `shutdown` request. */
export async function start(workspace: string): Promise<RunningDaemon> {
  const ctl: { running?: RunningDaemon } = {}
  const stopExit = () => {
    void ctl.running?.stop().then(() => process.exit(0))
  }
  ctl.running = await startDaemon({ workspace, onShutdown: stopExit })
  process.on('SIGINT', stopExit)
  process.on('SIGTERM', stopExit)
  process.stderr.write(`au-mcp daemon listening on ${ctl.running.server.socketPath}\n`)
  return ctl.running
}

/** Ask a running daemon to stop. Reports if none is running. */
export async function stop(workspace: string): Promise<boolean> {
  const transport = await connectSocket(socketPath(workspace)).catch(() => null)
  if (!transport) {
    process.stderr.write('au-mcp: not running\n')
    return false
  }
  const client = createDaemonClient(transport)
  try {
    await client.shutdown()
    process.stderr.write('au-mcp: stopped\n')
    return true
  } finally {
    client.dispose()
    transport.close()
  }
}

/** Report whether a daemon is up, and its contract version + workspace. */
export async function status(workspace: string): Promise<boolean> {
  const transport = await connectSocket(socketPath(workspace)).catch(() => null)
  if (!transport) {
    process.stdout.write('stopped\n')
    return false
  }
  const client = createDaemonClient(transport)
  try {
    const { contractVersion, workspace: ws } = await client.ping()
    process.stdout.write(`running (contract v${contractVersion}, workspace ${ws})\n`)
    return true
  } finally {
    client.dispose()
    transport.close()
  }
}

export async function run(argv: string[]): Promise<void> {
  const [command, wsArg] = argv
  const workspace = resolve(wsArg ?? process.cwd())
  switch (command) {
    case 'start':
      await start(workspace)
      return
    case 'stop':
      await stop(workspace)
      return
    case 'status':
      await status(workspace)
      return
    default:
      process.stderr.write('usage: au-mcp <start|stop|status> [workspace]\n')
      process.exitCode = 1
  }
}

// Run when invoked as the bin (not when imported by tests).
if (process.argv[1]?.endsWith('cli.ts')) {
  void run(process.argv.slice(2))
}
