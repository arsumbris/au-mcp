// The wire transport SERVER — the daemon's side of the SDK's DaemonTransport.
//
// Listens on a Unix socket, frames identically to the engine daemon, and for
// each client connection decodes `ClientRequest`s and writes back the
// `DaemonResponse` the handler produces. The handler (assembled by the daemon
// across actions 3.4-3.8) owns all routing; this layer is pure transport.

import { createServer, type Server, type Socket, connect } from 'node:net'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { encodeFrame, FrameDecoder, type ClientRequest, type DaemonResponse } from '@arsumbris/au-mcp-sdk'

/** A live client connection. The daemon may push frames; it learns of close. */
export interface WireConnection {
  /** Send one response frame to this client. */
  send(response: DaemonResponse): void
  /** Register a callback for when this connection drops (for session cleanup). */
  onClose(fn: () => void): void
}

/**
 * Produces the response for one request. Async-friendly; the server stamps the
 * originating id onto an error if the handler throws. A handler builds the full
 * `DaemonResponse` (id included) on success.
 */
export type RequestHandler = (
  request: ClientRequest,
  conn: WireConnection,
) => Promise<DaemonResponse> | DaemonResponse

export interface WireServer {
  readonly socketPath: string
  /** Stop accepting connections, drop open ones, and unlink the socket. */
  close(): Promise<void>
}

/**
 * Bind the socket and serve `handler`. Reclaims a stale socket left by an
 * ungraceful exit (try-connect; unlink if refused), but refuses to start if a
 * live daemon already owns it — mirroring the engine daemon.
 */
export async function listen(socketPath: string, handler: RequestHandler): Promise<WireServer> {
  await mkdir(dirname(socketPath), { recursive: true })
  await reclaimIfStale(socketPath)

  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    const decoder = new FrameDecoder()
    const closeFns: Array<() => void> = []
    const conn: WireConnection = {
      send: (response) => socket.write(encodeFrame(response)),
      onClose: (fn) => closeFns.push(fn),
    }

    socket.on('data', (chunk: Buffer) => {
      let requests: unknown[]
      try {
        requests = decoder.push(chunk)
      } catch {
        // FrameTooLargeError: the stream is desynced past recovery. Drop it.
        socket.destroy()
        return
      }
      for (const raw of requests) {
        const request = raw as ClientRequest
        void Promise.resolve()
          .then(() => handler(request, conn))
          .then((response) => socket.write(encodeFrame(response)))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            socket.write(encodeFrame({ kind: 'error', id: request.id, message }))
          })
      }
    })

    const onClose = () => {
      sockets.delete(socket)
      for (const fn of closeFns) fn()
    }
    socket.on('close', onClose)
    socket.on('error', () => socket.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => {})
    },
  }
}

/** Remove a socket file only if no live daemon answers on it. Throws if one does. */
async function reclaimIfStale(socketPath: string): Promise<void> {
  const alive = await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
  if (alive) throw new Error(`au-mcp daemon already running on ${socketPath}`)
  await unlink(socketPath).catch(() => {})
}
