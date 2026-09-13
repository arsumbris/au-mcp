import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterInfo, Plugin } from '@arsumbris/au-mcp-sdk'
import { createDaemon } from '../src/daemon/daemon.ts'
import type { WireConnection } from '../src/wire/server.ts'

const fakeConn = (): WireConnection => ({ send: () => {}, onClose: () => {} })

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-plug-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

describe('daemon surfaces + invokes a composed callable', () => {
  // File ops + engine reads + the host-relay intent surface are now LOADABLE (from au-mcp-core),
  // no longer first-party literals, so this exercises the daemon's list-capabilities + invoke
  // plumbing with an EXPLICIT probe tool — decoupled from which specific tools ship by default.
  it('lists a passed-in tool and invokes it', async () => {
    const ws = await tempWorkspace()
    const probe: Plugin = {
      manifest: { id: 'mcp.probe', name: 'probe', kind: 'tool', contractVersion: 0 },
      invoke: async (input) => ({ content: `echo:${(input as { x?: string }).x}` }),
    }
    const daemon = createDaemon({ workspace: ws, plugins: [probe] })
    const info: AdapterInfo = { harness: 'cc', session: 's1', workspace: ws, nativeTools: [] }
    await daemon.handle({ kind: 'session-open', id: 1, info }, fakeConn())

    const caps = await daemon.handle({ kind: 'list-capabilities', id: 2, session: 's1' }, fakeConn())
    const ids = (caps as { callables: { id: string }[] }).callables.map((m) => m.id)
    expect(ids).toContain('mcp.probe')

    const res = await daemon.handle(
      { kind: 'invoke', id: 3, session: 's1', tool: 'mcp.probe', input: { x: 'hi' } },
      fakeConn(),
    )
    expect(res).toMatchObject({ kind: 'invoked' })
    expect(String((res as { result: unknown }).result)).toContain('echo:hi')
  })
})
