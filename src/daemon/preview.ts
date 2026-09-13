// Pending-action -> engine mutation-preview mapping (the mediation-level preview seam).
//
// A pre-tool mediator that wants to gate a write on its PRODUCT ("allow iff this write would
// produce a valid mcp.plan") needs the pending action mapped to the engine's `preview_mutation`
// args. That adapter/gate-shaped -> engine-mutation translation is au-mcp's job, not the engine's
// and not a per-mediator one. This module owns it, reusing the gate write tools' input shapes
// (files.ts), so a mediator forwards NOTHING adapter-specific — it hands back the action it is
// deciding and au-mcp does the mapping (see `MediationContext.previewAction`).

import type { PreviewMutationOp, WirePreviewMutationResult } from '@arsumbris/au-engine-sdk'
import type { PendingAction, ActionPreview } from '@arsumbris/au-mcp-sdk'
import { optString, optBool } from '../plugins/result.ts'

/** Strip this session's gate prefix, then a leading `mcp.`, to the bare verb — as the floors do. */
function baseVerb(tool: string, gatePrefix?: string): string {
  const stripped = gatePrefix && tool.startsWith(gatePrefix) ? tool.slice(gatePrefix.length) : tool
  return stripped.startsWith('mcp.') ? stripped.slice('mcp.'.length) : stripped
}

/**
 * Map a pending tool call to a `PreviewMutationOp`, or `undefined` when it is not a previewable
 * mutation. Covers exactly engine v1 — `write_file` / `edit_file` / `delete_file` — over the GATE
 * write tools (input keyed as files.ts: `file_path` / `content` / `old_string` / `new_string`).
 *
 * NOT covered (return undefined): any other tool, and a NATIVE tool (e.g. CC's `Write`) whose
 * tool-name -> verb mapping is adapter-specific knowledge that must not live in the daemon. In a
 * gated session the gate's decide runs on the GATE-tool call anyway, so this is the path that matters.
 *
 * NO `expectedHash` (a concurrency guard is about the write moment, not the product). NO `stamps`:
 * at decide the stamper has not run, and agent-supplied stamps get overwritten at invoke — so
 * previewing them would preview a write that will not happen. Stamps rarely change a file's TYPE
 * (the gate's concern), so skipping them is safe for the gate use case.
 */
export function pendingActionToPreviewOp(action: PendingAction, gatePrefix?: string): PreviewMutationOp | undefined {
  const input = action.input
  const path = optString(input, 'file_path')
  if (!path) return undefined
  switch (baseVerb(action.tool, gatePrefix)) {
    case 'write_file': {
      const content = optString(input, 'content')
      if (content === undefined) return undefined
      return { op: 'write_file', path, content }
    }
    case 'edit_file': {
      const oldString = optString(input, 'old_string')
      const newString = optString(input, 'new_string')
      if (oldString === undefined || newString === undefined) return undefined
      return { op: 'edit_file', path, oldString, newString, replaceAll: optBool(input, 'replace_all') ?? false }
    }
    case 'delete_file':
      return { op: 'delete_file', path }
    default:
      return undefined
  }
}

/**
 * Flatten a `PreviewMutationOp` to the `broker.read('preview_mutation', args)` args (the au-mcp
 * house pattern — `broker.read` prepends `{ read: 'preview_mutation' }` and unwraps the schema-17
 * envelope, so `frame.result` is the `WirePreviewMutationResult`). Mirrors the SDK helper's
 * camelCase -> wire normalization (`oldString` -> `old_string`, `replaceAll` -> `replace_all`); no
 * stamps (see `pendingActionToPreviewOp`).
 */
export function previewOpToWireArgs(op: PreviewMutationOp): Record<string, unknown> {
  switch (op.op) {
    case 'write_file':
      return { op: 'write_file', path: op.path, content: op.content }
    case 'edit_file':
      return { op: 'edit_file', path: op.path, old_string: op.oldString, new_string: op.newString, replace_all: op.replaceAll ?? false }
    case 'delete_file':
      return { op: 'delete_file', path: op.path }
  }
}

/**
 * Project the engine's `preview_mutation` result onto the agent-facing `ActionPreview` au-mcp-sdk
 * owns — a compact view a mediator reads without an au-engine-sdk dependency. Discriminates the
 * engine's untagged union with `'reject' in result`.
 */
export function toActionPreview(result: WirePreviewMutationResult): ActionPreview {
  if ('reject' in result) {
    return { kind: 'reject', message: result.reject.message, detail: result.reject.detail }
  }
  const t = result.target
  return {
    kind: 'product',
    path: t.path,
    hash: t.hash,
    identities: t.identities.map((i) => ({ name: i.name, repo: i.repo })),
    diagnostics: t.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
    blastRadius: result.blast_radius.map((b) => ({
      path: b.path,
      diagnostics: b.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
    })),
  }
}
