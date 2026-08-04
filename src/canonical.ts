/**
 * Canonicalization: raw detector output into a privacy-safe, stable report.
 *
 * Pure functions — no filesystem, no subprocess. The canonical form carries
 * integer totals, repository-relative paths and ranges, and a synthetic
 * per-clone fingerprint. It never carries source snippets, detector timestamps,
 * floating percentages, or absolute paths, so a report can be pasted into an
 * issue without leaking the code it measured.
 *
 * Its SHA-256 is stable across repeated runs on one immutable tree: endpoints
 * are ordered, duplicates are sorted on every component, and the ratio is exact
 * integer arithmetic.
 */
import { createHash } from "node:crypto";
import type { ScanDefaults } from "./config.ts";
import type { RawDuplicate, RawReport } from "./detector.ts";
import { SlopslintError, asInteger, ensure } from "./errors.ts";
import { DETECTOR_NAME, DETECTOR_VERSION } from "./version.ts";

/** One endpoint of a canonical clone pair. */
export interface CanonicalEndpoint {
  path: string;
  start: number;
  end: number;
}

/** One canonical clone pair. */
export interface CanonicalDuplicate {
  lines: number;
  tokens: number;
  first: CanonicalEndpoint;
  second: CanonicalEndpoint;
  fingerprint: string;
  status?: "active" | "accepted";
  tombstone?: string | null;
}

/** Canonical statistics for one scope. */
export interface CanonicalStatistics {
  total_sources: number;
  total_lines: number;
  duplicated_lines: number;
  clones: number;
  duplicated_lines_ppm: number;
  active_clones?: number;
  accepted_clones?: number;
}

/** A canonical scope report. */
export interface CanonicalReport {
  schema: 1;
  detector: { name: string; version: string };
  scope: string;
  config: ScanDefaults;
  statistics: CanonicalStatistics;
  duplicates: CanonicalDuplicate[];
  diagnostics?: { unmatched_tombstones: UnmatchedTombstone[] };
}

/** A duplication tombstone that matched no current finding. */
export interface UnmatchedTombstone {
  id: string;
  scope: string | undefined;
  fingerprint: string | undefined;
}

/**
 * Reject a detector-emitted path that is absolute or escapes the repository.
 *
 * The detector is configured with repository-relative scan paths, so anything
 * else means the measurement left the tree it claimed to measure.
 */
export function repoRelativePath(name: unknown): string {
  ensure(typeof name === "string" && name.length > 0, "clone file name missing");
  ensure(
    !name.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(name),
    `path escape rejected (absolute): ${name}`,
  );
  ensure(
    !name.split(/[\\/]/).includes(".."),
    `path escape rejected (..): ${name}`,
  );
  return name;
}

/** Deterministic JSON: keys sorted at every level, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/**
 * Stable clone identity that carries no source content.
 *
 * The two endpoints are ordered before hashing, so identity does not depend on
 * which side the detector listed first.
 */
export function fingerprint(
  first: CanonicalEndpoint,
  second: CanonicalEndpoint,
  lines: number,
  tokens: number,
): string {
  const pair = [first, second]
    .map((endpoint) => [endpoint.path, endpoint.start, endpoint.end] as const)
    .sort((left, right) =>
      canonicalJson(left) < canonicalJson(right)
        ? -1
        : canonicalJson(left) > canonicalJson(right)
          ? 1
          : 0,
    );
  return createHash("sha256")
    .update(canonicalJson({ pair, lines, tokens }), "utf8")
    .digest("hex");
}

/** Deterministic canonical bytes for a report. */
export function serializeCanonical(report: CanonicalReport): string {
  return canonicalJson(report);
}

/** Stable identity of a canonical report, for repeated-run proof. */
export function canonicalSha256(report: CanonicalReport): string {
  return createHash("sha256").update(serializeCanonical(report), "utf8").digest("hex");
}

/**
 * Duplication ratio in parts per million, exact integer arithmetic.
 *
 * Ceiling, not floor or round, so any nonzero duplication reports as at least
 * 1 ppm and no gate can be satisfied by rounding debt away. An exact integral
 * quotient is not bumped.
 */
export function ppm(duplicatedLines: number, totalLines: number): number {
  const numerator = BigInt(1_000_000) * BigInt(duplicatedLines);
  const denominator = BigInt(totalLines);
  return Number((numerator + denominator - 1n) / denominator);
}

function orderedEndpoints(
  left: CanonicalEndpoint,
  right: CanonicalEndpoint,
): [CanonicalEndpoint, CanonicalEndpoint] {
  const key = (endpoint: CanonicalEndpoint): string =>
    canonicalJson([endpoint.path, endpoint.start, endpoint.end]);
  return key(left) <= key(right) ? [left, right] : [right, left];
}

function canonicalizeDuplicate(entry: unknown): CanonicalDuplicate {
  ensure(
    typeof entry === "object" && entry !== null,
    "duplicate entry must be an object",
  );
  const raw = entry as Partial<RawDuplicate>;
  ensure(
    typeof raw.firstFile === "object" &&
      raw.firstFile !== null &&
      typeof raw.secondFile === "object" &&
      raw.secondFile !== null,
    "duplicate missing file block",
  );
  const firstPath = repoRelativePath(raw.firstFile.name);
  const secondPath = repoRelativePath(raw.secondFile.name);
  const firstStart = asInteger(raw.firstFile.start, "firstFile.start");
  const firstEnd = asInteger(raw.firstFile.end, "firstFile.end");
  const secondStart = asInteger(raw.secondFile.start, "secondFile.start");
  const secondEnd = asInteger(raw.secondFile.end, "secondFile.end");
  const lines = asInteger(raw.lines, "duplicate.lines");
  const tokens = asInteger(raw.tokens, "duplicate.tokens");

  ensure(lines > 0, "duplicate.lines must be positive");
  ensure(tokens > 0, "duplicate.tokens must be positive");
  ensure(firstStart >= 1 && secondStart >= 1, "range start must be >= 1");
  ensure(
    firstEnd >= firstStart && secondEnd >= secondStart,
    `reversed line range (end < start): ${firstPath}:${firstStart}-${firstEnd}, ` +
      `${secondPath}:${secondStart}-${secondEnd}`,
  );

  const [first, second] = orderedEndpoints(
    { path: firstPath, start: firstStart, end: firstEnd },
    { path: secondPath, start: secondStart, end: secondEnd },
  );
  return {
    lines,
    tokens,
    first,
    second,
    fingerprint: fingerprint(first, second, lines, tokens),
  };
}

