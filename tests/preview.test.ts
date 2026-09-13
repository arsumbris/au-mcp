import { describe, it, expect } from 'vitest'
import type { WirePreviewMutationResult } from '@arsumbris/au-engine-sdk'
import { pendingActionToPreviewOp, previewOpToWireArgs, toActionPreview } from '../src/daemon/preview.ts'

describe('pendingActionToPreviewOp', () => {
  it('maps the three gate write verbs to a PreviewMutationOp', () => {
    expect(pendingActionToPreviewOp({ tool: 'mcp.write_file', input: { file_path: '/w/a.md', content: 'x' } })).toEqual({
      op: 'write_file',
      path: '/w/a.md',
      content: 'x',
    })
    expect(
      pendingActionToPreviewOp({ tool: 'mcp.edit_file', input: { file_path: '/w/a.md', old_string: 'a', new_string: 'b', replace_all: true } }),
    ).toEqual({ op: 'edit_file', path: '/w/a.md', oldString: 'a', newString: 'b', replaceAll: true })
    expect(pendingActionToPreviewOp({ tool: 'mcp.delete_file', input: { file_path: '/w/a.md' } })).toEqual({
      op: 'delete_file',
      path: '/w/a.md',
    })
  })

  it('strips the session gate prefix then the mcp. prefix to the bare verb', () => {
    expect(pendingActionToPreviewOp({ tool: 'au__write_file', input: { file_path: '/w/a.md', content: 'x' } }, 'au__')).toMatchObject({
      op: 'write_file',
    })
    expect(pendingActionToPreviewOp({ tool: 'au__mcp.write_file', input: { file_path: '/w/a.md', content: 'x' } }, 'au__')).toMatchObject({
      op: 'write_file',
    })
  })

  it('returns undefined for a non-previewable action', () => {
    expect(pendingActionToPreviewOp({ tool: 'mcp.read_file_pinned', input: { file_path: '/w/a.md' } })).toBeUndefined() // not a mutation
    expect(pendingActionToPreviewOp({ tool: 'Write', input: { file_path: '/w/a.md', content: 'x' } })).toBeUndefined() // native, adapter-specific
    expect(pendingActionToPreviewOp({ tool: 'mcp.write_file', input: { content: 'x' } })).toBeUndefined() // no file_path
    expect(pendingActionToPreviewOp({ tool: 'mcp.write_file', input: { file_path: '/w/a.md' } })).toBeUndefined() // no content
    expect(pendingActionToPreviewOp({ tool: 'mcp.edit_file', input: { file_path: '/w/a.md', old_string: 'a' } })).toBeUndefined() // no new_string
  })
})

describe('previewOpToWireArgs', () => {
  it('normalizes camelCase op fields to the wire (snake) shape', () => {
    expect(previewOpToWireArgs({ op: 'edit_file', path: '/w/a.md', oldString: 'a', newString: 'b', replaceAll: true })).toEqual({
      op: 'edit_file',
      path: '/w/a.md',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    })
    expect(previewOpToWireArgs({ op: 'write_file', path: '/w/a.md', content: 'x' })).toEqual({ op: 'write_file', path: '/w/a.md', content: 'x' })
  })
})

describe('toActionPreview', () => {
  it('projects a built product to the agent-facing shape', () => {
    const wire: WirePreviewMutationResult = {
      target: {
        path: '/w/plan.md',
        hash: 'h1',
        identities: [{ name: 'plan', repo: 'proj', hash: 'abc' }],
        diagnostics: [{ code: 'x', severity: 'warning', span: {} as never, message: 'm' }],
      },
      blast_radius: [{ path: '/w/other.md', diagnostics: [{ code: 'y', severity: 'error', span: {} as never, message: 'boom' }] }],
    }
    expect(toActionPreview(wire)).toEqual({
      kind: 'product',
      path: '/w/plan.md',
      hash: 'h1',
      identities: [{ name: 'plan', repo: 'proj' }],
      diagnostics: [{ code: 'x', severity: 'warning', message: 'm' }],
      blastRadius: [{ path: '/w/other.md', diagnostics: [{ code: 'y', severity: 'error', message: 'boom' }] }],
    })
  })

  it('projects a structural reject as data (kind: reject)', () => {
    expect(toActionPreview({ reject: { message: 'no such file', detail: { path: '/w/x' } } })).toEqual({
      kind: 'reject',
      message: 'no such file',
      detail: { path: '/w/x' },
    })
  })
})
