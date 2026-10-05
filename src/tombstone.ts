// Strict tombstone records and finding classification.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { stringify } from "yaml";
import type { CanonicalDuplicate, UnmatchedTombstone } from "./canonical.ts";
import { loadConfig, readScopeNames } from "./config.ts";
import { TombstoneConfigError, ensureRecord } from "./errors.ts";
import { YamlError, isMapping, parseYamlStrict } from "./yaml.ts";


/** Schema version every record must declare. */
export const SCHEMA_VERSION = 1;

/**
 * Record categories. Adding one is a deliberate schema change; unknown values
 * fail closed at load time.
 */
export const CATEGORIES = ["alien_code", "debt_normalization", "duplication", "orphan"] as const;

/** Record statuses. */
export const STATUSES = ["accepted", "legacy"] as const;

/** The one family the duplication detector emits. */
export const DUPLICATION_FAMILY = "clone_fingerprint";

/** The orphan detector's stable matcher family. */
export const ORPHAN_FAMILY = "orphan_fingerprint";

/** Families reserved for detectors that consume artifacts rather than clones. */
export const NON_DUPLICATION_FAMILIES = [
  "agent_artifact_in_repo",
  "documented_as_convention",
  "environment_layout_coupling",
  "format_churn",
  "inline_foreign_language",
  "mock_heavy_test",
  "runtime_dependency",
  "self_validating_test",
  "speculative_feature",
  "speculative_hardening",
  "subprocess_foreign_interpreter",
  "test_weakening",
] as const;

/** Every family the schema accepts. */
export const ALL_FAMILIES = [DUPLICATION_FAMILY, ORPHAN_FAMILY, ...NON_DUPLICATION_FAMILIES] as const;

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** One validated tombstone record. */
export interface Tombstone {
  id: string;
  status: string;
  category: string;
  title: string;
  created_at: string;
  incident: Record<string, unknown>;
  match: Record<string, unknown>;
  source_file: string;
}

/** The matcher family a record declares. */
export function family(record: Tombstone): string | undefined {
  const value = record.match["family"];
  return typeof value === "string" ? value : undefined;
}

/** True when the duplication detector can match this record. */
export function isDuplication(record: Tombstone): boolean {
  return record.category === "duplication";
}

/** True when the orphan detector can match this record. */
export function isOrphan(record: Tombstone): boolean {
  return record.category === "orphan";
}

/** True when no active detector consumes this record's category. */
export function isStanding(record: Tombstone): boolean {
  return record.category !== "duplication" && record.category !== "orphan";
}



function requireString(value: unknown, what: string): string {
  ensureRecord(
    typeof value === "string" && value.trim().length > 0,
    `${what} must be a non-empty string`,
  );
  return value as string;
}

function requireDateish(value: unknown, what: string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  ensureRecord(
    typeof value === "string" && value.trim().length > 0,
    `${what} must be an ISO date string`,
  );
  return value as string;
}

/**
 * Reject absolute paths, empty paths, and any `..` component.
 *
 * Evidence and match paths must be repository-relative so a record can never
 * reach outside the checkout, and so it stays portable across clones.
 */
function checkRepoRelative(value: unknown, what: string): string {
  ensureRecord(
    typeof value === "string" && value.length > 0,
    `${what} must be a non-empty string`,
  );
  const path = value as string;
  ensureRecord(
    !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path),
    `${what} must be repo-relative (not absolute): ${JSON.stringify(path)}`,
  );
  ensureRecord(
    !path.split(/[\\/]/).includes(".."),
    `${what} must not contain '..' (path escape): ${JSON.stringify(path)}`,
  );
  ensureRecord(
    path !== "." && path !== "./",
    `${what} must name a real path (not ${JSON.stringify(path)})`,
  );
  return path;
}

/**
 * When the repository root is known, require the evidence path to exist.
 *
 * A tombstone is a verifiable record: a stale or fabricated reference is caught
 * at load time rather than reviewed on faith. Synthetic test trees pass
 * `repoRoot = undefined` to exercise shape validation alone.
 */
function verifyArtifact(relative: string, repoRoot: string | undefined, what: string): void {
  if (repoRoot === undefined) {
    return;
  }
  ensureRecord(
    existsSync(join(repoRoot, relative)),
    `${what} references a path that does not exist in the repo: ${JSON.stringify(relative)}`,
  );
}

