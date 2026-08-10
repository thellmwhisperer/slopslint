// Ceiling parser and ratchet contract tests.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadCeilings, loadCeilingsFromText, ratchet } from "../src/ceilings.ts";
import { tempTree, write } from "./helpers.ts";

function ceilingsYaml(production = 36, tests = 132): string {
  return `schema: 1
scopes:
  python_production:
    active_clones_ceiling: ${production}
  python_tests_fixtures:
    active_clones_ceiling: ${tests}
`;
}

function git(repo: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/** A git repository whose first commit carries a ceilings file. */
function gitRepo(body = ceilingsYaml()): string {
  const repo = tempTree("slopgit-");
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test");
  write(join(repo, ".slop", "ceilings.yml"), body);
  git(repo, "add", ".slop/ceilings.yml");
  git(repo, "commit", "--quiet", "-m", "base");
  return repo;
}


describe("loadCeilingsFromText", () => {
  test("loads a valid document", () => {
    const config = loadCeilingsFromText(ceilingsYaml(), "test");
    expect(config.scopes["python_production"]!.active_clones_ceiling).toBe(36);
    expect(config.scopes["python_tests_fixtures"]!.active_clones_ceiling).toBe(132);
  });

  test("a zero ceiling is valid", () => {
    expect(
      loadCeilingsFromText(ceilingsYaml(0), "test").scopes["python_production"]!
        .active_clones_ceiling,
    ).toBe(0);
  });

  test("loads opt-in orphan ceilings", () => {
    const config = loadCeilingsFromText(
      `${ceilingsYaml()}orphan_scopes:\n  tools: {active_orphans_ceiling: 2}\n`,
      "test",
    );
    expect(config.orphan_scopes?.["tools"]?.active_orphans_ceiling).toBe(2);
  });

  test.each([
    ["{bad", "invalid YAML"],
    ["[]", "mapping"],
    ["schema: 2\nscopes:\n  x:\n    active_clones_ceiling: 1\n", "schema"],
    ["schema: 1\n", "scopes"],
    ["schema: 1\nscopes: {}\n", "scopes"],
    ["schema: 1\nscopes:\n  x: str\n", "mapping"],
    [ceilingsYaml(-1), "non-negative"],
    ["schema: 1\nscopes:\n  x:\n    active_clones_ceiling: true\n", "integer"],
    ["schema: 1\nscopes:\n  x:\n    active_clones_ceiling: ~\n", "integer"],
    ["schema: 1\nscopes:\n  x:\n    active_clones_ceiling: 36.5\n", "integer"],
    ["schema: 1\nscopes:\n  x:\n    active_clones_ceiling: '36'\n", "integer"],
    ["schema: 1\nscopes:\n  x:\n    not_the_key: 5\n", "active_clones_ceiling"],
  ])("%s fails closed", (raw, needle) => {
    expect(() => loadCeilingsFromText(raw, "test")).toThrow(new RegExp(needle));
  });
});



describe("loadCeilings", () => {
  test("a missing file fails closed", () => {
    expect(() => loadCeilings(join(tempTree(), "nope.yml"))).toThrow(/ceilings/);
  });
});



describe("ratchet", () => {
  test.each([
    ["unchanged", ceilingsYaml(36, 132), true],
    ["production lowered", ceilingsYaml(30, 132), true],
    ["tests lowered", ceilingsYaml(36, 100), true],
    ["production raised", ceilingsYaml(50, 132), false],
    ["tests raised", ceilingsYaml(36, 200), false],
  ])("%s", (_name, head, shouldPass) => {
    const repo = gitRepo();
    write(join(repo, ".slop", "ceilings.yml"), head);
    if (shouldPass) {
      expect(() => ratchet("HEAD", repo)).not.toThrow();
    } else {
      expect(() => ratchet("HEAD", repo)).toThrow(/CEILING VIOLATION/);
    }
  });

  test("a decrease is reported", () => {
    const repo = gitRepo();
    write(join(repo, ".slop", "ceilings.yml"), ceilingsYaml(30, 132));
    const result = ratchet("HEAD", repo);
    expect(result.decreases.join("\n")).toContain("python_production: 36 -> 30");
    expect(result.summary).toBe(
      "Ceiling ratchet OK: base=HEAD python_production=30 python_tests_fixtures=132",
    );
  });

  test("an unreachable ref fails closed", () => {
    expect(() => ratchet("nonexistent", gitRepo())).toThrow(/cannot fetch/);
  });

  test("a shallow clone without the parent commit fails closed", () => {
    const origin = gitRepo();
    const shallow = join(tempTree("slopshallow-"), "clone");
    spawnSync("git", ["clone", "--depth=1", `file://${origin}`, shallow], { encoding: "utf8" });
    expect(() => ratchet("HEAD~1", shallow)).toThrow(/cannot fetch/);
  });

  test("a scope-set mismatch fails closed", () => {
    const repo = gitRepo();
    write(
      join(repo, ".slop", "ceilings.yml"),
      "schema: 1\nscopes:\n  python_production:\n    active_clones_ceiling: 36\n",
    );
    expect(() => ratchet("HEAD", repo)).toThrow(/mismatch/);
  });

  test("an empty base ref fails closed", () => {
    expect(() => ratchet("   ", gitRepo())).toThrow(/non-empty/);
  });

  test("a base ref without the file bootstraps", () => {
    const repo = tempTree("slopgit-");
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "user.name", "Test");
    write(join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "--quiet", "-m", "init");
    write(join(repo, ".slop", "ceilings.yml"), ceilingsYaml());

    const result = ratchet("HEAD", repo);
    expect(result.bootstrap).toBe(true);
    expect(result.summary.toLowerCase()).toContain("bootstrap");
  });

  test("a malformed head fails closed even when the base is valid", () => {
    const repo = gitRepo();
    write(join(repo, ".slop", "ceilings.yml"), "schema: 1\nscopes:\n  x: str\n");
    expect(() => ratchet("HEAD", repo)).toThrow(/mapping/);
  });

  test("an orphan ceiling increase is rejected", () => {
    const base = `${ceilingsYaml()}orphan_scopes:\n  tools: {active_orphans_ceiling: 1}\n`;
    const repo = gitRepo(base);
    write(
      join(repo, ".slop", "ceilings.yml"),
      `${ceilingsYaml()}orphan_scopes:\n  tools: {active_orphans_ceiling: 2}\n`,
    );
    expect(() => ratchet("HEAD", repo)).toThrow(/orphan_scopes\.tools.*INCREASE/);
  });

  test("the first orphan ceiling block bootstraps against an existing file", () => {
    const repo = gitRepo();
    write(
      join(repo, ".slop", "ceilings.yml"),
      `${ceilingsYaml()}orphan_scopes:\n  tools: {active_orphans_ceiling: 2}\n`,
    );
    expect(() => ratchet("HEAD", repo)).not.toThrow();
  });
});
