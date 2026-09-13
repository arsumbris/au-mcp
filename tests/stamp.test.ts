import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Plugin, Stamp, WriteContext } from '@arsumbris/au-mcp-sdk'
import { stampInputForWrite } from '../src/daemon/stamp.ts'

const launch = {} // SessionLaunch: only optional fields now (config retired)
const call = { session: 's1', launch, now: () => '2026-08-06T00:00:00.000Z' }

// A stamper that records the ctx it saw and returns one stamp per non-declined write.
function recordingStamper(decline?: (c: WriteContext) => boolean): { plugin: Plugin; seen: WriteContext[] } {
  const seen: WriteContext[] = []
  const plugin: Plugin = {
    manifest: { id: 'mcp.test-stamper', name: 'Test Stamper', contractVersion: 0, kind: 'hook', shapes: ['stamper'] },
    stamp(c) {
      seen.push(c)
      if (decline?.(c)) return []
      return [{ field: 'spine', record: { type: `fc.${c.kind}`, session: c.session, ...(c.from ? { from: c.from } : {}), ...(c.at ? { at: c.at } : {}) }, matchOn: { type: `fc.${c.kind}` } }]
    },
  }
  return { plugin, seen }
}

describe('stampInputForWrite (the kernel-side stamp attach)', () => {
  it('write_file to an ABSENT path -> kind create, stamp injected, original input preserved', async () => {
    const { plugin, seen } = recordingStamper()
    const absent = path.join(os.tmpdir(), `stamp-absent-${process.pid}-${Math.floor(1e6)}.md`)
    const out = (await stampInputForWrite('mcp.write_file', { file_path: absent, content: 'x' }, [plugin], call)) as Record<string, unknown>
    expect(seen[0].kind).toBe('create')
    expect(out.stamps).toEqual([{ field: 'spine', record: { type: 'fc.create', session: 's1' }, matchOn: { type: 'fc.create' } }])
    expect(out.file_path).toBe(absent)
    expect(out.content).toBe('x')
  })

  it('write_file to an EXISTING path -> kind edit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'))
    const file = path.join(dir, 'note.md')
    fs.writeFileSync(file, 'hi\n')
    try {
      const { plugin, seen } = recordingStamper()
      const out = (await stampInputForWrite('mcp.write_file', { file_path: file, content: 'x' }, [plugin], call)) as Record<string, unknown>
      expect(seen[0].kind).toBe('edit')
      expect((out.stamps as Stamp[])[0].record).toMatchObject({ type: 'fc.edit' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('edit_file passes the edit KIND and produces the edit stamp', async () => {
    const { plugin, seen } = recordingStamper()
    const out = (await stampInputForWrite('mcp.edit_file', { file_path: '/x.md', old_string: 'a', new_string: 'b' }, [plugin], call)) as Record<string, unknown>
    expect(seen[0].kind).toBe('edit')
    expect((out.stamps as Stamp[])[0].record).toMatchObject({ type: 'fc.edit', session: 's1' })
  })

  it('rename -> kind rename, from + at carried, primary path is the NEW name', async () => {
    const { plugin, seen } = recordingStamper()
    const out = (await stampInputForWrite('mcp.rename', { file_path: '/old.md', to: '/new.md' }, [plugin], call)) as Record<string, unknown>
    expect(seen[0]).toMatchObject({ kind: 'rename', path: '/new.md', from: '/old.md', at: '2026-08-06T00:00:00.000Z' })
    expect((out.stamps as Stamp[])[0].record).toMatchObject({ type: 'fc.rename', from: '/old.md', at: '2026-08-06T00:00:00.000Z' })
  })

  it('a non-stampable verb passes through untouched (returns undefined)', async () => {
    const { plugin } = recordingStamper()
    expect(await stampInputForWrite('mcp.assign_block_id', { file_path: '/x.md', at: 0 }, [plugin], call)).toBeUndefined()
    expect(await stampInputForWrite('mcp.promote', { file_path: '/h.md', to: '/e.md', block_id: 'r1' }, [plugin], call)).toBeUndefined()
    expect(await stampInputForWrite('mcp.read_file_pinned', { file_path: '/x.md' }, [plugin], call)).toBeUndefined()
  })

  it('un-forgeable: an agent-supplied stamp is OVERWRITTEN by the stamper', async () => {
    const { plugin } = recordingStamper()
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', stamps: [{ field: 'forged', record: { evil: true } }] },
      [plugin],
      call,
    )) as Record<string, unknown>
    expect((out.stamps as Stamp[])[0].field).toBe('spine') // the stamper's, never the agent's
  })

  it('un-forgeable: a DECLINING stamper strips any agent-supplied stamp (never forwarded)', async () => {
    const { plugin } = recordingStamper(() => true)
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', stamps: [{ field: 'forged', record: {} }] },
      [plugin],
      call,
    )) as Record<string, unknown>
    expect('stamps' in out).toBe(false)
  })

  it('no stampers: a stampable write still strips any agent-supplied stamp', async () => {
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', stamps: [{ field: 'forged', record: {} }] },
      [],
      call,
    )) as Record<string, unknown>
    expect('stamps' in out).toBe(false)
  })

  it('session-LESS write: runs no stampers but still strips a forged stamp (unconditional sanitize)', async () => {
    const { plugin, seen } = recordingStamper()
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', stamps: [{ field: 'forged', record: {} }] },
      [plugin],
      { now: () => 'now' }, // no session / launch
    )) as Record<string, unknown>
    expect(seen).toHaveLength(0) // stamper never ran (no session to key the record)
    expect('stamps' in out).toBe(false) // forged stamp stripped anyway
  })

  it('coexistence: every stamper folds into the list, in registration order', async () => {
    const a: Plugin = { manifest: { id: 'mcp.a', name: 'A', contractVersion: 0, kind: 'hook', shapes: ['stamper'] }, stamp: (c) => [{ field: 'a', record: { s: c.session } }] }
    const b: Plugin = { manifest: { id: 'mcp.b', name: 'B', contractVersion: 0, kind: 'hook', shapes: ['stamper'] }, stamp: () => [{ field: 'b', record: {} }, { field: 'b2', record: {} }] }
    const out = (await stampInputForWrite('mcp.edit_file', { file_path: '/x.md', old_string: 'a', new_string: 'b' }, [a, b], call)) as Record<string, unknown>
    // two stampers, three stamps total, order-stable — the coexistence the list rider buys.
    expect((out.stamps as Stamp[]).map((s) => s.field)).toEqual(['a', 'b', 'b2'])
  })
})

