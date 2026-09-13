// The default plugin set the kernel composes in-process — now EMPTY, by construction.
//
// Every agent-facing tool and every policy floor ships LOADABLE from au-mcp-core
// (decision 2608261517, plan 2608261532): the kernel holds only the mechanism; tools
// + policy are plugins discovered through the public seam when au-mcp-core is a mounted
// workspace member. File ops, engine reads, the host-relay intent surface, and all three
// governance floors (read-guard, tool-precondition, redirect) migrated out. The kernel
// composes none of them.

import type { Plugin } from '@arsumbris/au-mcp-sdk'

/**
 * The default plugin set the daemon composes when a caller passes no `plugins` — EMPTY.
 *
 * This is the kernel's composition seam, and its emptiness is the point: the kernel ships
 * zero in-process tool or policy literals, so the default is `[]`. The invariant of decision
 * 2608261517 ("the kernel composes nothing; a capability a core plugin uses is reachable from
 * PluginContext") is enforced HERE — a non-empty return would be a regression. A caller that
 * wants a capability mounts au-mcp-core (or any package) as a workspace member; discovery loads
 * it through the same public path a user plugin uses. Takes no engine handles by design: a
 * composition function reaching for the broker would be the daemon-injected privilege this plan
 * abolishes.
 */
export function defaultKernelPlugins(): Plugin[] {
  return []
}
