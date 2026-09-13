// The skills capability: neutral discovery plus the launch-time materialize driver.
//
// A harness adapter imports `materialize` and supplies only its pure transform.
// See [[spec - mcp.skill - packages ship agent guidance as typed instances materialized
// at launch into each harness skill folder::au-harness]].

export { discoverSkills, type Skill, type SkillDiscovery, type SkippedSkill } from './discover.ts'
export {
  genPath,
  materialize,
  skillKey,
  skillManifest,
  type MaterializeOptions,
  type MaterializeResult,
  type SkillFile,
  type SkillManifest,
  type SkillManifestEntry,
  type SkillTransform,
  type SkillTree,
} from './materialize.ts'
