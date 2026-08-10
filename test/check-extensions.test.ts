/**
 * @overview End-to-end orphan and claims integration. ~150 lines, no public symbols.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at "opt-in output"      <- compatibility and report shape
 *   2. Read "orphan enforcement"     <- ceilings and tombstones
 *
 *   MAIN FLOW
 *   consumer repo -> runCheck -> classify -> enforce
 *
 *   PUBLIC API
 *   (none; test module)
 *
 *   INTERNALS
 *   extensionRepo, orphanRecord
 *
 * @exports
 * @deps bun:test, node:path, ../src/check.ts, ./helpers.ts
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCheck, type ExtendedSummary } from "../src/check.ts";
import { DUP_BLOCK, configYaml, tempTree, write } from "./helpers.ts";

function extensionRepo(): string {
  const root = tempTree();
  write(
    join(root, ".slop/config.yml"),
    configYaml(`orphan_scopes:
  tools:
    files: ["tools/**/*.ts"]
    test_files: ["test/**/*.ts"]
    generation_files: ["scripts/generate*.ts"]
claims:
  file: .slop/claims.yml
  surfaces:
    commands:
      files: ["bin/*"]
`),
  );
  write(join(root, ".slop/tombstones/.keep"), "");
  write(join(root, ".slop/claims.yml"), `schema: 1
claims:
  bin/tool:
    contract: {file: docs/contracts.md, item: CLI-TOOL}
`);
  write(join(root, "docs/contracts.md"), "CLI-TOOL: public tool\n");
  write(join(root, "bin/tool"), "#!/bin/sh\n");
  write(join(root, "tools/orphan.ts"), "export const orphan = true;\n");
  write(join(root, "test/orphan.test.ts"), `import "../tools/orphan.ts";\n`);
  write(join(root, "py/a.py"), DUP_BLOCK);
  write(join(root, "py/b.py"), DUP_BLOCK);
  write(join(root, "py/test_a.py"), DUP_BLOCK);
  write(join(root, "py/test_b.py"), DUP_BLOCK);
  return root;
}

function orphanRecord(id: string, fingerprint: string): string {
  return `schema: 1
id: ${id}
status: accepted
category: orphan
title: "consciously kept orphan"
created_at: 2026-08-10
incident:
  pattern: unconsumed surface
  what_went_wrong: no production consumer
  root_cause: intentionally retained
  rule_established: record the exception
  evidence:
    - example: tools/orphan.ts
      family: orphan_fingerprint
match:
  family: orphan_fingerprint
  scope: tools
  fingerprint: ${fingerprint}
`;
}

// -- 1/2 CORE · opt-in output -- <- START HERE

describe("opt-in output", () => {
  test("configured checks add orphan evidence and verified claims", () => {
    const summary = runCheck({ repoRoot: extensionRepo() }) as ExtendedSummary;
    expect(summary.orphan_scopes).toHaveLength(1);
    expect(summary.orphan_scopes![0]!.count).toBe(1);
    expect(summary.orphan_scopes![0]!.orphans[0]).toEqual(
      expect.objectContaining({
        scope: "tools",
        path: "tools/orphan.ts",
        evidence: [expect.objectContaining({ reason: "test" })],
      }),
    );
    expect(summary.claims).toEqual({
      count: 1,
      surfaces: [
        {
          scope: "commands",
          kind: "file",
          surface: "bin/tool",
          contract: { file: "docs/contracts.md", item: "CLI-TOOL" },
        },
      ],
    });
  });

  test("unconfigured repositories keep the legacy array output", () => {
    const root = extensionRepo();
    write(join(root, ".slop/config.yml"), configYaml());
    expect(Array.isArray(runCheck({ repoRoot: root }))).toBe(true);
  });
});

// -/ 1/2

// -- 2/2 HELPER · orphan enforcement --

describe("orphan enforcement", () => {
  test("a matching tombstone consumes an orphan and a zero ceiling passes", () => {
    const root = extensionRepo();
    const measured = runCheck({ repoRoot: root }) as ExtendedSummary;
    const fingerprint = measured.orphan_scopes![0]!.orphans[0]!.fingerprint;
    write(join(root, ".slop/tombstones/T-ORPHAN.yml"), orphanRecord("T-ORPHAN", fingerprint));
    write(
      join(root, ".slop/ceilings.yml"),
      `schema: 1
scopes:
  python_production: {active_clones_ceiling: 1}
  python_tests_fixtures: {active_clones_ceiling: 1}
orphan_scopes:
  tools: {active_orphans_ceiling: 0}
`,
    );

    const enforced = runCheck({ repoRoot: root, classify: true, enforce: true }) as ExtendedSummary;
    expect(enforced.orphan_scopes![0]!.active_orphans).toBe(0);
    expect(enforced.orphan_scopes![0]!.accepted_orphans).toBe(1);
  });

  test("a stale orphan tombstone fails under enforcement", () => {
    const root = extensionRepo();
    write(join(root, ".slop/tombstones/T-STALE.yml"), orphanRecord("T-STALE", "a".repeat(64)));
    write(
      join(root, ".slop/ceilings.yml"),
      `schema: 1
scopes:
  python_production: {active_clones_ceiling: 1}
  python_tests_fixtures: {active_clones_ceiling: 1}
orphan_scopes:
  tools: {active_orphans_ceiling: 1}
`,
    );
    expect(() => runCheck({ repoRoot: root, classify: true, enforce: true })).toThrow(
      /stale orphan tombstone/,
    );
  });
});

// -/ 2/2
