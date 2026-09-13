---
type: au.engine.readme::au-engine
tldr: The always-present kernel daemon for the agent layer — mechanism only, it ships zero tools and every capability is a plugin. Run it on a workspace and mount plugin packages; its clients speak au-mcp-sdk over the wire. Extend it by writing plugins, never by changing the kernel.
---

# Repo Overview

## General Context
Before defining what `au-mcp` is,
here is some general context of the environment it exists in.

- `arsumbris` is a framework for agentic knowledge work.
- `au-engine` serves a graph over a cross-repo substrate of typed files.
- `au-host` is the UI part of the framework.
- `au-mcp-sdk` is the contract the kernel, every plugin, and every adapter speak.
- `au-mcp-core` is the bundled baseline plugin package — the default tools + governance floors.

`au-mcp` is part of this `arsumbris` framework.
It is the agent layer's kernel.


## What this is

`au-mcp` is the **kernel daemon** — the always-present agent entry point over the engine graph.
- a workspace-scoped daemon, paired 1:1 with the `au-engine` daemon.
- it serves many concurrent agent sessions.
- its clients — the Claude Code adapter, the CC hooks, `au-host`, other UIs — are THIN, and speak `@arsumbris/au-mcp-sdk` over the wire.

The kernel holds only the MECHANISM.
- it ships ZERO agent-facing tools and ZERO policy.
- every tool and every floor is a PLUGIN (decision 2608261517). `au-mcp-core` ships the baseline set.
- the kernel knows only `au-mcp-sdk`. Everything else is a plugin or an adapter that also speaks it.

### What the kernel holds (the mechanism)

- **ports** — the engine broker, the one channel a plugin reaches the graph through (read / mutate).
- **the plugin loader** — discovers plugin packages mounted as workspace members, imports each one's `createPlugin`.
- **the registry** — the loaded callable tools + the hook phases (observer / mediator / stamper / session-start), ordered by tier (`gate -> floor -> policy`) then name, not by a raw priority number.
- **the wire** — the Unix-socket server + the framed-JSON protocol the clients speak.
- **session + run lifecycle** — open / close, crash recovery, dormancy retention.
- **the phase runner** — orchestrates every action through `mediate -> act -> observe`, and runs the `session-start` hooks once at the fresh open (each queries the graph via a read-only broker and returns computed inject, stashed for the adapter to fetch via `session-start-context`).
  - each session-start hook also gets a kernel-resolved `ctx.scope` (decision 2609071712, `session-scope.ts`): active-vs-mounted tools/skills, mounted members, active profile. Resolved ONCE at open (`mounted` from the registry + `discoverSkills` + the `members` read; `active` = `mounted` intersected with the profile's `tools`/`skills` allowlist) so a hook reads it instead of re-deriving the allowlist. Best-effort: a down engine yields the registry-only tool set.
  - **tool visibility is profile-derived** (plan 2609072337), not a per-request env allowlist (the `AU_MCP_TOOLS` env + the `allowed` wire param are retired). The profile `tools` reduction stashes `session.toolAllowlist` at open. `invoke` gates from it (the session is open by call time; a session-less invoke is unrestricted). The ADVERTISE (`list-capabilities`) runs at the shim's startup, BEFORE session-open, so it resolves the allowlist from the forwarded `AU_MCP_PROFILE` locator (`profileToolAllowlist`) when no session is open, else from the session. Tri-state: absent profile field / no profile -> unrestricted; `[]` -> none; a subset -> exactly those.
- **the profile read** (`profile-config.ts`) — at session-open the daemon reads the active agent-profile (`AU_MCP_PROFILE`) from the graph and resolves its typed `hooks` (the non-critical whitelist) + `hookConfig` (inline-or-ref config instances). A hook runs once per configured instance with its typed fields; a `critical` hook always runs regardless of the whitelist. Config is delivered per shape (session-start via a `config` param, mediators via `ctx.hookConfig`, observers via a `config` param). This replaces any untyped launch-env config channel: hook config is typed graph data, resolved where it is consumed.
- **the event bus** — the live per-session event log (`consult-trace` reads it) + fan-out to observers.
- **the read-view + freshness** — tracks what each session has read / been served, and keeps it honest against external change. The fact the write seam and the governance floors read.
- **the write seam** — `broker.mutate`, where an un-forgeable stamp attaches before a governed write.
- **gate-side validation + the un-forgeable attach** — input is validated against the tool's def before invoke; governance is daemon-sourced, never agent-forgeable.

### What it does NOT hold

- no file ops, engine reads, or intents — those are `au-mcp-core`, loadable.
- no governance floors (read-guard, tool-precondition, the native-tool redirect) — also `au-mcp-core`.
- no on-disk trace format — that is `au-provenance`.


## How to use this

Run the daemon on a workspace:

```
au-mcp start <workspace>     # also: stop, status
```

- it binds a Unix socket at `~/.arsumbris/au-mcp/run/<hash>.sock` — device-global, keyed by a hash of the workspace path (the SUN_LEN fix; an in-workspace path overran the socket-name limit on deep trees).
  - the engine daemon's socket lives beside it under its own tenant, `~/.arsumbris/au-engine/run/<hash>.sock`, keyed by the same workspace.
- framing: a 4-byte big-endian length prefix + UTF-8 JSON, mirroring the engine daemon.
- it pairs 1:1 with the `au-engine` daemon for that workspace.
- mount `au-mcp-core` (and any plugin package) as a workspace member; the kernel discovers and serves them. With none mounted, the kernel serves nothing — it composes no tools of its own.

Clients do not call the kernel directly — they speak `@arsumbris/au-mcp-sdk` over the wire (the CC adapter, the hooks, `au-host`).

Consumed as **TypeScript source** — there is no build step.


## How to extend this

You extend the agent layer by writing PLUGINS, not by changing the kernel.
- the kernel is mechanism-only, and closed to tool / policy specifics by design.
- build a tool or a hook against `@arsumbris/au-mcp-sdk`, then mount your package as a workspace member — the kernel discovers it the same way it discovers `au-mcp-core`.
- `au-mcp-core` is the reference for what a first-party plugin looks like.
- to bind a new agent harness to the daemon, implement the adapter contract (see `@arsumbris/au-mcp-adapter-cc`).

See `au-mcp-sdk`'s "How to extend this" for the full plugin / adapter authoring flow.
- or invoke the `/au-mcp-sdk:build-a-plugin` skill, which walks an agent through building a tool or hook.
