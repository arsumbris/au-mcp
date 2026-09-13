import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, type RunningDaemon } from '../src/serve.ts'
import { status, stop } from '../src/cli.ts'

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-life-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('cli lifecycle', () => {
  it('status reports stopped when nothing is running', async () => {
    const ws = await tempWorkspace()
    expect(await status(ws)).toBe(false)
    expect(await stop(ws)).toBe(false)
  })

  it('status sees a running daemon, then stop shuts it down', async () => {
    const ws = await tempWorkspace()
    // onShutdown stops the server (the real CLI would process.exit; a test must not).
    const ctl: { running?: RunningDaemon } = {}
    ctl.running = await startDaemon({ workspace: ws, onShutdown: () => void ctl.running?.stop() })

    expect(await status(ws)).toBe(true)
    expect(await stop(ws)).toBe(true)

    // The daemon acks then stops on the next tick; give it a moment to unbind.
    await delay(50)
    expect(await status(ws)).toBe(false)
  })
})
