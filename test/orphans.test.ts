/**
 * @overview Orphan-census contract tests. ~130 lines, no public symbols.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at "reference classification"  <- core detector contract
 *   2. Read "surface kinds"                  <- files, directories, exports
 *   3. Read "determinism"                    <- stable output guarantee
 *
 *   MAIN FLOW
 *   fixture tree -> censusOrphans -> evidence classification -> report
 *
 *   PUBLIC API
 *   (none; test module)
 *
 *   INTERNALS
 *   scope, target helpers
 *
 * @exports
 * @deps bun:test, node:path, ../src/orphans.ts, ./helpers.ts
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { OrphanScopeConfig } from "../src/config.ts";
import { censusOrphans } from "../src/orphans.ts";
import { tempTree, write } from "./helpers.ts";

const scope: OrphanScopeConfig = {
  files: ["src/**/*.ts", "generated/**/*.ts"],
  directories: [],
  exported_symbols: [],
  test_files: ["test/**/*.ts"],
  generation_files: ["scripts/generate*.ts"],
  ignore: [],
};

// -- 1/3 CORE · reference classification -- <- START HERE

describe("reference classification", () => {
  test("a self-reference does not consume the file", () => {
    const root = tempTree();
    write(join(root, "src/lonely.ts"), `export const path = "src/lonely.ts";\n`);

    const report = censusOrphans(root, "production", scope, []);

    expect(report.count).toBe(1);
    expect(report.orphans[0]!.path).toBe("src/lonely.ts");
    expect(report.orphans[0]!.evidence).toEqual([
      expect.objectContaining({ source: "src/lonely.ts", reason: "self" }),
    ]);
  });

  test("a test-only reference does not consume the file", () => {
    const root = tempTree();
    write(join(root, "src/guarded.ts"), "export const guarded = true;\n");
    write(join(root, "test/guarded.test.ts"), `import "../src/guarded.ts";\n`);

    const report = censusOrphans(root, "production", scope, []);

    expect(report.count).toBe(1);
    expect(report.orphans[0]!.evidence).toEqual([
      expect.objectContaining({ source: "test/guarded.test.ts", reason: "test" }),
    ]);
  });

  test("a generation-only reference does not consume the generated file", () => {
    const root = tempTree();
    write(join(root, "generated/widget.ts"), "export const widget = true;\n");
    write(join(root, "scripts/generate-widget.ts"), `write("generated/widget.ts");\n`);

    const report = censusOrphans(root, "generated", scope, []);

    expect(report.count).toBe(1);
    expect(report.orphans[0]!.evidence).toEqual([
      expect.objectContaining({ source: "scripts/generate-widget.ts", reason: "generation" }),
    ]);
  });

  test("a genuine external consumer prevents orphan classification", () => {
    const root = tempTree();
    write(join(root, "src/used.ts"), "export const used = true;\n");
    write(join(root, "app/main.ts"), `import { used } from "../src/used.ts";\nvoid used;\n`);

    const report = censusOrphans(root, "production", scope, []);

    expect(report.count).toBe(0);
    expect(report.orphans).toEqual([]);
  });

  test("a CommonJS require is a genuine external consumer", () => {
    const root = tempTree();
    write(join(root, "src/used.ts"), "export const used = true;\n");
    write(join(root, "app/main.cjs"), `const { used } = require("../src/used");\nvoid used;\n`);
    expect(censusOrphans(root, "production", scope, []).orphans).toEqual([]);
  });
});

// -/ 1/3

// -- 2/3 HELPER · surface kinds --

describe("surface kinds", () => {
  test("directories are consumed by references to descendants", () => {
    const root = tempTree();
    write(join(root, "tools/kept/index.ts"), "export const kept = true;\n");
    write(join(root, "app/main.ts"), `import "../tools/kept/index.ts";\n`);
    const directoryScope = {
      ...scope,
      files: [],
      directories: ["tools/*"],
    };

    expect(censusOrphans(root, "tools", directoryScope, []).orphans).toEqual([]);
  });

  test("exported symbols need a symbol-level inbound import", () => {
    const root = tempTree();
    write(
      join(root, "src/api.ts"),
      "export const used = 1;\nexport function abandoned() { return 2; }\n",
    );
    write(join(root, "app/main.ts"), `import { used } from "../src/api.ts";\nvoid used;\n`);
    const symbolScope = {
      ...scope,
      files: [],
      exported_symbols: ["src/**/*.ts"],
    };

    const report = censusOrphans(root, "api", symbolScope, []);
    expect(report.orphans.map((item) => item.symbol)).toEqual(["abandoned"]);
    expect(report.orphans[0]!.kind).toBe("exported_symbol");
  });
});

// -/ 2/3

// -- 3/3 HELPER · determinism --

test("the report is byte-stable across repeated runs", () => {
  const root = tempTree();
  write(join(root, "src/b.ts"), "export const b = true;\n");
  write(join(root, "src/a.ts"), "export const a = true;\n");
  expect(JSON.stringify(censusOrphans(root, "production", scope, []))).toBe(
    JSON.stringify(censusOrphans(root, "production", scope, [])),
  );
});

test("a configured surface glob that selects nothing fails closed", () => {
  expect(() => censusOrphans(tempTree(), "production", scope, [])).toThrow(/selected zero/);
});

// -/ 3/3
