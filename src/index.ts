/**
 * @overview slopslint public API barrel. ~100 lines, exports only.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the export groups       <- CORE package surface
 *
 *   MAIN FLOW
 *   internal modules -> named re-exports -> package consumers
 *
 *   PUBLIC API
 *   Every named export below; grouped by owning module
 *
 *   INTERNALS
 *   (none)
 *
 * @exports canonical API, ceilings API, check API, config API, claims API, orphan API, surfaces API, detector API, errors API, repo API, tombstone API, version API
 * @deps all public src modules
 */

// -- 1/1 CORE · public re-export registry -- <- START HERE
export {
  canonicalJson,
  canonicalSha256,
  canonicalizeReport,
  enforceReport,
  fingerprint,
  ppm,
  repoRelativePath,
  serializeCanonical,
  type CanonicalDuplicate,
  type CanonicalEndpoint,
  type CanonicalReport,
  type CanonicalStatistics,
  type UnmatchedTombstone,
} from "./canonical.ts";
export {
  CEILINGS_PATH,
  getBaseText,
  loadCeilings,
  loadCeilingsFromText,
  ratchet,
  type CeilingsConfig,
  type RatchetResult,
} from "./ceilings.ts";
export {
  classifyReport,
  runCheck,
  type CheckOptions,
  type ClassifiedSummary,
  type ExtendedSummary,
  type ScopeSummary,
} from "./check.ts";
export {
  loadConfig,
  readScopeNames,
  type ScanDefaults,
  type ScopeConfig,
  type SlopConfig,
  type ClaimsConfig,
  type OrphanScopeConfig,
  type SurfaceGlobs,
} from "./config.ts";
export { verifyClaims, type ClaimsReport, type VerifiedClaim } from "./claims.ts";
export {
  censusOrphans,
  classifyOrphans,
  enforceOrphanReport,
  type OrphanEvidence,
  type OrphanFinding,
  type OrphanReport,
} from "./orphans.ts";
export { enumerateSurfaces, surfaceId, type Surface } from "./surfaces.ts";
export {
  scanScope,
  selectFiles,
  type RawDuplicate,
  type RawReport,
  type RawStatistics,
} from "./detector.ts";
export { SlopslintError, TombstoneConfigError } from "./errors.ts";
export { CONFIG_REL, findRepoRoot } from "./repo.ts";
export {
  ALL_FAMILIES,
  CATEGORIES,
  DUPLICATION_FAMILY,
  NON_DUPLICATION_FAMILIES,
  ORPHAN_FAMILY,
  SCHEMA_VERSION,
  STATUSES,
  addTombstone,
  asUnmatched,
  classifyDuplicates,
  family,
  isDuplication,
  isOrphan,
  isStanding,
  loadTombstones,
  resolveAllowedScopes,
  standingTombstones,
  validateOne,
  type AddTombstoneOptions,
  type LoadOptions,
  type ScopeClassification,
  type Tombstone,
} from "./tombstone.ts";
export { DETECTOR_NAME, DETECTOR_VERSION, VERSION } from "./version.ts";

// -/ 1/1
