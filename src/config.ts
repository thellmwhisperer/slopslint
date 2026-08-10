/**
 * @overview Strict `.slop/config.yml` loader. ~280 lines, 9 public symbols.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at loadConfig()          <- CORE complete validation flow
 *   2. validateSurfaces()             <- orphan/claims glob contract
 *   3. readScopeNames()               <- tombstone scope discovery
 *
 *   MAIN FLOW
 *   YAML -> strict shape checks -> duplication + opt-in surface config
 *
 *   PUBLIC API
 *   loadConfig(), readScopeNames(), ensureRepoRelative(), configuration interfaces
 *
 *   INTERNALS
 *   validateIgnoreList, validateDefaults, validateScope, validateGlobList,
 *   validateSurfaces, validateOrphanScopes, validateClaims
 *
 * @exports ScanDefaults, ScopeConfig, SurfaceGlobs, OrphanScopeConfig, ClaimsConfig, SlopConfig, ensureRepoRelative, loadConfig, readScopeNames
 * @deps node:fs, errors, version, yaml
 */
import { readFileSync } from "node:fs";
import { SlopslintError, ensure } from "./errors.ts";
import { DETECTOR_NAME, DETECTOR_VERSION } from "./version.ts";
import { YamlError, isMapping, parseYamlStrict } from "./yaml.ts";

// -- 1/4 HELPER · configuration types and path invariant --

/** Detection parameters shared by every scope. */
export interface ScanDefaults {
  format: string;
  mode: string;
  min_lines: number;
  min_tokens: number;
}

/** One independent measurement scope. */
export interface ScopeConfig {
  scan_path: string;
  pattern: string;
  ignore: string[];
}

/** Generic repository surfaces selected by glob and kind. */
export interface SurfaceGlobs {
  files: string[];
  directories: string[];
  exported_symbols: string[];
  ignore: string[];
}

/** One independent orphan census scope. */
export interface OrphanScopeConfig extends SurfaceGlobs {
  test_files: string[];
  generation_files: string[];
}

/** Opt-in claims census and its committed claim-map path. */
export interface ClaimsConfig {
  file: string;
  surfaces: Record<string, SurfaceGlobs>;
}

/** The validated `.slop/config.yml` document. */
export interface SlopConfig {
  schema: 1;
  detector: { name: string; version: string };
  defaults: ScanDefaults;
  global_ignore: string[];
  scopes: Record<string, ScopeConfig>;
  orphan_scopes?: Record<string, OrphanScopeConfig>;
  claims?: ClaimsConfig;
}

/** Reject a path that is absolute or escapes the repository root. */
export function ensureRepoRelative(value: string, what: string): string {
  ensure(
    !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value),
    `${what} must be repo-relative (no absolute or '..'): ${value}`,
  );
  ensure(
    !value.split(/[\\/]/).includes(".."),
    `${what} must be repo-relative (no absolute or '..'): ${value}`,
  );
  return value;
}

// -/ 1/4

// -- 2/4 HELPER · shape validators --

function validateIgnoreList(entries: unknown, what: string): string[] {
  ensure(Array.isArray(entries), `${what} must be a list`);
  ensure(
    entries.every((entry) => typeof entry === "string"),
    `${what} entries must be strings`,
  );
  return entries as string[];
}

function validateDefaults(raw: unknown): ScanDefaults {
  ensure(isMapping(raw), "config defaults missing");
  ensure(
    typeof raw["format"] === "string" && raw["format"].length > 0,
    "config defaults.format must be a string",
  );
  ensure(
    typeof raw["mode"] === "string" && raw["mode"].length > 0,
    "config defaults.mode must be a string",
  );
  const minLines = raw["min_lines"];
  const minTokens = raw["min_tokens"];
  ensure(
    typeof minLines === "number" && Number.isInteger(minLines),
    "config defaults min_lines/min_tokens must be integers (not booleans)",
  );
  ensure(
    typeof minTokens === "number" && Number.isInteger(minTokens),
    "config defaults min_lines/min_tokens must be integers (not booleans)",
  );
  ensure(minLines > 0, "config defaults.min_lines must be positive");
  ensure(minTokens > 0, "config defaults.min_tokens must be positive");
  return {
    format: raw["format"],
    mode: raw["mode"],
    min_lines: minLines,
    min_tokens: minTokens,
  };
}

function validateScope(name: string, raw: unknown): ScopeConfig {
  ensure(isMapping(raw), `scope ${name} must be a mapping`);
  const scanPath = raw["scan_path"];
  ensure(
    typeof scanPath === "string" && scanPath.length > 0,
    `scope ${name} scan_path missing`,
  );
  ensureRepoRelative(scanPath, `scope ${name} scan_path`);
  const pattern = raw["pattern"];
  ensure(
    typeof pattern === "string" && pattern.length > 0,
    `scope ${name} pattern missing`,
  );
  return {
    scan_path: scanPath,
    pattern,
    ignore: validateIgnoreList(raw["ignore"] ?? [], `scope ${name} ignore`),
  };
}