function validateIncident(
  fileName: string,
  id: string,
  incident: unknown,
  repoRoot: string | undefined,
): Record<string, unknown> {
  ensureRecord(isMapping(incident), `${fileName}: ${id}: 'incident' must be a mapping`);
  for (const key of ["pattern", "what_went_wrong", "root_cause", "rule_established"]) {
    requireString(incident[key], `${fileName}: ${id}: incident.${key}`);
  }
  const evidence = incident["evidence"];
  ensureRecord(
    Array.isArray(evidence) && evidence.length > 0,
    `${fileName}: ${id}: incident.evidence must be a non-empty list`,
  );
  evidence.forEach((entry: unknown, index: number) => {
    ensureRecord(
      isMapping(entry),
      `${fileName}: ${id}: evidence[${index}] must be a mapping`,
    );
    requireString(entry["example"], `${fileName}: ${id}: evidence[${index}].example`);
    const entryFamily = entry["family"];
    ensureRecord(
      typeof entryFamily === "string" &&
        (ALL_FAMILIES as readonly string[]).includes(entryFamily),
      `${fileName}: ${id}: evidence[${index}].family unknown: ${JSON.stringify(entryFamily)}`,
    );
    if ("artifact" in entry) {
      const what = `${fileName}: ${id}: evidence[${index}].artifact`;
      verifyArtifact(checkRepoRelative(entry["artifact"], what), repoRoot, what);
    }
  });
  return incident;
}

function validateMatch(
  fileName: string,
  id: string,
  category: string,
  match: unknown,
  repoRoot: string | undefined,
  seenMatchers: Set<string>,
  allowedScopes: ReadonlySet<string>,
  allowedOrphanScopes: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  ensureRecord(isMapping(match), `${fileName}: ${id}: 'match' must be a mapping`);
  const matchFamily = match["family"];
  ensureRecord(
    typeof matchFamily === "string" &&
      (ALL_FAMILIES as readonly string[]).includes(matchFamily),
    `${fileName}: ${id}: match.family unknown: ${JSON.stringify(matchFamily)}`,
  );

  if (category === "duplication") {
    ensureRecord(
      matchFamily === DUPLICATION_FAMILY,
      `${fileName}: ${id}: category 'duplication' requires family ` +
        `'${DUPLICATION_FAMILY}', got ${JSON.stringify(matchFamily)}`,
    );
    const scope = requireString(match["scope"], `${fileName}: ${id}: match.scope`);
    ensureRecord(
      allowedScopes.has(scope),
      `${fileName}: ${id}: match.scope unknown: ${JSON.stringify(scope)} ` +
        `(supported: ${JSON.stringify([...allowedScopes].sort())})`,
    );
    const fingerprint = match["fingerprint"];
    ensureRecord(
      typeof fingerprint === "string" && FINGERPRINT_RE.test(fingerprint),
      `${fileName}: ${id}: match.fingerprint must be 64 lowercase hex chars (sha256)`,
    );
    // Two tombstones on one clone would make "accepted" ambiguous.
    const key = `${DUPLICATION_FAMILY}\0${scope}\0${fingerprint}`;
    ensureRecord(
      !seenMatchers.has(key),
      `${fileName}: ${id}: duplicate matcher (scope+fingerprint already tombstoned)`,
    );
    seenMatchers.add(key);
    return match;
  }

  if (category === "orphan") {
    ensureRecord(
      matchFamily === ORPHAN_FAMILY,
      `${fileName}: ${id}: category 'orphan' requires family '${ORPHAN_FAMILY}'`,
    );
    const scope = requireString(match["scope"], `${fileName}: ${id}: match.scope`);
    ensureRecord(
      allowedOrphanScopes.has(scope),
      `${fileName}: ${id}: match.scope unknown: ${JSON.stringify(scope)} ` +
        `(supported orphan scopes: ${JSON.stringify([...allowedOrphanScopes].sort())})`,
    );
    const fingerprint = match["fingerprint"];
    ensureRecord(
      typeof fingerprint === "string" && FINGERPRINT_RE.test(fingerprint),
      `${fileName}: ${id}: match.fingerprint must be 64 lowercase hex chars (sha256)`,
    );
    const key = `${ORPHAN_FAMILY}\0${scope}\0${fingerprint}`;
    ensureRecord(!seenMatchers.has(key), `${fileName}: ${id}: duplicate orphan matcher`);
    seenMatchers.add(key);
    return match;
  }

  ensureRecord(
    matchFamily !== DUPLICATION_FAMILY && matchFamily !== ORPHAN_FAMILY,
    `${fileName}: ${id}: category ${JSON.stringify(category)} must not use ` +
      `${matchFamily} (reserved for an active detector)`,
  );
  const what = `${fileName}: ${id}: match.artifact`;
  verifyArtifact(checkRepoRelative(match["artifact"], what), repoRoot, what);
  // Standing records are never matched against a finding, so several incidents
  // may share one family+artifact; only their ids must be unique.
  return match;
}