// A stamper whose return TYPES the file: a StampResult carrying ensure_mixins beside its stamps.
function typingStamper(mixins: string[], strict?: boolean): Plugin {
  return {
    manifest: { id: 'mcp.typing-stamper', name: 'Typing Stamper', contractVersion: 0, kind: 'hook', shapes: ['stamper'] },
    stamp: (c) => ({
      stamps: [{ field: 'provenance', record: { type: `fc.${c.kind}`, session: c.session } }],
      ensureMixins: mixins,
      ...(strict === undefined ? {} : { ensureMixinsStrict: strict }),
    }),
  }
}

describe('stampInputForWrite — the ensure_mixins rider (schema 25)', () => {
  it('a StampResult forwards ensure_mixins beside the stamps, strict key omitted by default', async () => {
    const out = (await stampInputForWrite('mcp.write_file', { file_path: '/absent.md', content: 'x' }, [typingStamper(['provenance::au-provenance'])], call)) as Record<string, unknown>
    expect(out.ensure_mixins).toEqual(['provenance::au-provenance'])
    expect('ensure_mixins_strict' in out).toBe(false) // unset -> engine default (strict) stands
    expect((out.stamps as Stamp[])[0].field).toBe('provenance') // the stamps still ride
  })

  it('explicit LENIENT strict is forwarded', async () => {
    const out = (await stampInputForWrite('mcp.edit_file', { file_path: '/x.md', old_string: 'a', new_string: 'b' }, [typingStamper(['m::r'], false)], call)) as Record<string, unknown>
    expect(out.ensure_mixins_strict).toBe(false)
  })

  it('a bare Stamp[] return carries NO ensure_mixins (back-compat)', async () => {
    const { plugin } = recordingStamper()
    const out = (await stampInputForWrite('mcp.edit_file', { file_path: '/x.md', old_string: 'a', new_string: 'b' }, [plugin], call)) as Record<string, unknown>
    expect('ensure_mixins' in out).toBe(false)
  })

  it('un-forgeable: an agent-supplied ensure_mixins is stripped when no stamper types the file', async () => {
    const { plugin } = recordingStamper()
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', ensure_mixins: ['evil::forged'], ensure_mixins_strict: false },
      [plugin],
      call,
    )) as Record<string, unknown>
    expect('ensure_mixins' in out).toBe(false)
    expect('ensure_mixins_strict' in out).toBe(false)
  })

  it('un-forgeable: a stamper OVERWRITES an agent-supplied ensure_mixins', async () => {
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', ensure_mixins: ['evil::forged'] },
      [typingStamper(['provenance::au-provenance'])],
      call,
    )) as Record<string, unknown>
    expect(out.ensure_mixins).toEqual(['provenance::au-provenance']) // the stamper's, never the agent's
  })

  it('the mixin union dedupes across stampers; strict is lenient only if every explicit vote is false', async () => {
    // one stamper strict-unset, one explicit-false, overlapping mixin -> union deduped, strict stays (unset vote)
    const out = (await stampInputForWrite('mcp.edit_file', { file_path: '/x.md', old_string: 'a', new_string: 'b' }, [typingStamper(['m::r']), typingStamper(['m::r', 'n::r'], false)], call)) as Record<string, unknown>
    expect(out.ensure_mixins).toEqual(['m::r', 'n::r'])
    expect('ensure_mixins_strict' in out).toBe(false) // an unset vote keeps the write strict (errs safe)
  })
})

