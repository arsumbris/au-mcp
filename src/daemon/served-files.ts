// The serves-contract resolver — the OBSERVE-side half of the declarative serves mechanism
// ([[decision - 2607030037 - au_guide satisfies a read-precondition via a declarative typed
// serves-contract, not a text sentinel]]).
//
// A tool declares `serves-files-meta { pathTemplate }` on its `mcp.tool` subtype. Discovery
// hands the daemon a `base tool name -> { pathTemplate, packageRoot }` map. On a gate ToolCall
// observe, the daemon recomputes which file the call served — from the observed tool name +
// input + the template — and adds it to the session's served-view. A read-precondition on
// another tool is then satisfied by having CALLED the serving tool (an unspoofable observed
// call), not by any response text.
//
// GUARDED substitution: a `{field}` value must be a single plain path segment (no separators,
// no `..`) and the resolved path must stay inside the package root and exist. A path-traversal
// input (or a call missing the field, e.g. au_guide's task-map call with no scenario) serves
// no specific file and registers nothing.

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { EventKind, type SessionEvent } from '@arsumbris/au-mcp-sdk'

/** A tool's declared serves-contract: a package-root-relative path template. */
export interface ServesContract {
  /** Package-root-relative path with `{inputField}` placeholders, e.g. `guides/{scenario}.md`. */
  pathTemplate: string
  /** Absolute package root the template resolves against (the tool-def's owning package). */
  packageRoot: string
}

/** Canonicalize a path (realpath), falling back to the input if it can't be resolved. */
function canon(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** A substituted segment is safe iff it is a non-empty single segment with no traversal. */
function safeSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.split(/[/\\]/).includes('..') &&
    value !== '..'
  )
}

/**
 * Resolve a serves-contract against a call input to the CANONICAL absolute path served, or
 * null when nothing specific is served (a `{field}` absent from the input, an unsafe segment,
 * a path escaping the package, or a nonexistent target). `input` is the observed `tool_input`.
 */
export function resolveServedPath(contract: ServesContract, input: unknown): string | null {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  let bailed = false
  const substituted = contract.pathTemplate.replace(/\{(\w+)\}/g, (_m, field: string) => {
    const value = rec[field]
    if (!safeSegment(value)) {
      bailed = true
      return ''
    }
    return value
  })
  if (bailed) return null
  // The template is package-root-relative; an absolute template is a misdeclaration — reject.
  if (isAbsolute(substituted)) return null
  const root = canon(contract.packageRoot)
  const resolved = resolve(root, substituted)
  // Containment: the resolved path must live inside the package root (defense in depth
  // beyond the per-segment guard).
  if (resolved !== root && !resolved.startsWith(root + sep)) return null
  if (!existsSync(resolved)) return null
  return canon(resolved)
}

/** What `registerServedFiles` needs off a session (narrowed so it is unit-testable). */
interface ServedSession {
  info: { gatePrefix?: string }
  servedView: Map<string, string>
}

/**
 * On a gate ToolCall observe, register the file the call served into the session's served-view
 * (best-effort, in place of no-op). Skips non-ToolCalls, non-gate tools, tools with no serves-
 * contract, and calls that serve no specific file. `serves` is keyed by BASE tool name
 * (gate tool minus the gate prefix).
 *
 * `hashOf` resolves the served path's SERVE-TIME engine content hash, stored beside the path for
 * the freshness compare (an unresolved hash stores `''`, still a valid precondition entry). Injected
 * (not a broker dep here) so this stays unit-testable; the daemon passes an engine-backed resolver.
 */
export async function registerServedFiles(
  session: ServedSession,
  event: SessionEvent,
  serves: Map<string, ServesContract>,
  hashOf: (path: string) => Promise<string | null>,
): Promise<void> {
  if (serves.size === 0) return
  if (event.kind !== EventKind.ToolCall) return
  const prefix = session.info.gatePrefix
  if (!prefix) return
  const data = event.data as { tool?: unknown; input?: unknown } | undefined
  const tool = typeof data?.tool === 'string' ? data.tool : undefined
  if (!tool || !tool.startsWith(prefix)) return
  const contract = serves.get(tool.slice(prefix.length))
  if (!contract) return
  const served = resolveServedPath(contract, data?.input)
  if (served) session.servedView.set(served, (await hashOf(served)) ?? '')
}
