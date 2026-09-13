// @arsumbris/au-mcp — the au-mcp kernel daemon.
//
// A standalone daemon scoped to the engine's workspace, paired 1:1 with the
// au-engine daemon. Its clients (the CC MCP-server shim, the CC hooks, au-host,
// other UIs) are thin and speak @arsumbris/au-mcp-sdk over the wire.
//
// Built across Phase 3 (see the plan):
// - wire transport server + framing            (3.2) ✓
// - lifecycle: start/stop/status + reclaim     (3.3, src/cli.ts) ✓
// - session registry + state split             (3.4) ✓
// - engine broker                              (3.5) ✓
// - plugin registry + orchestration            (3.6) ✓
// - first-party callable plugins               (3.7) ✓
// - consult-trace over the live log            (3.8) ✓

export { MCP_CONTRACT_VERSION } from '@arsumbris/au-mcp-sdk'
export { createDaemon, type Daemon, type DaemonOptions } from './daemon/daemon.ts'
export { SessionRegistry, type Session } from './daemon/session.ts'
export { startDaemon, type RunningDaemon } from './serve.ts'
export { listen, type WireServer, type WireConnection, type RequestHandler } from './wire/server.ts'
// connectSocket + the frame codec now live in @arsumbris/au-mcp-sdk (client utilities).
export { createEngineBroker, type EngineBroker, type EngineFrame } from './daemon/broker.ts'
export { createPluginRegistry, type PluginRegistry } from './daemon/registry.ts'
export { discoverTools, registerLoadableTools } from './daemon/discovery.ts'
export { defaultKernelPlugins } from './plugins/index.ts'
export { engineSocketPath } from './paths.ts'
// The selection-key deriver for gen-tree paths (shared by both materialize capabilities).
export { deriveSelKey } from './gen/tree.ts'
// The skills capability (mcp.skill): neutral discovery + the launch-time materialize
// driver an adapter calls with its pure harness transform.
export {
  discoverSkills,
  genPath,
  materialize,
  skillKey,
  skillManifest,
  type MaterializeOptions,
  type MaterializeResult,
  type Skill,
  type SkillDiscovery,
  type SkillFile,
  type SkillManifest,
  type SkillManifestEntry,
  type SkillTransform,
  type SkillTree,
  type SkippedSkill,
} from './skills/index.ts'

// The inject capability (mcp.inject): always-on context, discovered and materialized to
// generated session-start hook slots. Twin of the skills path on the shared tree core.
// `genPath` is skill-specific above; the inject tree path is `injectGenPath`.
export {
  discoverInjects,
  expandInjects,
  fileStem,
  genPath as injectGenPath,
  inDefaultSet,
  injectKey,
  injectManifest,
  materializeInjects,
  packBlocks,
  sizeInject,
  type DroppedInject,
  type GenFile,
  type GenTree,
  type Inject,
  type InjectBlock,
  type InjectDiscovery,
  type InjectManifest,
  type InjectManifestEntry,
  type InjectTransform,
  type InjectTree,
  type MaterializeInjectsOptions,
  type MaterializeInjectsResult,
  type PackBlock,
  type PackOptions,
  type PackResult,
  type SkippedInject,
} from './inject/index.ts'