/** Validate one parsed record. Exported for defense-in-depth unit coverage. */
export function validateOne(
  fileName: string,
  raw: unknown,
  seenIds: Set<string>,
  seenMatchers: Set<string>,
  repoRoot: string | undefined,
  allowedScopes: ReadonlySet<string>,
  allowedOrphanScopes: ReadonlySet<string> = new Set(),
): Tombstone {
  ensureRecord(isMapping(raw), `${fileName}: top-level must be a mapping`);
  ensureRecord(
    raw["schema"] === SCHEMA_VERSION,
    `${fileName}: missing or unsupported schema (expected ${SCHEMA_VERSION})`,
  );
  const id = requireString(raw["id"], `${fileName}: 'id'`);
  // One record per <id>.yml, so a renamed-only-file/id template fails closed
  // and ids are structurally unique across files.
  const stem = basename(fileName, extname(fileName));
  ensureRecord(
    id === stem,
    `${fileName}: id ${JSON.stringify(id)} must match filename stem ${JSON.stringify(stem)}`,
  );
  ensureRecord(!seenIds.has(id), `${fileName}: duplicate tombstone id ${JSON.stringify(id)}`);
  seenIds.add(id);

  const status = raw["status"];
  ensureRecord(
    typeof status === "string" && (STATUSES as readonly string[]).includes(status),
    `${fileName}: ${id}: status unknown: ${JSON.stringify(status)} ` +
      `(supported: ${JSON.stringify([...STATUSES])})`,
  );
  const category = raw["category"];
  ensureRecord(
    typeof category === "string" && (CATEGORIES as readonly string[]).includes(category),
    `${fileName}: ${id}: category unknown: ${JSON.stringify(category)} ` +
      `(supported: ${JSON.stringify([...CATEGORIES])})`,
  );

  return {
    id,
    status,
    category,
    title: requireString(raw["title"], `${fileName}: ${id}: 'title'`),
    created_at: requireDateish(raw["created_at"], `${fileName}: ${id}: 'created_at'`),
    incident: validateIncident(fileName, id, raw["incident"], repoRoot),
    match: validateMatch(
      fileName,
      id,
      category,
      raw["match"],
      repoRoot,
      seenMatchers,
      allowedScopes,
      allowedOrphanScopes,
    ),
    source_file: fileName,
  };
}



/**
 * Scopes a duplication tombstone may name.
 *
 * Explicit argument first, then the scopes declared in the consumer's
 * `.slop/config.yml`. With neither, loading fails closed rather than accepting
 * any scope name: this engine ships no default layout, so an unconstrained
 * scope would let a record claim a measurement that is never taken.
 */
export function resolveAllowedScopes(
  allowedScopes: readonly string[] | undefined,
  repoRoot: string | undefined,
): ReadonlySet<string> {
  if (allowedScopes !== undefined) {
    ensureRecord(allowedScopes.length > 0, "allowedScopes must be non-empty");
    return new Set(allowedScopes);
  }
  if (repoRoot !== undefined) {
    const names = readScopeNames(join(repoRoot, ".slop", "config.yml"));
    if (names) {
      return new Set(names);
    }
  }
  throw new TombstoneConfigError(
    "cannot resolve duplication scopes: pass allowedScopes or run against a " +
      "repository whose .slop/config.yml declares scopes",
  );
}

