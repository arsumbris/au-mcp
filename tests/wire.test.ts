import { describe, it, expect } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFrame, FrameDecoder, socketPath, type ClientRequest, type DaemonResponse } from '@arsumbris/au-mcp-sdk'
import { listen } from '../src/wire/server.ts'

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-test-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

/** Send one request over a fresh socket and resolve the first response frame. */
function roundTrip(path: string, request: ClientRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(path)
    const decoder = new FrameDecoder()
    socket.on('connect', () => socket.write(encodeFrame(request)))
    socket.on('data', (chunk: Buffer) => {
      const frames = decoder.push(chunk)
      if (frames.length > 0) {
        socket.destroy()
        resolve(frames[0] as DaemonResponse)
      }
    })
    socket.on('error', reject)
  })
}

describe('wire server', () => {
  it('frames a request in and the handler response out', async () => {
    const ws = await tempWorkspace()
    const server = await listen(socketPath(ws), (req) => {
      // Echo the request kind + id back as a capabilities response.
      expect(req.kind).toBe('list-capabilities')
      return { kind: 'capabilities', id: req.id, callables: [], redirects: [] }
    })
    try {
      const res = await roundTrip(server.socketPath, {
        kind: 'list-capabilities',
        id: 7,
        session: 's1',
      })
      expect(res).toEqual({ kind: 'capabilities', id: 7, callables: [], redirects: [] })
    } finally {
      await server.close()
    }
  })

  it('reports a handler throw as an error response carrying the request id', async () => {
    const ws = await tempWorkspace()
    const server = await listen(socketPath(ws), () => {
      throw new Error('boom')
    })
    try {
      const res = await roundTrip(server.socketPath, {
        kind: 'list-capabilities',
        id: 42,
        session: 's1',
      })
      expect(res).toEqual({ kind: 'error', id: 42, message: 'boom' })
    } finally {
      await server.close()
    }
  })

  it('reclaims a stale socket file left by an ungraceful exit', async () => {
    const ws = await tempWorkspace()
    const path = socketPath(ws)
    // A leftover regular file at the socket path (no live daemon behind it).
    await writeFile(path, 'stale')
    const server = await listen(path, (req) => ({
      kind: 'capabilities',
      id: req.id,
      callables: [],
      redirects: [],
    }))
    try {
      const res = await roundTrip(path, { kind: 'list-capabilities', id: 1, session: 's' })
      expect(res.kind).toBe('capabilities')
    } finally {
      await server.close()
    }
  })

  it('refuses to start when a live daemon already owns the socket', async () => {
    const ws = await tempWorkspace()
    const path = socketPath(ws)
    const first = await listen(path, (req) => ({
      kind: 'capabilities',
      id: req.id,
      callables: [],
      redirects: [],
    }))
    try {
      await expect(listen(path, (req) => ({ kind: 'closed', id: req.id }))).rejects.toThrow(
        /already running/,
      )
    } finally {
      await first.close()
    }
    expect(existsSync(path)).toBe(false)
  })
})
