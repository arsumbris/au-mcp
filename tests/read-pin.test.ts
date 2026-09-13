import { describe, it, expect } from 'vitest'
import { EventKind, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { enrichReadEvent } from '../src/daemon/daemon.ts'
import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'
import { contentHash } from '@arsumbris/au-engine-sdk'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'mcp__au__'
const WORKSPACE = '/repo'

/** A broker whose `content` read returns the given { hash, commit } (or is unavailable). */
function brokerReturning(content: { hash: string; commit: string | null } | null): EngineBroker {
  return {
    socketPath: '',
    available: () => content !== null,
    read: async (op): Promise<EngineFrame> =>
      op === 'content' && content ? { ready: true, result: content } : { type: 'error', message: 'no' },
    mutate: async () => ({ ready: false }),
  }
}

function session() {
  return { info: { gatePrefix: PREFIX }, readView: new Map<string, string>() }
}

function readEvent(filePath: string): SessionEvent {
  return {
    kind: EventKind.ToolCall,
    seq: 0,
    session: 's',
    data: { tool: `${PREFIX}read_file_pinned`, input: { file_path: filePath }, tool_use_id: 'tu1' },
  } as SessionEvent
}

const targetOf = (e: SessionEvent) => (e.data as { target?: string }).target

describe('enrichReadEvent', () => {
  it('stamps the touched-file pin and records the read-view hash for a gate read', async () => {
    const s = session()
    const ev = readEvent('/repo/notes/hello.md')
    await enrichReadEvent(s, ev, brokerReturning({ hash: 'h1', commit: 'c0ffee' }), WORKSPACE)
    // pin is the repo-relative path, this-repo `::@` scope, HEAD commit
    expect(targetOf(ev)).toBe('[[notes/hello.md::@c0ffee]]')
    // read-before-write floor still records the hash, keyed by the absolute path
    expect(s.readView.get('/repo/notes/hello.md')).toBe('h1')
  })

  it('records the hash but leaves target unset when the file is off-git (commit null)', async () => {
    const s = session()
    const ev = readEvent('/repo/notes/hello.md')
    await enrichReadEvent(s, ev, brokerReturning({ hash: 'h1', commit: null }), WORKSPACE)
    expect(targetOf(ev)).toBeUndefined() // no commit -> no pin (would fail value-not-pinned)
    expect(s.readView.get('/repo/notes/hello.md')).toBe('h1') // floor unaffected
  })

  it('ignores a non-read gate tool (no target, no read-view entry)', async () => {
    const s = session()
    const ev = readEvent('/repo/x.md')
    ;(ev.data as { tool: string }).tool = `${PREFIX}write_file`
    await enrichReadEvent(s, ev, brokerReturning({ hash: 'h1', commit: 'c0ffee' }), WORKSPACE)
    expect(targetOf(ev)).toBeUndefined()
    expect(s.readView.size).toBe(0)
  })

  it('no-ops when no engine is reachable', async () => {
    const s = session()
    const ev = readEvent('/repo/x.md')
    await enrichReadEvent(s, ev, brokerReturning(null), WORKSPACE)
    expect(targetOf(ev)).toBeUndefined()
    expect(s.readView.size).toBe(0)
  })

  it('no-ops on a non-tool-call event and when the session has no gate prefix', async () => {
    const broker = brokerReturning({ hash: 'h1', commit: 'c0ffee' })
    const other = { kind: EventKind.UserPrompt, seq: 0, session: 's', data: { prompt: 'hi' } } as SessionEvent
    await enrichReadEvent(session(), other, broker, WORKSPACE)
    expect(targetOf(other)).toBeUndefined()
    const noPrefix = { info: {}, readView: new Map<string, string>() }
    const ev = readEvent('/repo/x.md')
    await enrichReadEvent(noPrefix, ev, broker, WORKSPACE)
    expect(targetOf(ev)).toBeUndefined()
  })
})

/** A broker that MUST NOT be read on the fast path — throws if it is. */
const throwingBroker: EngineBroker = {
  socketPath: '',
  available: () => true,
  read: async () => {
    throw new Error('engine must not be read on the fast native-read path')
  },
  mutate: async () => ({ ready: false }),
}

/** A native read the adapter classified `access: 'read'` (tool name is NOT the gate read tool). */
function nativeReadEvent(filePath: string): SessionEvent {
  return {
    kind: EventKind.ToolCall,
    seq: 0,
    session: 's',
    data: { tool: 'Read', input: { file_path: filePath }, access: 'read', tool_use_id: 'tu2' },
  } as SessionEvent
}

describe('enrichReadEvent — fast native read', () => {
  it('arms the read-view from a LOCAL hash for a native read, no engine round-trip, no pin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'au-mcp-read-'))
    try {
      const file = join(dir, 'hello.md')
      const bytes = Buffer.from('# hello\nworld\n')
      writeFileSync(file, bytes)
      const s = session()
      const ev = nativeReadEvent(file)
      await enrichReadEvent(s, ev, throwingBroker, WORKSPACE) // throws if the fast path touches the engine
      expect(s.readView.get(file)).toBe(contentHash(bytes)) // engine-identical hash, computed locally
      expect(targetOf(ev)).toBeUndefined() // fast read carries no provenance pin
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('best-effort: an unreadable/absent native read arms nothing and does not throw', async () => {
    const s = session()
    const ev = nativeReadEvent('/no/such/dir/file.md')
    await enrichReadEvent(s, ev, throwingBroker, WORKSPACE)
    expect(s.readView.size).toBe(0)
  })

  it('ignores a native tool that is not a read (no access:read)', async () => {
    const s = session()
    const ev = {
      kind: EventKind.ToolCall,
      seq: 0,
      session: 's',
      data: { tool: 'Bash', input: { file_path: '/repo/x.md' } },
    } as SessionEvent
    await enrichReadEvent(s, ev, throwingBroker, WORKSPACE)
    expect(s.readView.size).toBe(0)
  })
})