function validateGlobList(entries: unknown, what: string): string[] {
  const globs = validateIgnoreList(entries ?? [], what);
  for (const glob of globs) {
    ensure(glob.length > 0, `${what} entries must be non-empty`);
    ensureRepoRelative(glob, `${what} entry`);
  }
  return globs;
}

function validateSurfaces(name: string, raw: unknown): SurfaceGlobs {
  ensure(isMapping(raw), `${name} must be a mapping`);
  const result = {
    files: validateGlobList(raw["files"], `${name}.files`),
    directories: validateGlobList(raw["directories"], `${name}.directories`),
    exported_symbols: validateGlobList(
      raw["exported_symbols"],
      `${name}.exported_symbols`,
    ),
    ignore: validateGlobList(raw["ignore"], `${name}.ignore`),
  };
  ensure(
    result.files.length + result.directories.length + result.exported_symbols.length > 0,
    `${name} must declare files, directories, or exported_symbols`,
  );
  return result;
}

function validateOrphanScopes(raw: unknown): Record<string, OrphanScopeConfig> | undefined {
  if (raw === undefined) return undefined;
  ensure(isMapping(raw) && Object.keys(raw).length > 0, "orphan_scopes must be a non-empty mapping");
  const scopes: Record<string, OrphanScopeConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const surfaces = validateSurfaces(`orphan scope ${name}`, value);
    const mapping = value as Record<string, unknown>;
    scopes[name] = {
      ...surfaces,
      test_files: validateGlobList(mapping["test_files"], `orphan scope ${name}.test_files`),
      generation_files: validateGlobList(
        mapping["generation_files"],
        `orphan scope ${name}.generation_files`,
      ),
    };
  }
  return scopes;
}

function validateClaims(raw: unknown): ClaimsConfig | undefined {
  if (raw === undefined) return undefined;
  ensure(isMapping(raw), "claims must be a mapping");
  const file = raw["file"];
  ensure(typeof file === "string" && file.length > 0, "claims.file must be a non-empty string");
  ensureRepoRelative(file as string, "claims.file");
  const surfacesRaw = raw["surfaces"];
  ensure(
    isMapping(surfacesRaw) && Object.keys(surfacesRaw).length > 0,
    "claims.surfaces must be a non-empty mapping",
  );
  const surfaces: Record<string, SurfaceGlobs> = {};
  for (const [name, value] of Object.entries(surfacesRaw)) {
    surfaces[name] = validateSurfaces(`claims surface ${name}`, value);
  }
  return { file: file as string, surfaces };
}

// -/ 2/4

// -- 3/4 CORE · loadConfig -- <- START HERE

/**
 * Load and validate `.slop/config.yml`.
 *
 * The `detector` block must name the linked detector library exactly: a config
 * written for a different detector version describes a different measurement,
 * and silently running it would make the committed ceilings meaningless.
 */
export function loadConfig(path: string): SlopConfig {
  let raw: unknown;
  try {
    raw = parseYamlStrict(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof YamlError ? error.message : String(error);
    throw new SlopslintError(`config file is missing or invalid YAML: ${detail}`);
  }
  ensure(isMapping(raw), "config must be a YAML mapping");
  ensure(raw["schema"] === 1, "config schema must be 1");

  const detector = raw["detector"];
  ensure(isMapping(detector), "config detector missing");
  ensure(
    detector["name"] === DETECTOR_NAME,
    `config detector.name must be ${DETECTOR_NAME}`,
  );
  ensure(
    detector["version"] === DETECTOR_VERSION,
    `config detector version must be pinned to ${DETECTOR_VERSION}`,
  );

  const scopesRaw = raw["scopes"];
  ensure(
    isMapping(scopesRaw) && Object.keys(scopesRaw).length > 0,
    "config needs scopes",
  );
  const scopes: Record<string, ScopeConfig> = {};
  for (const [name, value] of Object.entries(scopesRaw)) {
    scopes[name] = validateScope(name, value);
  }
  const orphanScopes = validateOrphanScopes(raw["orphan_scopes"]);
  const claims = validateClaims(raw["claims"]);

  return {
    schema: 1,
    detector: { name: DETECTOR_NAME, version: DETECTOR_VERSION },
    defaults: validateDefaults(raw["defaults"]),
    global_ignore: validateIgnoreList(raw["global_ignore"] ?? [], "config global_ignore"),
    scopes,
    ...(orphanScopes ? { orphan_scopes: orphanScopes } : {}),
    ...(claims ? { claims } : {}),
  };
}

// -/ 3/4

// -- 4/4 HELPER · readScopeNames --

/**
 * Scope names declared by a repository.
 *
 * Returns `undefined` only when the config file is absent. A file that exists
 * but cannot be parsed fails closed: falling back to "no known scopes" would
 * let a corrupted config widen what a tombstone is allowed to claim.
 */
export function readScopeNames(configPath: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseYamlStrict(text);
  } catch (error) {
    const detail = error instanceof YamlError ? error.message : String(error);
    throw new SlopslintError(`cannot read scopes from ${configPath}: ${detail}`);
  }
  if (!isMapping(raw) || !isMapping(raw["scopes"])) {
    return undefined;
  }
  const names = Object.keys(raw["scopes"]);
  return names.length > 0 ? names : undefined;
}

// -/ 4/4
