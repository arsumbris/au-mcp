// The tool allowlist — which tools a caller may see and call.
//
// The human's only grant axis is on/off, and it is the active agent-profile's typed `tools`
// (plan 2609072337). The daemon resolves that allowlist from the graph and stashes it as
// `session.toolAllowlist` at open; `list-capabilities` + `invoke` gate on it (the advertise,
// which runs before session-open, resolves from the profile locator instead). This function is
// the pure membership test both paths share. See the tool-visibility spec.
//
// A tool's ENGINE ACCESS is a separate axis, declared on its own def and fixed at
// discovery. Nothing here touches it.

/** The agent-facing tool name for a plugin manifest id: `mcp.shout` -> `shout`. */
export function toolName(manifestId: string): string {
  return manifestId.startsWith('mcp.') ? manifestId.slice('mcp.'.length) : manifestId
}

/**
 * Whether `manifestId` is visible under `allowed`.
 *
 * ABSENT allowlist -> every tool (a caller that names nothing is unrestricted, so a
 * bare launch is fully capable). EMPTY allowlist -> no tool. The two are distinct.
 */
export function isAllowed(allowed: string[] | undefined, manifestId: string): boolean {
  if (allowed === undefined) return true
  return allowed.includes(toolName(manifestId))
}