function duplicateSortKey(duplicate: CanonicalDuplicate): string {
  return canonicalJson([
    duplicate.first.path,
    duplicate.first.start,
    duplicate.first.end,
    duplicate.second.path,
    duplicate.second.start,
    duplicate.second.end,
    duplicate.lines,
    duplicate.tokens,
    duplicate.fingerprint,
  ]);
}

/**
 * Validate and canonicalize a raw scope report.
 *
 * Every structural unknown fails closed: zero scanned files or lines, a
 * non-integer counter, a clone count that disagrees with the duplicate list, a
 * reversed range, or a path that escapes the repository.
 */
export function canonicalizeReport(
  raw: unknown,
  scope: string,
  defaults: ScanDefaults,
): CanonicalReport {
  ensure(typeof raw === "object" && raw !== null, "report must be an object");
  const report = raw as Partial<RawReport>;
  const statistics = report.statistics;
  ensure(
    typeof statistics === "object" && statistics !== null,
    "report missing statistics.total",
  );

  const sources = asInteger(statistics.sources, "total.sources");
  const lines = asInteger(statistics.lines, "total.lines");
  const duplicatedLines = asInteger(statistics.duplicatedLines, "total.duplicatedLines");
  const clones = asInteger(statistics.clones, "total.clones");

  ensure(sources > 0 && lines > 0, "zero scanned files/lines (sources/lines == 0)");
  ensure(duplicatedLines >= 0, "duplicatedLines must be non-negative");
  ensure(clones >= 0, "clones must be non-negative");
  // The duplicated-line count is a de-duplicated union of covered (file, line)
  // pairs, so it can never legitimately exceed the lines actually scanned --
  // not even when one line participates in several overlapping clone pairs.
  ensure(
    duplicatedLines <= lines,
    `duplicatedLines (${duplicatedLines}) exceed total lines (${lines})`,
  );

  const duplicates = report.duplicates;
  ensure(Array.isArray(duplicates), "report missing duplicates list");
  ensure(
    clones === duplicates.length,
    `total.clones (${clones}) does not match duplicates (${duplicates.length})`,
  );

  const canonicalDuplicates = duplicates.map(canonicalizeDuplicate);
  canonicalDuplicates.sort((left, right) => {
    const leftKey = duplicateSortKey(left);
    const rightKey = duplicateSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return {
    schema: 1,
    detector: { name: DETECTOR_NAME, version: DETECTOR_VERSION },
    scope,
    config: {
      format: defaults.format,
      mode: defaults.mode,
      min_lines: defaults.min_lines,
      min_tokens: defaults.min_tokens,
    },
    statistics: {
      total_sources: sources,
      total_lines: lines,
      duplicated_lines: duplicatedLines,
      clones,
      duplicated_lines_ppm: ppm(duplicatedLines, lines),
    },
    duplicates: canonicalDuplicates,
  };
}

/**
 * Fail closed when active clones violate the committed ceiling.
 *
 * The ratchet is genuinely monotonic:
 *   - `active > ceiling` — regression, duplication debt increased;
 *   - `active < ceiling` — improvement not recorded, the ceiling must be
 *     lowered in the same change;
 *   - `active === ceiling` — pass.
 *
 * A stale duplication tombstone also fails: accepted debt that has since been
 * paid must have its record removed, or the accepted set silently grows.
 */
export function enforceReport(
  classified: CanonicalReport,
  ceilingValue: number,
  ceilingConfigPath?: string,
): void {
  const scope = classified.scope;
  const active = classified.statistics.active_clones ?? 0;
  const unmatched = classified.diagnostics?.unmatched_tombstones ?? [];
  const configHint = ceilingConfigPath ? ` in ${ceilingConfigPath}` : "";

  if (unmatched.length > 0) {
    const ids = unmatched.map((record) => record.id).sort();
    throw new SlopslintError(
      `Slopslint enforcement FAILED: ${scope} has ${unmatched.length} stale ` +
        `tombstone(s) ${JSON.stringify(ids)}. Every duplication tombstone must ` +
        `match a current finding; remove or update unmatched tombstones${configHint}.`,
    );
  }

  if (active > ceilingValue) {
    throw new SlopslintError(
      `Slopslint enforcement FAILED: ${scope} has ${active} active clones, ` +
        `exceeding the committed ceiling of ${ceilingValue}. ` +
        `This is a regression - duplication debt increased.`,
    );
  }

  if (active < ceilingValue) {
    const ceilingFile = ceilingConfigPath ?? ".slop/ceilings.yml";
    throw new SlopslintError(
      `Slopslint enforcement FAILED: ${scope} has ${active} active clones, ` +
        `below the committed ceiling of ${ceilingValue}. Debt has decreased - ` +
        `edit ${ceilingFile}: set scopes.${scope}.active_clones_ceiling from ` +
        `${ceilingValue} to ${active} so the base branch records the ` +
        `improvement. The ratchet is monotonic: the ceiling can only go down.`,
    );
  }
}
