/** Shared fixtures for the contract tests. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RawDuplicate, RawReport } from "../src/detector.ts";

/** Detection defaults used by every fixture. */
export const DEFAULTS = {
  format: "python",
  mode: "mild",
  min_lines: 5,
  min_tokens: 50,
};

/**
 * A duplicated block well above the 50-token / 5-line floor, so the detector
 * counts the files as sources and reports the clone.
 */
export const DUP_BLOCK = `def compute_checksum(data):
    result = 0
    for byte in data:
        result = (result * 31 + byte) & 0xFFFFFFFF
    return result


def normalize_path(path):
    parts = path.split("/")
    resolved = []
    for part in parts:
        if part == "..":
            resolved.pop()
        elif part != ".":
            resolved.append(part)
    return "/".join(resolved)
`;

/**
 * A neutral-named temporary directory.
 *
 * Deliberately not named after the test: a `test_`-prefixed temp directory
 * would sit inside the very scope boundary several of these tests measure.
 */
export function tempTree(prefix = "sloptest-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write `body` to `path`, creating parent directories. */
export function write(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

/** A raw duplicate entry with overridable fields. */
export function rawDuplicate(overrides: Partial<RawDuplicate> = {}): RawDuplicate {
  const lines = overrides.lines ?? 16;
  const firstStart = overrides.firstFile?.start ?? 1;
  const secondStart = overrides.secondFile?.start ?? 1;
  return {
    lines,
    tokens: overrides.tokens ?? 81,
    firstFile: {
      name: overrides.firstFile?.name ?? "py/a.py",
      start: firstStart,
      end: overrides.firstFile?.end ?? firstStart + lines - 1,
    },
    secondFile: {
      name: overrides.secondFile?.name ?? "py/b.py",
      start: secondStart,
      end: overrides.secondFile?.end ?? secondStart + lines - 1,
    },
  };
}

/** A raw scope report with overridable totals. */
export function rawReport(
  overrides: {
    duplicates?: RawDuplicate[];
    sources?: number;
    lines?: number;
    duplicatedLines?: number;
    clones?: number;
  } = {},
): RawReport {
  const duplicates = overrides.duplicates ?? [rawDuplicate()];
  return {
    statistics: {
      sources: overrides.sources ?? 2,
      lines: overrides.lines ?? 32,
      duplicatedLines: overrides.duplicatedLines ?? 15,
      clones: overrides.clones ?? duplicates.length,
    },
    duplicates,
  };
}

/** A canonical S1 report shape, as `classifyReport` consumes it. */
export function canonicalFixture(scope: string, fingerprints: string[]) {
  return {
    schema: 1 as const,
    detector: { name: "jscpd", version: "4.2.5" },
    scope,
    config: { ...DEFAULTS },
    statistics: {
      total_sources: 2,
      total_lines: 100,
      duplicated_lines: 10,
      clones: fingerprints.length,
      duplicated_lines_ppm: 100000,
    },
    duplicates: fingerprints.map((fingerprint) => ({
      lines: 7,
      tokens: 60,
      first: { path: "py/a.py", start: 1, end: 7 },
      second: { path: "py/b.py", start: 1, end: 7 },
      fingerprint,
    })),
  };
}

/** A deterministic 64-hex fingerprint, distinct per `n`. */
export function fp(n: number): string {
  return n.toString(16).padStart(60, "0") + "cafe";
}

/** A minimal `.slop/config.yml` body. */
export function configYaml(extra = ""): string {
  return `schema: 1
detector: {name: jscpd, version: "4.2.5"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes:
  python_production: {scan_path: py, pattern: "**/*.py", ignore: ["**/test_*.py", "**/conftest.py"]}
  python_tests_fixtures: {scan_path: py, pattern: "**/{test_*,conftest}.py"}
${extra}`;
}

/** A valid standing (alien_code) record. */
export function alienRecord(id = "T-ALIEN-X"): Record<string, unknown> {
  return {
    schema: 1,
    id,
    status: "accepted",
    category: "alien_code",
    title: "t",
    created_at: "2026-07-15",
    incident: {
      pattern: "p",
      what_went_wrong: "w",
      root_cause: "r",
      rule_established: "e",
      evidence: [{ example: "x", family: "runtime_dependency", artifact: "marker.txt" }],
    },
    match: { family: "runtime_dependency", artifact: "marker.txt" },
  };
}

/** A valid duplication record body. */
export function duplicationRecord(id: string, scope: string, fingerprint: string): string {
  return `schema: 1
id: ${id}
status: accepted
category: duplication
title: "accepted clone"
created_at: 2026-07-15
incident:
  pattern: p
  what_went_wrong: w
  root_cause: r
  rule_established: e
  evidence:
    - example: ex
      family: clone_fingerprint
match:
  family: clone_fingerprint
  scope: ${scope}
  fingerprint: ${fingerprint}
`;
}
