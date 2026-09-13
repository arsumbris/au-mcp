import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDaemonClient, connectSocket, socketPath, type SessionEvent, type Plugin } from '@arsumbris/au-mcp-sdk'
import { startDaemon } from '../src/serve.ts'

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-e2e-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

const ev = (kind: string): SessionEvent => ({ kind, run: 0, seq: 0, session: 's1', data: null })

describe('end-to-end over a real socket', () => {
  it('drives the daemon through the full client surface', async () => {
    const ws = await tempWorkspace()
    const probe: Plugin = {
      manifest: { id: 'mcp.probe', name: 'probe', kind: 'tool', contractVersion: 0 },
      invoke: async (input) => ({ content: `echo:${(input as { x?: string }).x}` }),
    }

    const running = await startDaemon({ workspace: ws, plugins: [probe] })
    const transport = await connectSocket(socketPath(ws))
    const client = createDaemonClient(transport)

    try {
      // handshake
      const opened = await client.sessionOpen({ harness: 'cc', session: 's1', workspace: ws, nativeTools: [] })
      expect(opened.contractVersion).toBe(0)

      // ping (control, no session)
      const pong = await client.ping()
      expect(pong.workspace).toBe(ws)

      // list-capabilities surfaces the composed callable (file ops are loadable now, not default)
      const caps = await client.listCapabilities('s1')
      expect(caps.callables.map((m) => m.id)).toContain('mcp.probe')

      // invoke a callable tool over the wire
      const invoked = await client.invoke('s1', 'mcp.probe', { x: 'hello world' })
      expect(invoked.isError).toBeFalsy()
      expect(String(invoked.result)).toContain('echo:hello world')

      // mediate allows by default (no mediator plugins in Phase 3)
      const decision = await client.mediate('s1', { tool: 'Bash', input: { command: 'ls' } })
      expect(decision.kind).toBe('allow')

      // observe events, then consult the live trace
      await client.observe('s1', ev('user_prompt'))
      await client.observe('s1', ev('tool_start'))
      const slice = await client.consultTrace('s1', {})
      expect(slice.events.map((e) => e.kind)).toEqual(['user_prompt', 'tool_start'])
      expect(slice.headSeq).toBe(2)

      // a filtered consult
      const turn = await client.consultTrace('s1', { kinds: ['tool_start'] })
      expect(turn.events.map((e) => e.seq)).toEqual([2])

      // the observe path PASSES DATA WHOLE — an arbitrary event-data field (here a subagent's
      // agent_id/agent_type, the per-call attribution the adapter forwards) survives unstripped,
      // so a consumer can partition the one ledger by agent. The kernel enriches, never trims.
      await client.observe('s1', {
        kind: 'tool_call',
        run: 0,
        seq: 0,
        session: 's1',
        data: { tool: 'Read', agent_id: 'a0cb05e8', agent_type: 'general-purpose' },
      })
      const withAgent = await client.consultTrace('s1', { kinds: ['tool_call'] })
      expect(withAgent.events.at(-1)!.data).toMatchObject({ agent_id: 'a0cb05e8', agent_type: 'general-purpose' })

      await client.sessionClose('s1')
    } finally {
      client.dispose()
      transport.close()
      await running.stop()
    }
  })

  it('an unknown tool surfaces as a legible not-mounted result to the client (B1-A)', async () => {
    const ws = await tempWorkspace()
    const running = await startDaemon({ workspace: ws })
    const transport = await connectSocket(socketPath(ws))
    const client = createDaemonClient(transport)
    try {
      await client.sessionOpen({ harness: 'cc', session: 's1', workspace: ws, nativeTools: [] })
      const res = await client.invoke('s1', 'mcp.nonesuch', {})
      expect(res.isError).toBe(true)
      expect(String(res.result)).toMatch(/referenced but not mounted/)
    } finally {
      client.dispose()
      transport.close()
      await running.stop()
    }
  })
})