/** Options for {@link loadTombstones}. */
export interface LoadOptions {
  repoRoot?: string;
  allowedScopes?: readonly string[];
  allowedOrphanScopes?: readonly string[];
}

function resolveAllowedOrphanScopes(options: LoadOptions): ReadonlySet<string> {
  if (options.allowedOrphanScopes !== undefined) {
    ensureRecord(options.allowedOrphanScopes.length > 0, "allowedOrphanScopes must be non-empty");
    return new Set(options.allowedOrphanScopes);
  }
  if (options.repoRoot !== undefined) {
    const config = loadConfig(join(options.repoRoot, ".slop", "config.yml"));
    const names = Object.keys(config.orphan_scopes ?? {});
    ensureRecord(names.length > 0, "repository config declares no orphan scopes");
    return new Set(names);
  }
  throw new TombstoneConfigError(
    "cannot resolve orphan scopes: pass allowedOrphanScopes or run against a configured repository",
  );
}

/**
 * Load and validate every record under `tombstonesDir`, sorted by id.
 *
 * An empty directory is a valid state (no accepted debt; everything active).
 * Scope resolution is deferred until a duplication record actually needs it, so
 * a repository with only standing records never has to declare scopes.
 */
export function loadTombstones(tombstonesDir: string, options: LoadOptions = {}): Tombstone[] {
  let isDir = false;
  try {
    isDir = statSync(tombstonesDir).isDirectory();
  } catch {
    isDir = false;
  }
  ensureRecord(isDir, `tombstones dir not found: ${tombstonesDir}`);

  const files = readdirSync(tombstonesDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();

  let scopes: ReadonlySet<string> | undefined;
  const scopesForDuplication = (): ReadonlySet<string> => {
    scopes ??= resolveAllowedScopes(options.allowedScopes, options.repoRoot);
    return scopes;
  };
  let orphanScopes: ReadonlySet<string> | undefined;
  const scopesForOrphans = (): ReadonlySet<string> => {
    orphanScopes ??= resolveAllowedOrphanScopes(options);
    return orphanScopes;
  };

  const records: Tombstone[] = [];
  const seenIds = new Set<string>();
  const seenMatchers = new Set<string>();
  for (const name of files) {
    let raw: unknown;
    try {
      raw = parseYamlStrict(readFileSync(join(tombstonesDir, name), "utf8"));
    } catch (error) {
      const detail = error instanceof YamlError ? error.message : String(error);
      throw new TombstoneConfigError(`${name}: invalid YAML: ${detail}`);
    }
    const category = isMapping(raw) ? raw["category"] : undefined;
    const allowed = category === "duplication" ? scopesForDuplication() : new Set<string>();
    const allowedOrphans = category === "orphan" ? scopesForOrphans() : new Set<string>();
    records.push(
      validateOne(name, raw, seenIds, seenMatchers, options.repoRoot, allowed, allowedOrphans),
    );
  }
  return records.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}



/** Result of applying duplication tombstones to one scope. */
export interface ScopeClassification {
  duplicates: CanonicalDuplicate[];
  activeCount: number;
  acceptedCount: number;
  unmatched: Tombstone[];
}

/**
 * Apply this scope's duplication tombstones to a canonical duplicate list.
 *
 * Pure. Each duplicate gains `status` and `tombstone`; the unmatched records
 * are the stale ones — accepted debt whose clone no longer exists. Identity is
 * the synthetic fingerprint, so classification is stable across input order and
 * unique per clone pair by construction.
 */
export function classifyDuplicates(
  duplicates: readonly CanonicalDuplicate[],
  scope: string,
  tombstones: readonly Tombstone[],
): ScopeClassification {
  const scopeRecords = tombstones.filter(
    (record) => isDuplication(record) && record.match["scope"] === scope,
  );
  const byFingerprint = new Map<string, string>();
  for (const record of scopeRecords) {
    byFingerprint.set(String(record.match["fingerprint"]), record.id);
  }

  const matched = new Set<string>();
  const annotated = duplicates.map((duplicate) => {
    const id = byFingerprint.get(duplicate.fingerprint);
    if (id !== undefined) {
      matched.add(duplicate.fingerprint);
      return { ...duplicate, status: "accepted" as const, tombstone: id };
    }
    return { ...duplicate, status: "active" as const, tombstone: null };
  });

  return {
    duplicates: annotated,
    activeCount: annotated.filter((duplicate) => duplicate.status === "active").length,
    acceptedCount: annotated.filter((duplicate) => duplicate.status === "accepted").length,
    unmatched: scopeRecords.filter(
      (record) => !matched.has(String(record.match["fingerprint"])),
    ),
  };
}

/** Records with no active detector: reported, never stale. */
export function standingTombstones(tombstones: readonly Tombstone[]): Tombstone[] {
  return tombstones.filter(isStanding);
}

/** Describe a record as an unmatched (stale) diagnostic. */
export function asUnmatched(record: Tombstone): UnmatchedTombstone {
  const scope = record.match["scope"];
  const fingerprint = record.match["fingerprint"];
  return {
    id: record.id,
    scope: typeof scope === "string" ? scope : undefined,
    fingerprint: typeof fingerprint === "string" ? fingerprint : undefined,
  };
}



/** Fields accepted by {@link addTombstone}. */
export interface AddTombstoneOptions {
  recordId: string;
  status: string;
  category: string;
  title: string;
  family: string;
  artifact?: string;
  scope?: string;
  fingerprint?: string;
  createdAt?: string;
  pattern?: string;
  whatWentWrong?: string;
  rootCause?: string;
  ruleEstablished?: string;
  example?: string;
  repoRoot?: string;
  allowedScopes?: readonly string[];
  allowedOrphanScopes?: readonly string[];
  today?: string;
}

const PLACEHOLDER = "(filled by author)";

/**
 * Write a new tombstone YAML and re-validate the directory.
 *
 * Fails closed if the id already exists or if the resulting record set does not
 * load cleanly, so a scaffold can never leave the directory unloadable.
 */
export function addTombstone(tombstonesDir: string, options: AddTombstoneOptions): string {
  mkdirSync(tombstonesDir, { recursive: true });
  const out = join(tombstonesDir, `${options.recordId}.yml`);
  if (existsSync(out)) {
    throw new TombstoneConfigError(`tombstone already exists: ${out}`);
  }

  let match: Record<string, unknown>;
  if (options.category === "duplication" || options.category === "orphan") {
    const expectedFamily =
      options.category === "duplication" ? DUPLICATION_FAMILY : ORPHAN_FAMILY;
    ensureRecord(
      options.family === expectedFamily,
      `${options.category} tombstone requires --family ${expectedFamily}`,
    );
    ensureRecord(options.scope, `${options.category} tombstone requires --scope`);
    ensureRecord(options.fingerprint, `${options.category} tombstone requires --fingerprint`);
    match = {
      family: expectedFamily,
      scope: options.scope,
      fingerprint: options.fingerprint,
    };
  } else {
    ensureRecord(
      options.artifact,
      `category ${JSON.stringify(options.category)} requires --artifact`,
    );
    match = { family: options.family, artifact: options.artifact };
  }

  const document = {
    schema: SCHEMA_VERSION,
    id: options.recordId,
    status: options.status,
    category: options.category,
    title: options.title,
    created_at: options.createdAt ?? options.today ?? new Date().toISOString().slice(0, 10),
    incident: {
      pattern: options.pattern ?? PLACEHOLDER,
      what_went_wrong: options.whatWentWrong ?? PLACEHOLDER,
      root_cause: options.rootCause ?? PLACEHOLDER,
      rule_established: options.ruleEstablished ?? PLACEHOLDER,
      evidence: [
        {
          family: options.family,
          example: options.example ?? PLACEHOLDER,
          ...(options.artifact ? { artifact: options.artifact } : {}),
        },
      ],
    },
    match,
  };
  writeFileSync(out, stringify(document, { lineWidth: 0 }), "utf8");

  const loadOptions: LoadOptions = {};
  if (options.repoRoot !== undefined) {
    loadOptions.repoRoot = options.repoRoot;
  }
  if (options.allowedScopes !== undefined) {
    loadOptions.allowedScopes = options.allowedScopes;
  }
  if (options.allowedOrphanScopes !== undefined) {
    loadOptions.allowedOrphanScopes = options.allowedOrphanScopes;
  }
  loadTombstones(tombstonesDir, loadOptions);
  return out;
}