// A stamper contributing commit-level attribution (the session / span rider), beside (or instead of)
// its stamps. On a delete it returns stamps-free attribution; on a content write both ride.
function attributingStamper(entries: { key: string; value: string }[], withStamp = true): Plugin {
  return {
    manifest: { id: 'mcp.attributing-stamper', name: 'Attributing Stamper', contractVersion: 0, kind: 'hook', shapes: ['stamper'] },
    stamp: (c) => ({
      stamps: withStamp && c.kind !== 'delete' ? [{ field: 'spine', record: { type: `fc.${c.kind}`, session: c.session } }] : [],
      attribution: entries,
    }),
  }
}

describe('stampInputForWrite — the attribution rider (schema 26)', () => {
  const attr = [{ key: 'Traced-Session', value: 's1' }, { key: 'Traced-Span', value: 'span-7' }]

  it('a content write folds attribution BESIDE the stamps', async () => {
    const out = (await stampInputForWrite('mcp.edit_file', { file_path: '/x.md', old_string: 'a', new_string: 'b' }, [attributingStamper(attr)], call)) as Record<string, unknown>
    expect(out.attribution).toEqual(attr)
    expect((out.stamps as Stamp[])[0].field).toBe('spine') // stamps still ride
  })

  it('delete_file is attribution-ONLY: attribution rides, any stamp / mixin is dropped', async () => {
    // A stamper that (wrongly) returns a stamp + mixin on a delete — the kernel must suppress both.
    const rogue: Plugin = {
      manifest: { id: 'mcp.rogue', name: 'Rogue', contractVersion: 0, kind: 'hook', shapes: ['stamper'] },
      stamp: (c) => ({ stamps: [{ field: 'spine', record: { session: c.session } }], ensureMixins: ['x::r'], attribution: attr }),
    }
    const out = (await stampInputForWrite('mcp.delete_file', { file_path: '/x.md' }, [rogue], call)) as Record<string, unknown>
    expect(out.attribution).toEqual(attr) // the ONE rider a delete carries
    expect('stamps' in out).toBe(false) // suppressed (engine delete_file takes none)
    expect('ensure_mixins' in out).toBe(false) // suppressed
    expect(out.file_path).toBe('/x.md') // input otherwise preserved
  })

  it('un-forgeable: an agent-supplied attribution is OVERWRITTEN by the stamper', async () => {
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', attribution: [{ key: 'Forged', value: 'evil' }] },
      [attributingStamper(attr)],
      call,
    )) as Record<string, unknown>
    expect(out.attribution).toEqual(attr) // the stamper's, never the agent's
  })

  it('un-forgeable: a forged attribution is STRIPPED when no stamper attributes the write', async () => {
    const { plugin } = recordingStamper() // returns bare Stamp[], no attribution
    const out = (await stampInputForWrite(
      'mcp.edit_file',
      { file_path: '/x.md', old_string: 'a', new_string: 'b', attribution: [{ key: 'Forged', value: 'evil' }] },
      [plugin],
      call,
    )) as Record<string, unknown>
    expect('attribution' in out).toBe(false)
  })

  it('a bare Stamp[] return carries NO attribution (back-compat)', async () => {
    const { plugin } = recordingStamper()
    const out = (await stampInputForWrite('mcp.edit_file', { file_path: '/x.md', old_string: 'a', new_string: 'b' }, [plugin], call)) as Record<string, unknown>
    expect('attribution' in out).toBe(false)
  })
})
