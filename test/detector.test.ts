/**
 * Detector contract, exercised against the real linked jscpd libraries.
 *
 * Two properties here replace apparatus the Python predecessor needed because
 * it shelled out to a separately installed binary:
 *
 *   * scope independence used to need a glob-prefix guard, because that
 *     detector's `*` crossed `/`. `fast-glob` matches basenames, so the
 *     property is proved directly on a `test_`-named directory;
 *   * clone ranges used to be trusted from the subprocess's JSON. The linked
 *     `@jscpd/core` assembly emits ranges that run backwards, so the assembly
 *     is owned here and the monotonic invariant is pinned.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { canonicalSha256, canonicalizeReport } from "../src/canonical.ts";
import { scanScope, selectFiles } from "../src/detector.ts";
import { DEFAULTS, DUP_BLOCK, tempTree, write } from "./helpers.ts";

const PRODUCTION = {
  scan_path: "py",
  pattern: "**/*.py",
  ignore: ["**/test_*.py", "**/conftest.py"],
};
const TESTS = { scan_path: "py", pattern: "**/{test_*,conftest}.py", ignore: [] };
const NO_IGNORE: string[] = [];

/** A tree with `py/<name>` files holding the given bodies. */
function tree(files: Record<string, string>): string {
  const root = tempTree();
  for (const [name, body] of Object.entries(files)) {
    write(join(root, "py", name), body);
  }
  return root;
}

const scan = (root: string, scope: typeof PRODUCTION, ignore: string[] = NO_IGNORE) =>
  scanScope("s", scope, DEFAULTS, ignore, root);

