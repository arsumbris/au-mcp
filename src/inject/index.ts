// The inject capability: neutral discovery of `mcp.inject` instances.
//
// The always-on delivery class beside the runtime-dynamic tools and launch-static skills.
// Phase 1 exposes discovery only; the launch-time materialize driver, the role-partitioned
// default set, packing, and the manifest arrive in later phases.
// See [[spec - mcp.inject - typed instances whose bodies land in context at session start,
// hop-expanded and packed across generated hook slots::au-harness]].

export {
  discoverInjects,
  type Inject,
  type InjectDiscovery,
  type SkippedInject,
} from './discover.ts'
export { expandInjects, fileStem, sizeInject, type InjectBlock } from './expand.ts'
export {
  genPath,
  inDefaultSet,
  injectKey,
  injectManifest,
  materializeInjects,
  type DroppedInject,
  type InjectManifest,
  type InjectManifestEntry,
  type InjectTransform,
  type InjectTree,
  type MaterializeInjectsOptions,
  type MaterializeInjectsResult,
} from './materialize.ts'
export { packBlocks, type PackBlock, type PackOptions, type PackResult } from './pack.ts'
export type { GenFile, GenTree } from '../gen/tree.ts'
