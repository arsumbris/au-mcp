import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WIRE_SCHEMA_VERSION } from '@arsumbris/au-engine-sdk/wire'
import { createEngineBroker } from '../src/daemon/broker.ts'
import { engineSocketPath } from '../src/paths.ts'

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-broker-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

/**
 * A minimal fake au-engine speaking the DaemonClient wire: reads one
 * `{read,...,id}` frame, replies with a `response` frame that echoes the
 * request `id` and carries the current `schema_version` (the client correlates
 * by id and validates the version), wrapping `reply`'s body as `result`.
 */
function fakeEngine(path: string, reply: (read: string, args: unknown) => object): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const len = buffer.readUInt32BE(0)
      if (buffer.length < 4 + len) return
      const req = JSON.parse(buffer.subarray(4, 4 + len).toString()) as {
        read: string
        id?: number
        [k: string]: unknown
      }
      const frame = {
        type: 'response',
        ready: true,
        version: 1,
        schema_version: WIRE_SCHEMA_VERSION,
        id: req.id,
        result: reply(req.read, req),
      }
      const body = Buffer.from(JSON.stringify(frame))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length)
      socket.write(Buffer.concat([header, body]))
    })
  })
  return new Promise((resolve) => server.listen(path, () => resolve(server)))
}

let engine: Server | undefined
afterEach(() => {
  engine?.close()
  engine = undefined
})

describe('engine broker', () => {
  it('reports unavailable when no engine socket exists', async () => {
    const ws = await tempWorkspace()
    const broker = createEngineBroker(ws)
    expect(broker.available()).toBe(false)
  })

  it('unwraps result[verb] for a normal read (the schema-17 envelope)', async () => {
    const ws = await tempWorkspace()
    // The real daemon envelopes every read's payload under the read's own name.
    engine = await fakeEngine(engineSocketPath(ws), (read) => ({ [read]: { echoed: read } }))
    const broker = createEngineBroker(ws)
    expect(broker.available()).toBe(true)

    const frame = await broker.read('instance', { path: 'x' })
    expect(frame.ready).toBe(true)
    // `frame.result` is the PAYLOAD, not the envelope — the central unwrap ran.
    expect(frame.result).toEqual({ echoed: 'instance' })
  })

  it('passes the whole envelope through for a metadata read (subtypes keeps base)', async () => {
    const ws = await tempWorkspace()
    engine = await fakeEngine(engineSocketPath(ws), () => ({ base: 'mcp.tool', subtypes: ['a', 'b'] }))
    const broker = createEngineBroker(ws)

    const frame = await broker.read('subtypes', { base: 'mcp.tool' })
    // NOT unwrapped: `base` sits beside the payload and must survive.
    expect(frame.result).toEqual({ base: 'mcp.tool', subtypes: ['a', 'b'] })
  })

  it('preserves count / aborted_at_load for the instances metadata read', async () => {
    const ws = await tempWorkspace()
    engine = await fakeEngine(engineSocketPath(ws), () => ({ count: 3, aborted_at_load: false, instances: [1, 2, 3] }))
    const broker = createEngineBroker(ws)

    const frame = await broker.read('instances', {})
    // The known trap: a normal unwrap here would drop `count` — assert it survives.
    expect(frame.result).toEqual({ count: 3, aborted_at_load: false, instances: [1, 2, 3] })
  })

  it('rejects on timeout when the engine never answers', async () => {
    const ws = await tempWorkspace()
    // A server that accepts but never replies.
    engine = await new Promise<Server>((resolve) => {
      const s = createServer(() => {})
      s.listen(engineSocketPath(ws), () => resolve(s))
    })
    const broker = createEngineBroker(ws)
    await expect(broker.read('au_types', {}, 80)).rejects.toThrow(/timed out/)
  })
})
