import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventKind, type SessionEvent } from '@arsumbris/au-mcp-sdk'
import { resolveServedPath, registerServedFiles, type ServesContract } from '../src/daemon/served-files.ts'

let pkg: string
let guide: string
const contract = (): ServesContract => ({ pathTemplate: 'guides/{scenario}.md', packageRoot: pkg })

beforeAll(() => {
  pkg = realpathSync(mkdtempSync(join(tmpdir(), 'au-served-')))
  mkdirSync(join(pkg, 'guides'), { recursive: true })
  guide = join(pkg, 'guides', 'schema-induction.md')
  writeFileSync(guide, '---\nscenario: schema-induction\n---\nbody\n')
})
afterAll(() => rmSync(pkg, { recursive: true, force: true }))

describe('resolveServedPath', () => {
  it('substitutes {scenario} and resolves to the served guide (canonical)', () => {
    expect(resolveServedPath(contract(), { scenario: 'schema-induction' })).toBe(realpathSync(guide))
  })

  it('serves nothing when the templated field is absent (au_guide task-map call)', () => {
    expect(resolveServedPath(contract(), {})).toBeNull()
    expect(resolveServedPath(contract(), { other: 'x' })).toBeNull()
  })

  it('serves nothing for a nonexistent target', () => {
    expect(resolveServedPath(contract(), { scenario: 'does-not-exist' })).toBeNull()
  })

  it('rejects path-traversal in a substituted segment', () => {
    expect(resolveServedPath(contract(), { scenario: '../../etc/passwd' })).toBeNull()
    expect(resolveServedPath(contract(), { scenario: '..' })).toBeNull()
    expect(resolveServedPath(contract(), { scenario: 'a/b' })).toBeNull()
    expect(resolveServedPath(contract(), { scenario: 'a\\b' })).toBeNull()
  })

  it('rejects a non-string / empty field value', () => {
    expect(resolveServedPath(contract(), { scenario: '' })).toBeNull()
    expect(resolveServedPath(contract(), { scenario: 42 })).toBeNull()
  })
})

const ev = (data: unknown, kind: string = EventKind.ToolCall): SessionEvent => ({ kind, run: 0, seq: 0, session: 's', data })

describe('registerServedFiles', () => {
  const serves = () => new Map<string, ServesContract>([['au_guide', contract()]])
  const session = () => ({ info: { gatePrefix: 'mcp__au__' }, servedView: new Map<string, string>() })
  const hashOf = async () => 'H0'

  it('registers the served guide + its serve-time hash for a gate au_guide call', async () => {
    const s = session()
    await registerServedFiles(s, ev({ tool: 'mcp__au__au_guide', input: { scenario: 'schema-induction' } }), serves(), hashOf)
    expect([...s.servedView.keys()]).toEqual([realpathSync(guide)])
    expect(s.servedView.get(realpathSync(guide))).toBe('H0')
  })

  it('stores an empty hash when the serve-time hash cannot be resolved', async () => {
    const s = session()
    await registerServedFiles(s, ev({ tool: 'mcp__au__au_guide', input: { scenario: 'schema-induction' } }), serves(), async () => null)
    expect(s.servedView.get(realpathSync(guide))).toBe('')
  })

  it('registers nothing for a task-map call (no scenario)', async () => {
    const s = session()
    await registerServedFiles(s, ev({ tool: 'mcp__au__au_guide', input: {} }), serves(), hashOf)
    expect(s.servedView.size).toBe(0)
  })

  it('ignores a tool with no serves-contract', async () => {
    const s = session()
    await registerServedFiles(s, ev({ tool: 'mcp__au__read_file_pinned', input: { file_path: guide } }), serves(), hashOf)
    expect(s.servedView.size).toBe(0)
  })

  it('ignores non-gate tools and non-ToolCall events', async () => {
    const s = session()
    await registerServedFiles(s, ev({ tool: 'au_guide', input: { scenario: 'schema-induction' } }), serves(), hashOf)
    await registerServedFiles(s, ev({ tool: 'mcp__au__au_guide', input: { scenario: 'schema-induction' } }, EventKind.ToolStart), serves(), hashOf)
    expect(s.servedView.size).toBe(0)
  })

  it('no-ops on an empty serves map', async () => {
    const s = session()
    await registerServedFiles(s, ev({ tool: 'mcp__au__au_guide', input: { scenario: 'schema-induction' } }), new Map(), hashOf)
    expect(s.servedView.size).toBe(0)
  })
})
