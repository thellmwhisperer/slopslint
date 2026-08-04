/**
 * CLI and end-to-end check contract: exit codes, layered flags, scope parity,
 * and deterministic output on one immutable tree.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { runCheck } from "../src/check.ts";
import { VERSION } from "../src/version.ts";
import { DUP_BLOCK, configYaml, duplicationRecord, fp, tempTree, write } from "./helpers.ts";

/** A consumer repository: scope config, ceilings, tombstones, and a py/ tree. */
function consumerRepo(options: { production?: number; tests?: number } = {}): string {
  const root = tempTree();
  write(join(root, ".slop", "config.yml"), configYaml());
  write(
    join(root, ".slop", "ceilings.yml"),
    `schema: 1
scopes:
  python_production:
    active_clones_ceiling: ${options.production ?? 1}
  python_tests_fixtures:
    active_clones_ceiling: ${options.tests ?? 1}
`,
  );
  write(join(root, "py", "a.py"), DUP_BLOCK);
  write(join(root, "py", "b.py"), DUP_BLOCK);
  write(join(root, "py", "test_a.py"), DUP_BLOCK);
  write(join(root, "py", "test_b.py"), DUP_BLOCK);
  write(join(root, ".slop", "tombstones", ".keep"), "");
  return root;
}

/** Capture a CLI run's exit code plus its stdout and stderr. */
function run(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(
    argv,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("top level", () => {
  test("--version prints the engine version", () => {
    const result = run("--version");
    expect(result.code).toBe(0);
    expect(result.out).toBe(`slopslint ${VERSION}`);
  });

  test("--help lists every command", () => {
    const result = run("--help");
    expect(result.code).toBe(0);
    for (const command of ["check", "ratchet", "tombstone"]) {
      expect(result.out).toContain(command);
    }
  });

  test("no arguments prints usage and exits 2", () => {
    expect(run().code).toBe(2);
  });

  test("an unknown command exits 2", () => {
    const result = run("frobnicate", "--repo-root", tempTree());
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command");
  });

  test("an unknown option exits 2", () => {
    expect(run("check", "--nope").code).toBe(2);
  });

  test("a value flag without a value exits 2", () => {
    expect(run("check", "--repo-root").code).toBe(2);
  });

  test("a root without .slop fails closed", () => {
    const result = run("check", "--repo-root", join(tempTree(), "nowhere"));
    expect(result.code).toBe(1);
    expect(result.err).toContain("slopslint:");
  });
});

describe("check", () => {
  test("report-only emits one entry per scope", () => {
    const result = run("check", "--repo-root", consumerRepo());
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.out) as { scope: string; sha256: string }[];
    expect(summary.map((entry) => entry.scope).sort()).toEqual([
      "python_production",
      "python_tests_fixtures",
    ]);
    expect(summary.every((entry) => entry.sha256.length === 64)).toBe(true);
  });

  test("--classify adds active/accepted counts and diagnostics", () => {
    const root = consumerRepo();
    write(join(root, ".slop", "tombstones", ".keep"), "");
    const result = run("check", "--classify", "--repo-root", root);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.out);
    expect(Object.keys(summary).sort()).toEqual(["diagnostics", "scopes"]);
    for (const entry of summary.scopes) {
      expect(entry.statistics).toHaveProperty("active_clones");
      expect(entry.statistics).toHaveProperty("accepted_clones");
    }
    expect(summary.diagnostics.unmatched_tombstones).toEqual([]);
  });

  test("--enforce without --classify fails early", () => {
    const result = run("check", "--enforce", "--repo-root", consumerRepo());
    expect(result.code).toBe(1);
    expect(result.err).toContain("--enforce requires --classify");
  });

  test("--enforce passes when every scope matches its ceiling", () => {
    const root = consumerRepo();
    write(join(root, ".slop", "tombstones", ".keep"), "");
    const measured = runCheck({ repoRoot: root, classify: true }) as {
      scopes: { scope: string; statistics: { active_clones?: number } }[];
    };
    const byScope = new Map(
      measured.scopes.map((entry) => [entry.scope, entry.statistics.active_clones ?? 0]),
    );
    write(
      join(root, ".slop", "ceilings.yml"),
      `schema: 1
scopes:
  python_production:
    active_clones_ceiling: ${byScope.get("python_production")}
  python_tests_fixtures:
    active_clones_ceiling: ${byScope.get("python_tests_fixtures")}
`,
    );
    const result = run("check", "--classify", "--enforce", "--repo-root", root);
    expect(result.code).toBe(0);
  });

  test("a regression above the ceiling fails closed", () => {
    const result = run(
      "check",
      "--classify",
      "--enforce",
      "--repo-root",
      consumerRepo({ production: 0, tests: 0 }),
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("exceeding");
  });

  test("an unrecorded improvement fails closed", () => {
    const result = run(
      "check",
      "--classify",
      "--enforce",
      "--repo-root",
      consumerRepo({ production: 999, tests: 999 }),
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("below");
  });

  test("a ceiling scope the config does not declare fails closed", () => {
    const root = consumerRepo();
    write(
      join(root, ".slop", "ceilings.yml"),
      `schema: 1
scopes:
  python_production:
    active_clones_ceiling: 1
  python_tests_fixtures:
    active_clones_ceiling: 1
  python_surprise:
    active_clones_ceiling: 1
`,
    );
    const result = run("check", "--classify", "--enforce", "--repo-root", root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("unknown scope");
  });

  test("a config scope the ceilings omit fails closed", () => {
    const root = consumerRepo();
    write(
      join(root, ".slop", "ceilings.yml"),
      "schema: 1\nscopes:\n  python_production:\n    active_clones_ceiling: 1\n",
    );
    const result = run("check", "--classify", "--enforce", "--repo-root", root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("missing scope");
  });

  test("a stale duplication tombstone fails closed under --enforce", () => {
    const root = consumerRepo();
    write(
      join(root, ".slop", "tombstones", "T-STALE.yml"),
      duplicationRecord("T-STALE", "python_production", fp(4242)),
    );
    const result = run("check", "--classify", "--enforce", "--repo-root", root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("stale tombstone");
  });

  test("report-only never fails on a stale record", () => {
    const root = consumerRepo();
    write(
      join(root, ".slop", "tombstones", "T-STALE.yml"),
      duplicationRecord("T-STALE", "python_production", fp(4242)),
    );
    const result = run("check", "--classify", "--repo-root", root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).diagnostics.unmatched_tombstones).toHaveLength(1);
  });

  test("repeated runs on one tree print identical bytes", () => {
    const root = consumerRepo();
    expect(run("check", "--repo-root", root).out).toBe(run("check", "--repo-root", root).out);
  });
});

describe("tombstone", () => {
  test("list emits JSON rows", () => {
    const root = consumerRepo();
    write(
      join(root, ".slop", "tombstones", "T-A.yml"),
      duplicationRecord("T-A", "python_production", fp(1)),
    );
    const result = run("tombstone", "list", "--repo-root", root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([
      {
        id: "T-A",
        status: "accepted",
        category: "duplication",
        family: "clone_fingerprint",
        title: "accepted clone",
      },
    ]);
  });

  test("check validates the shipped records", () => {
    const root = consumerRepo();
    write(
      join(root, ".slop", "tombstones", "T-A.yml"),
      duplicationRecord("T-A", "python_production", fp(1)),
    );
    const result = run("tombstone", "check", "--repo-root", root);
    expect(result.code).toBe(0);
    expect(result.out).toContain("1 record(s) valid");
  });

  test("check on an empty directory exits 2", () => {
    const root = consumerRepo();
    write(join(root, ".slop", "tombstones", ".keep"), "");
    const result = run("tombstone", "check", "--repo-root", root);
    expect(result.code).toBe(2);
    expect(result.err).toContain("no records");
  });

  test("a malformed record exits 2 with a config error", () => {
    const root = consumerRepo();
    write(join(root, ".slop", "tombstones", "T.yml"), "schema: 1\nid: T\nstatus: accepted\n");
    const result = run("tombstone", "check", "--repo-root", root);
    expect(result.code).toBe(2);
    expect(result.err).toContain("config error");
  });

  test("add scaffolds a record that loads back", () => {
    const root = consumerRepo();
    const added = run(
      "tombstone",
      "add",
      "--id",
      "T-NEW",
      "--status",
      "legacy",
      "--category",
      "alien_code",
      "--title",
      "a recorded incident",
      "--family",
      "runtime_dependency",
      "--artifact",
      "py/a.py",
      "--created-at",
      "2026-08-04",
      "--repo-root",
      root,
    );
    expect(added.code).toBe(0);
    expect(run("tombstone", "check", "--repo-root", root).code).toBe(0);
  });

  test("an unknown status is rejected", () => {
    const result = run(
      "tombstone",
      "add",
      "--id",
      "T",
      "--status",
      "bogus",
      "--category",
      "alien_code",
      "--title",
      "t",
      "--family",
      "runtime_dependency",
      "--repo-root",
      consumerRepo(),
    );
    expect(result.code).toBe(2);
  });

  test("an unknown subcommand exits 2", () => {
    expect(run("tombstone", "frobnicate", "--repo-root", consumerRepo()).code).toBe(2);
  });
});

describe("ratchet usage", () => {
  test("no base ref exits 2", () => {
    expect(run("ratchet", "--repo-root", consumerRepo()).code).toBe(2);
  });

  test("more than one base ref exits 2", () => {
    expect(run("ratchet", "a", "b", "--repo-root", consumerRepo()).code).toBe(2);
  });
});
