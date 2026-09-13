// Resolve the kernel SessionScope at session-open (decision 2609071712): what tools / skills are
// ACTIVE vs MOUNTED, the mounted members, and the active profile. Computed ONCE and handed to every
// session-start hook via `ctx.scope`, so no hook re-derives the profile allowlist itself.
//
// `mounted` is what the workspace provides (the registry's loaded tools, the discovered skills, the
// engine's members); `active` is `mounted` intersected with the active profile's `tools` / `skills`
// allowlist (absent allowlist -> unrestricted, so active == mounted). Best-effort: a down / hiccuping
// engine yields the registry-only tool set with empty skills / members, never wedging session-open.

import type { SessionScope } from '@arsumbris/au-mcp-sdk'
import { discoverSkills } from '../skills/index.ts'
import type { EngineBroker } from './broker.ts'
import { parseProfileNameAllowlist, type ProfileRow } from './profile-config.ts'
import { toolName } from './tool-visibility.ts'

/** The one `members` (WireMember) row field we need. */
interface MemberRow {
  repo?: unknown
}

export interface ResolveScopeArgs {
  /** Read-only engine access; `available()` false yields the registry-only degraded scope. */
  broker: EngineBroker
  /** The registry's loaded callable ids (`registry.tools().map((m) => m.id)`), reduced to tool names. */
  toolManifestIds: string[]
  /** The active agent-profile name, or undefined for an unprofiled launch. */
  profile: string | undefined
  /** The agent-profile rows already read at session-open (empty when no profile / no engine). */
  profileRows: ProfileRow[]
}

export interface ResolvedScope {
  /** The kernel `SessionScope` handed to every session-start hook via `ctx.scope`. */
  scope: SessionScope
  /**
   * The `tools` allowlist tri-state as agent-facing names — the SAME reduction that produced
   * `scope.tools.active`, surfaced so the daemon stashes ONE value on the session for visibility
   * gating (`list-capabilities` + `invoke`). `undefined` = unrestricted; `[]` = none; `[names]` =
   * exactly those. So `scope.active` and the visibility gate cannot diverge — one profile parse.
   */
  toolAllowlist: string[] | undefined
}

export async function resolveSessionScope(args: ResolveScopeArgs): Promise<ResolvedScope> {
  const { broker, toolManifestIds, profile, profileRows } = args

  const mountedTools = toolManifestIds.map(toolName)
  const toolAllow = parseProfileNameAllowlist(profileRows, profile, 'tools')
  const activeTools = toolAllow ? mountedTools.filter((t) => toolAllow.has(t)) : mountedTools

  let mountedSkills: string[] = []
  let members: string[] = []
  if (broker.available()) {
    try {
      mountedSkills = (await discoverSkills(broker)).skills.map((s) => s.name)
    } catch {
      /* engine hiccup -> no skills, never wedge */
    }
    try {
      const frame = await broker.read('members')
      const rows =
        !frame || frame.ready === false || frame.type === 'error' || !Array.isArray(frame.result)
          ? []
          : (frame.result as MemberRow[])
      members = rows.map((m) => (typeof m.repo === 'string' ? m.repo : '')).filter(Boolean)
    } catch {
      /* engine hiccup -> no members, never wedge */
    }
  }
  const skillAllow = parseProfileNameAllowlist(profileRows, profile, 'skills')
  const activeSkills = skillAllow ? mountedSkills.filter((s) => skillAllow.has(s)) : mountedSkills

  return {
    scope: {
      tools: { active: activeTools, mounted: mountedTools },
      skills: { active: activeSkills, mounted: mountedSkills },
      members,
      ...(profile ? { profile } : {}),
    },
    // The tri-state (not the collapsed `active` list): the daemon needs `undefined` to mean
    // "advertise every tool", which `active == mounted` cannot distinguish. Same parse as above.
    toolAllowlist: toolAllow ? [...toolAllow] : undefined,
  }
}
