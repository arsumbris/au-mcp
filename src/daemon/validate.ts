// Daemon-side tool-input validation at the gate.
//
// Before the daemon ACTS on an `invoke`, it validates the input against the tool's
// `mcp.tool.<tool>` subtype (fields = call input) via the engine's `validate_value`
// read (brokered). au-mcp owns those defs, so resolution is repo-scoped to `au-mcp`.
// (Retargeted from `toolInput.<tool>` by the decision-2606191044 reshape.) A blocking
// diagnostic refuses the invoke; the agent gets a typed error instead of a malformed action.
//
// Replaces the adapter's old client-side always-valid validator (deleted
// au-mcp-adapter-cc/src/validate.ts): validation belongs at the gate, beside mediation,
// where the broker + tool registry already live. The MCP shim just forwards `invoke`.
//
// FAIL-CLOSED (schema 17): with no engine reachable the broker can't validate, so we
// proceed (a transport gap, not a type gap). But when the def does NOT resolve — the
// verdict comes back `identity: null` (the mcp.tool.<tool> def is not in the graph
// because au-mcp is not a mounted member) — we REFUSE. That is not an isolated gap: if
// au-mcp is unmounted the whole type graph is unreliable (subtype inference, the
// inheritance closure, what a def extends — none resolve cleanly), so proceeding would
// act on a workspace that is broken in ways we cannot see. Any workspace that speaks to
// this daemon must mount au-mcp as a dependency anyway, so fail-closed costs nothing when
// configured correctly and surfaces the misconfiguration everywhere else.

import type { EngineBroker } from './broker.ts'

/** A diagnostic from the engine's validate_value read. */
interface ValidateDiagnostic {
  code?: string
  severity?: string
  message?: string
}

/**
 * One verdict from the schema-17 multi-fit `validate_value` read: the identity the
 * value was checked against (`null` = the type name did not resolve), plus that fit's
 * diagnostics.
 */
interface ValidateVerdict {
  identity: { name?: string; repo?: string; hash?: string } | null
  diagnostics?: ValidateDiagnostic[]
}

/** The repo owning the CORE mcp.tool.<tool> defs (this daemon's own package). */
export const CORE_TOOL_REPO = 'au-mcp'

/**
 * Codes that are SYNTHESIS ARTIFACTS, not bad input — non-blocking ONLY on a verdict
 * whose identity RESOLVED (the tool def was found). The engine validates by synthesizing
 * a doc with a `type:` claim; a tool arg that itself carries a `type` key (e.g.
 * `au_instances_of {type: "plan"}`) both collides with that synthetic key
 * (`duplicate-key-in-mapping`) and gets read as a type claim for its own value
 * (`unknown-type-claim` for `plan`). Both are legitimate data, so neither blocks.
 * NOTE: an `unknown-type-claim` on a NULL-identity verdict is a different beast — the
 * tool def itself is missing — and is handled by the fail-closed check, not this set.
 */
const NON_BLOCKING = new Set(['unknown-type-claim', 'duplicate-key-in-mapping'])

/**
 * Validate a tool's input against `mcp.tool.<tool>`. Returns a human-readable
 * refusal message when the input is genuinely invalid, or null to proceed
 * (conforms, or validation could not run).
 *
 * `ownerRepo` is the tool's manifest `provenance` — the repo whose type graph holds its
 * def. A discovered plugin carries its OWNING repo; au-mcp itself owns no agent-facing defs
 * (Phase 6), so `'core'` now attaches only to a caller-supplied literal (a test / embedder
 * plugin, stamped at registration). Scoping to the WRONG repo makes the def unresolvable,
 * which under fail-closed refuses a perfectly good tool — the bug (todo 2606231443) that
 * best-effort used to hide.
 *
 * EDGE (unexercised today): a `'core'`-stamped CALLABLE literal resolves its def in au-mcp
 * (`CORE_TOOL_REPO`), which now holds none — so under a live engine it would fail closed. No
 * such literal exists (injected test plugins are hooks, which never reach `checkToolInput`);
 * revisit here if a core-provenance callable literal ever returns.
 */
export async function checkToolInput(
  broker: EngineBroker,
  toolId: string,
  input: unknown,
  ownerRepo?: string,
): Promise<string | null> {
  if (!broker.available()) return null // no engine -> can't validate -> proceed
  const toolName = toolId.startsWith('mcp.') ? toolId.slice('mcp.'.length) : toolId
  const typeName = `mcp.tool.${toolName}`
  // A 'core'/unset provenance resolves in au-mcp (CORE_TOOL_REPO); a contributed tool resolves in its owner.
  const defRepo = ownerRepo && ownerRepo !== 'core' ? ownerRepo : CORE_TOOL_REPO
  let verdicts: ValidateVerdict[]
  try {
    const frame = await broker.read('validate_value', {
      type_name: typeName,
      value: input ?? {},
      repo: defRepo,
    })
    if (frame.ready === false || frame.type === 'error') return null // engine busy/erroring -> proceed
    verdicts = Array.isArray(frame.result) ? (frame.result as ValidateVerdict[]) : []
  } catch {
    return null // broker timeout / unreachable -> proceed
  }
  // FAIL-CLOSED: a null-identity verdict means `mcp.tool.<tool>` did not resolve in its
  // owner repo (`defRepo`) — that package is not a mounted member, so the type graph is
  // unreliable. Refuse rather than proceed.
  const unresolved = verdicts.filter((v) => v.identity === null)
  if (unresolved.length > 0) {
    const diags = unresolved.flatMap((v) => v.diagnostics ?? [])
    const lines = diags.length
      ? diags.map((d) => `  - ${d.code ?? 'unresolved'}: ${d.message ?? ''}`)
      : [`  - ${typeName} did not resolve (is ${defRepo} mounted as a dependency?)`]
    // Same uniform "referenced but not mounted" phrasing the invoke path uses for an unregistered
    // tool (B1-A) — one class, one wording, whether the CALLABLE is missing or only its DEF is.
    return `Tool ${toolName} is referenced but not mounted in this workspace: its type ${typeName} did not resolve (is ${defRepo} mounted as a dependency?).\n${lines.join('\n')}`
  }
  // The def resolved. Fold diagnostics across the fitting identities; block on real errors.
  // The synthesis artifacts (NON_BLOCKING) stay tolerated here — they are about the input's
  // own `type` arg, not a malformed call.
  const diagnostics = verdicts.flatMap((v) => v.diagnostics ?? [])
  const blocking = diagnostics.filter((d) => d.severity === 'error' && !NON_BLOCKING.has(d.code ?? ''))
  if (blocking.length === 0) return null
  const lines = blocking.map((d) => `  - ${d.code ?? 'invalid'}: ${d.message ?? 'invalid input'}`)
  return `Invalid input for ${toolName} (does not conform to ${typeName}):\n${lines.join('\n')}`
}