describe("detection", () => {
  test("an exact clone across two files is found", () => {
    const root = tree({ "a.py": DUP_BLOCK, "b.py": DUP_BLOCK });
    const report = scan(root, PRODUCTION);
    expect(report.statistics.clones).toBeGreaterThanOrEqual(1);
    expect(report.statistics.sources).toBe(2);
    expect(report.statistics.duplicatedLines).toBeGreaterThanOrEqual(5);
  });

  test("a tree with no duplication reports zero clones", () => {
    const root = tree({ "a.py": DUP_BLOCK, "b.py": "def unrelated():\n    return 1\n" });
    const report = scan(root, PRODUCTION);
    expect(report.statistics.clones).toBe(0);
    expect(report.duplicates).toEqual([]);
  });

  test("ignored subtrees never reach the report", () => {
    const root = tree({ "a.py": DUP_BLOCK, "gen/out.py": DUP_BLOCK });
    const report = scan(root, { ...PRODUCTION, ignore: ["**/gen/**"] });
    const paths = report.duplicates.flatMap((d) => [d.firstFile.name, d.secondFile.name]);
    expect(paths.every((path) => !path.includes("gen"))).toBe(true);
  });

  test("repeated runs over one tree are byte-identical", () => {
    const root = tree({ "a.py": DUP_BLOCK, "b.py": DUP_BLOCK });
    const first = canonicalizeReport(scan(root, PRODUCTION), "s", DEFAULTS);
    const second = canonicalizeReport(scan(root, PRODUCTION), "s", DEFAULTS);
    expect(canonicalSha256(first)).toBe(canonicalSha256(second));
  });

  test("paths are repository-relative, never absolute", () => {
    const root = tree({ "pkg/a.py": DUP_BLOCK, "pkg/b.py": DUP_BLOCK });
    const report = scan(root, PRODUCTION);
    const paths = new Set(report.duplicates.flatMap((d) => [d.firstFile.name, d.secondFile.name]));
    expect([...paths].sort()).toEqual(["py/pkg/a.py", "py/pkg/b.py"]);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  test("no source text survives into the report", () => {
    const root = tree({ "a.py": DUP_BLOCK, "b.py": DUP_BLOCK });
    const blob = JSON.stringify(scan(root, PRODUCTION));
    expect(blob).not.toContain("compute_checksum");
    expect(blob).not.toContain("fragment");
  });

  test("a missing scan path fails closed", () => {
    expect(() => scan(tempTree(), PRODUCTION)).toThrow(/does not exist/);
  });

  test("an unsupported mode fails closed", () => {
    const root = tree({ "a.py": DUP_BLOCK });
    expect(() =>
      scanScope("s", PRODUCTION, { ...DEFAULTS, mode: "bogus" }, NO_IGNORE, root),
    ).toThrow();
  });
});

describe("clone range invariants", () => {
  /**
   * Regression for the linked detector's assembly defect.
   *
   * `@jscpd/core@4.2.5` extends an open clone with whatever frame its store
   * last returned, so a hash hit that jumps backwards produces `end < start`.
   * Every emitted range must run forwards, whatever the file contains.
   */
  test("every emitted range runs forwards", () => {
    // Repeated near-identical blocks in one file drive the store to return
    // hits from several earlier positions: the shape that broke upstream.
    const body = Array.from({ length: 6 }, (_, index) =>
      DUP_BLOCK.replace(/result/g, `result_${index % 2}`),
    ).join("\n\n");
    const root = tree({ "repeats.py": body, "other.py": body });
    const report = scan(root, PRODUCTION);
    expect(report.duplicates.length).toBeGreaterThan(0);
    for (const duplicate of report.duplicates) {
      expect(duplicate.firstFile.end).toBeGreaterThanOrEqual(duplicate.firstFile.start);
      expect(duplicate.secondFile.end).toBeGreaterThanOrEqual(duplicate.secondFile.start);
      expect(duplicate.lines).toBeGreaterThan(0);
      expect(duplicate.tokens).toBeGreaterThan(0);
    }
    // ...and the canonicalizer therefore accepts the whole scan.
    expect(() => canonicalizeReport(report, "s", DEFAULTS)).not.toThrow();
  });

  test("the de-duplicated line count never exceeds the lines scanned", () => {
    const body = `${DUP_BLOCK}\n${DUP_BLOCK}\n${DUP_BLOCK}`;
    const root = tree({ "a.py": body, "b.py": body, "c.py": body });
    const report = scan(root, PRODUCTION);
    expect(report.statistics.clones).toBeGreaterThanOrEqual(2);
    expect(report.statistics.duplicatedLines).toBeLessThanOrEqual(report.statistics.lines);
  });
});

describe("scope independence", () => {
  /**
   * The two scopes are only independent if the globs classify by BASENAME.
   * A directory named like a test file is the case that breaks a detector
   * whose wildcards cross separators: production files under `test_data/`
   * would leave the production scope and hide inside the tests scope.
   */
  test("a test_-named directory keeps its files in the production scope", () => {
    const root = tree({
      "test_a.py": DUP_BLOCK,
      "test_data/prod_x.py": DUP_BLOCK,
      "test_data/prod_y.py": DUP_BLOCK,
    });

    const production = selectFiles(PRODUCTION, DEFAULTS, NO_IGNORE, root);
    expect(production).toEqual(["py/test_data/prod_x.py", "py/test_data/prod_y.py"]);

    const tests = selectFiles(TESTS, DEFAULTS, NO_IGNORE, root);
    expect(tests).toEqual(["py/test_a.py"]);
  });

  test("a mid-glob wildcard does not cross separators either", () => {
    const root = tree({ "test_x/deep/helpers.py": DUP_BLOCK, "test_y/helpers.py": DUP_BLOCK });
    const selected = selectFiles(
      { scan_path: "py", pattern: "**/test_*/helpers.py", ignore: [] },
      DEFAULTS,
      NO_IGNORE,
      root,
    );
    expect(selected).toEqual(["py/test_y/helpers.py"]);
  });

  test("the tests scope brace group ORs both basenames", () => {
    const root = tree({
      "test_a.py": DUP_BLOCK,
      "test_b.py": DUP_BLOCK,
      "conftest.py": DUP_BLOCK,
      "prod.py": DUP_BLOCK,
    });
    const report = scan(root, TESTS);
    expect(report.statistics.sources).toBe(3);
    const paths = new Set(report.duplicates.flatMap((d) => [d.firstFile.name, d.secondFile.name]));
    expect([...paths].sort()).toEqual(["py/conftest.py", "py/test_a.py", "py/test_b.py"]);
  });

  test("the two scopes partition the tree with no overlap", () => {
    const root = tree({
      "prod.py": DUP_BLOCK,
      "test_a.py": DUP_BLOCK,
      "conftest.py": DUP_BLOCK,
      "pkg/test_data/inner.py": DUP_BLOCK,
    });
    const production = new Set(selectFiles(PRODUCTION, DEFAULTS, NO_IGNORE, root));
    const tests = new Set(selectFiles(TESTS, DEFAULTS, NO_IGNORE, root));
    expect([...production].some((path) => tests.has(path))).toBe(false);
    expect([...production].sort()).toEqual(["py/pkg/test_data/inner.py", "py/prod.py"]);
    expect([...tests].sort()).toEqual(["py/conftest.py", "py/test_a.py"]);
  });

  test("non-matching formats are never scanned", () => {
    const root = tree({ "a.py": DUP_BLOCK, "notes.md": DUP_BLOCK });
    expect(selectFiles(PRODUCTION, DEFAULTS, NO_IGNORE, root)).toEqual(["py/a.py"]);
  });
});
