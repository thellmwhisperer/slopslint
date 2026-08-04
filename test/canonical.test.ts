/**
 * Canonicalization contract: fail closed on every structural unknown, strip
 * everything private, and produce a stable identity.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalSha256,
  canonicalizeReport,
  enforceReport,
  ppm,
} from "../src/canonical.ts";
import { SlopslintError } from "../src/errors.ts";
import { DEFAULTS, canonicalFixture, rawDuplicate, rawReport } from "./helpers.ts";

const canonical = (raw: unknown) => canonicalizeReport(raw, "python_production", DEFAULTS);

describe("validation", () => {
  test("missing statistics fails closed", () => {
    expect(() => canonical({ duplicates: [] })).toThrow(/statistics/);
  });

  test("zero lines fails closed", () => {
    expect(() => canonical(rawReport({ lines: 0, sources: 0 }))).toThrow(/zero/);
  });

  test("zero sources fails closed", () => {
    expect(() => canonical(rawReport({ sources: 0 }))).toThrow(/zero/);
  });

  test("non-integer lines fails closed", () => {
    const raw = rawReport();
    raw.statistics.lines = 32.5;
    expect(() => canonical(raw)).toThrow(/integer/);
  });

  test("missing duplicates list fails closed", () => {
    const raw = rawReport() as unknown as Record<string, unknown>;
    delete raw["duplicates"];
    expect(() => canonical(raw)).toThrow(/duplicates/);
  });

  test("missing file block fails closed", () => {
    const raw = rawReport();
    delete (raw.duplicates[0] as unknown as Record<string, unknown>)["secondFile"];
    expect(() => canonical(raw)).toThrow(/file/);
  });

  test("parent-reference path escape fails closed", () => {
    const raw = rawReport({
      duplicates: [rawDuplicate({ firstFile: { name: "../../etc/passwd", start: 1, end: 16 } })],
    });
    expect(() => canonical(raw)).toThrow(/escape/);
  });

  test("absolute path fails closed", () => {
    const raw = rawReport({
      duplicates: [rawDuplicate({ firstFile: { name: "/etc/secrets.py", start: 1, end: 16 } })],
    });
    expect(() => canonical(raw)).toThrow(/escape/);
  });

  test("a clean tree is valid, not the zero-scan failure", () => {
    const report = canonical(
      rawReport({ duplicates: [], sources: 2, lines: 32, duplicatedLines: 0, clones: 0 }),
    );
    expect(report.duplicates).toEqual([]);
    expect(report.statistics.clones).toBe(0);
    expect(report.statistics.duplicated_lines_ppm).toBe(0);
    expect(report.statistics.total_sources).toBe(2);
  });

  test("duplicated lines exceeding total fails closed", () => {
    expect(() => canonical(rawReport({ lines: 10, duplicatedLines: 99 }))).toThrow(/exceed/);
  });

  test("negative counters fail closed", () => {
    expect(() => canonical(rawReport({ duplicatedLines: -1 }))).toThrow(/non-negative/);
    expect(() => canonical(rawReport({ clones: -1, duplicates: [] }))).toThrow(/non-negative/);
  });

  test("reversed range fails closed", () => {
    const raw = rawReport({
      duplicates: [rawDuplicate({ firstFile: { name: "py/a.py", start: 50, end: 5 } })],
    });
    expect(() => canonical(raw)).toThrow(/reversed line range/);
  });

  test("non-positive lines or tokens fail closed", () => {
    expect(() => canonical(rawReport({ duplicates: [rawDuplicate({ tokens: 0 })] }))).toThrow(
      /tokens/,
    );
    expect(() => canonical(rawReport({ duplicates: [rawDuplicate({ lines: 0 })] }))).toThrow(
      /lines/,
    );
  });

  test("clone count disagreeing with the list fails closed", () => {
    expect(() => canonical(rawReport({ clones: 5 }))).toThrow(/clones/);
  });
});

describe("normalization and privacy", () => {
  test("source fragments and detector timestamps never survive", () => {
    const raw = rawReport() as unknown as Record<string, unknown>;
    (raw["duplicates"] as Record<string, unknown>[])[0]!["fragment"] =
      "SENSITIVE SOURCE SNIPPET THAT MUST NOT LEAK";
    (raw["statistics"] as Record<string, unknown>)["detectionDate"] = "2026-07-15T01:25:51.509Z";
    const blob = JSON.stringify(canonical(raw));
    expect(blob).not.toContain("SENSITIVE SOURCE SNIPPET");
    expect(blob).not.toContain("detectionDate");
    expect(blob).not.toContain("fragment");
  });

  test("totals are integers and the ratio is recomputed", () => {
    const report = canonical(rawReport());
    for (const key of [
      "total_sources",
      "total_lines",
      "duplicated_lines",
      "clones",
      "duplicated_lines_ppm",
    ] as const) {
      expect(Number.isInteger(report.statistics[key])).toBe(true);
    }
    // 15/32 -> ceil(1e6 * 15/32) = 468750
    expect(report.statistics.duplicated_lines_ppm).toBe(468750);
    expect(JSON.stringify(report.statistics)).not.toContain("percentage");
  });

  test.each([
    [1, 3, 333334],
    [1, 7, 142858],
    [2, 3, 666667],
    [5, 6, 833334],
    [1, 4, 250000],
    [0, 32, 0],
    [32, 32, 1_000_000],
  ])("ppm(%i/%i) is the exact integer ceiling", (dup, lines, expected) => {
    expect(ppm(dup, lines)).toBe(expected);
    const report = canonical(
      rawReport({ duplicates: [], sources: 2, lines, duplicatedLines: dup, clones: 0 }),
    );
    expect(report.statistics.duplicated_lines_ppm).toBe(expected);
  });

  test("fingerprint is stable and independent of endpoint order", () => {
    const straight = canonical(rawReport());
    const swapped = canonical(
      rawReport({
        duplicates: [
          rawDuplicate({
            firstFile: { name: "py/b.py", start: 1, end: 16 },
            secondFile: { name: "py/a.py", start: 1, end: 16 },
          }),
        ],
      }),
    );
    expect(straight.duplicates[0]!.fingerprint).toBe(swapped.duplicates[0]!.fingerprint);
    expect(straight.duplicates[0]!.fingerprint).toHaveLength(64);
  });

  test("every structural component moves the fingerprint", () => {
    const fingerprintOf = (duplicate: ReturnType<typeof rawDuplicate>) =>
      canonical(rawReport({ duplicates: [duplicate] })).duplicates[0]!.fingerprint;
    const base = fingerprintOf(rawDuplicate());
    const variants = [
      rawDuplicate({ secondFile: { name: "py/e.py", start: 1, end: 16 } }),
      rawDuplicate({ secondFile: { name: "py/b.py", start: 7, end: 22 } }),
      rawDuplicate({ lines: 12 }),
      rawDuplicate({ tokens: 99 }),
    ];
    for (const variant of variants) {
      expect(fingerprintOf(variant)).not.toBe(base);
    }
    expect(fingerprintOf(rawDuplicate())).toBe(base);
  });

  test("the canonical first endpoint is the lower one", () => {
    const report = canonical(
      rawReport({
        duplicates: [
          rawDuplicate({
            firstFile: { name: "py/z.py", start: 9, end: 24 },
            secondFile: { name: "py/a.py", start: 1, end: 16 },
          }),
        ],
      }),
    );
    expect(report.duplicates[0]!.first.path).toBe("py/a.py");
    expect(report.duplicates[0]!.second.path).toBe("py/z.py");
  });

  test("identical input yields an identical canonical hash", () => {
    const raw = () =>
      rawReport({
        duplicates: [
          rawDuplicate(),
          rawDuplicate({
            firstFile: { name: "py/c.py", start: 5, end: 20 },
            secondFile: { name: "py/d.py", start: 9, end: 24 },
          }),
        ],
        sources: 4,
        lines: 64,
        duplicatedLines: 30,
        clones: 2,
      });
    expect(canonicalSha256(canonical(raw()))).toBe(canonicalSha256(canonical(raw())));
  });

  test("detector input order does not change the hash", () => {
    const pair = () => [
      rawDuplicate({
        firstFile: { name: "py/a.py", start: 1, end: 10 },
        secondFile: { name: "py/b.py", start: 5, end: 14 },
        lines: 10,
        tokens: 50,
      }),
      rawDuplicate({
        firstFile: { name: "py/a.py", start: 1, end: 20 },
        secondFile: { name: "py/b.py", start: 5, end: 24 },
        lines: 20,
        tokens: 60,
      }),
    ];
    const forward = pair();
    const reversed = pair().reverse();
    const totals = { sources: 2, lines: 100, duplicatedLines: 30, clones: 2 };
    expect(canonicalSha256(canonical(rawReport({ duplicates: forward, ...totals })))).toBe(
      canonicalSha256(canonical(rawReport({ duplicates: reversed, ...totals }))),
    );
  });
});

describe("enforcement", () => {
  const classified = (scope: string, active: number, unmatched: unknown[] = []) => ({
    ...canonicalFixture(scope, []),
    statistics: { ...canonicalFixture(scope, []).statistics, active_clones: active },
    diagnostics: { unmatched_tombstones: unmatched as never[] },
  });

  test.each([
    [36, 36],
    [0, 0],
    [5, 5],
  ])("active %i against ceiling %i passes", (active, ceiling) => {
    expect(() => enforceReport(classified("python_production", active), ceiling)).not.toThrow();
  });

  test("a regression fails closed", () => {
    expect(() => enforceReport(classified("python_production", 40), 36)).toThrow(/exceeding/);
  });

  test("an unrecorded improvement fails closed", () => {
    expect(() => enforceReport(classified("python_production", 32), 36)).toThrow(/below/);
  });

  test("stale tombstones fail closed and list every id", () => {
    const stale = [
      { id: "T-AAA", scope: "python_production", fingerprint: "0".repeat(64) },
      { id: "T-BBB", scope: "python_production", fingerprint: "1".repeat(64) },
    ];
    try {
      enforceReport(classified("python_production", 36, stale), 36);
      throw new Error("expected enforcement to fail");
    } catch (error) {
      const message = (error as SlopslintError).message;
      expect(message).toContain("2 stale");
      expect(message).toContain("T-AAA");
      expect(message).toContain("T-BBB");
    }
  });

  test("the improvement message names the custom ceilings path", () => {
    expect(() => enforceReport(classified("python_production", 30), 36, "custom/path.yml")).toThrow(
      /custom\/path\.yml/,
    );
  });

  test("the message names only the offending scope", () => {
    try {
      enforceReport(classified("python_tests_fixtures", 150), 128);
      throw new Error("expected enforcement to fail");
    } catch (error) {
      const message = (error as SlopslintError).message;
      expect(message).toContain("python_tests_fixtures");
      expect(message).not.toContain("python_production");
    }
  });
});
