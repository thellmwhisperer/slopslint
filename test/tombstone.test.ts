/**
 * @overview Tombstone validation and classification contract tests. ~460 lines, no public symbols.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at "load fails closed"    <- CORE adversarial schema matrix
 *   2. Read "classification"           <- finding consumption semantics
 *   3. Read "addTombstone"             <- scaffold behavior
 *
 *   MAIN FLOW
 *   record fixture -> validate/load -> classify or reject -> optional scaffold
 *
 *   PUBLIC API
 *   (none; test module)
 *
 *   INTERNALS
 *   recordDir, withAlien
 *
 * @exports
 * @deps bun:test, node:path, yaml, check, tombstone, helpers
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stringify } from "yaml";
import { classifyReport } from "../src/check.ts";
import {
  addTombstone,
  classifyDuplicates,
  family,
  isStanding,
  loadTombstones,
  resolveAllowedScopes,
  standingTombstones,
  validateOne,
} from "../src/tombstone.ts";
import {
  alienRecord,
  canonicalFixture,
  configYaml,
  duplicationRecord,
  fp,
  tempTree,
  write,
} from "./helpers.ts";

const SCOPES = ["python_production", "python_tests_fixtures"];

/** A tombstone directory holding one record, plus the artifact it cites. */
function recordDir(body: string, name: string): { dir: string; root: string } {
  const root = tempTree();
  write(join(root, "marker.txt"), "artifact\n");
  write(join(root, "t", name), body);
  return { dir: join(root, "t"), root };
}

function withAlien(id = "T-ALIEN-X"): { dir: string; root: string } {
  return recordDir(stringify(alienRecord(id)), `${id}.yml`);
}

// -- 1/6 CORE · load fails closed -- <- START HERE

describe("load fails closed", () => {
  const mutations: [string, (record: Record<string, any>) => Record<string, any>, string][] = [
    ["wrong schema", (r) => ({ ...r, schema: 2 }), "schema"],
    ["missing schema", (r) => { const { schema, ...rest } = r; return rest; }, "schema"],
    ["missing id", (r) => { const { id, ...rest } = r; return rest; }, "id"],
    ["unknown status", (r) => ({ ...r, status: "bogus" }), "status"],
    ["unknown category", (r) => ({ ...r, category: "bogus" }), "category"],
    ["missing title", (r) => { const { title, ...rest } = r; return rest; }, "title"],
    ["missing incident", (r) => { const { incident, ...rest } = r; return rest; }, "incident"],
    [
      "missing evidence",
      (r) => ({ ...r, incident: { ...r["incident"], evidence: undefined } }),
      "evidence",
    ],
    [
      "evidence without example",
      (r) => ({
        ...r,
        incident: {
          ...r["incident"],
          evidence: [{ family: "runtime_dependency", artifact: "marker.txt" }],
        },
      }),
      "example",
    ],
    [
      "unknown evidence family",
      (r) => ({
        ...r,
        incident: {
          ...r["incident"],
          evidence: [{ example: "x", family: "bogus", artifact: "marker.txt" }],
        },
      }),
      "family",
    ],
    ["unknown match family", (r) => ({ ...r, match: { ...r["match"], family: "bogus" } }), "family"],
    [
      "standing record claiming clone_fingerprint",
      (r) => ({ ...r, match: { ...r["match"], family: "clone_fingerprint" } }),
      "clone_fingerprint",
    ],
    [
      "standing record claiming orphan_fingerprint",
      (r) => ({ ...r, match: { ...r["match"], family: "orphan_fingerprint" } }),
      "orphan_fingerprint",
    ],
  ];

  test.each(mutations)("%s", (_name, mutate, needle) => {
    const { dir } = recordDir(stringify(mutate(alienRecord("T"))), "T.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(new RegExp(needle));
  });

  test("duplication category requires the clone_fingerprint family", () => {
    const record = {
      ...alienRecord("T"),
      category: "duplication",
      match: { family: "runtime_dependency", artifact: "marker.txt" },
    };
    const { dir } = recordDir(stringify(record), "T.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/clone_fingerprint/);
  });

  test("a malformed fingerprint fails closed", () => {
    const { dir } = recordDir(duplicationRecord("T", "python_production", "not-hex"), "T.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/fingerprint/);
  });

  test("an unknown scope fails closed", () => {
    const { dir } = recordDir(duplicationRecord("T", "python_typo", fp(1)), "T.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/scope/);
  });

  test("id must match the filename stem", () => {
    const { dir } = recordDir(stringify(alienRecord("T")), "wrong.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/filename stem/);
  });

  test("two records on one clone fail closed", () => {
    const { dir } = recordDir(duplicationRecord("T1", "python_production", fp(7)), "T1.yml");
    write(join(dir, "T2.yml"), duplicationRecord("T2", "python_production", fp(7)));
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/duplicate matcher/);
  });

  test.each(["/etc/passwd", "../secret", "../../repo/package.json"])(
    "path escape %s is rejected",
    (bad) => {
      const record = alienRecord("T-ESC");
      (record["match"] as Record<string, unknown>)["artifact"] = bad;
      ((record["incident"] as Record<string, any>)["evidence"] as any[])[0]!["artifact"] = bad;
      const { dir } = recordDir(stringify(record), "T-ESC.yml");
      expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(
        /repo-relative|escape/,
      );
    },
  );

  test("a cited artifact that does not exist fails closed", () => {
    const record = alienRecord("T");
    (record["match"] as Record<string, unknown>)["artifact"] = "does/not/exist.json";
    ((record["incident"] as Record<string, any>)["evidence"] as any[])[0]!["artifact"] =
      "does/not/exist.json";
    const { dir, root } = recordDir(stringify(record), "T.yml");
    expect(() => loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES })).toThrow(
      /does not exist/,
    );
  });

  test("a missing directory fails closed", () => {
    expect(() => loadTombstones(join(tempTree(), "nope"))).toThrow(/not found/);
  });

  test.each([
    ["top-level duplicate key", "a: 1\na: 2\n"],
    ["nested duplicate key", "outer:\n  k: 1\n  k: 2\n"],
  ])("%s fails closed", (_name, body) => {
    const { dir } = recordDir(body, "T.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/duplicate key/);
  });

  test("a complex mapping key fails closed", () => {
    const { dir } = recordDir("? [a, b]\n: v\n", "T.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/unhashable/);
  });

  test("invalid YAML fails closed", () => {
    const { dir } = recordDir("schema: 1\n  id: : bad indent\n", "T.yml");
    expect(() => loadTombstones(dir, { allowedScopes: SCOPES })).toThrow(/YAML/);
  });

  test("cross-file duplicate ids are caught by seen-id defense", () => {
    const seen = new Set<string>();
    const raw = alienRecord("T");
    validateOne("T.yml", raw, seen, new Set(), undefined, new Set(SCOPES));
    expect(seen.has("T")).toBe(true);
    expect(() =>
      validateOne("T.yml", raw, seen, new Set(), undefined, new Set(SCOPES)),
    ).toThrow(/duplicate tombstone id/);
  });
});

// -/ 1/6

// -- 2/6 HELPER · load happy paths --

describe("load happy paths", () => {
  test("an empty directory is a valid state", () => {
    expect(loadTombstones(tempTree())).toEqual([]);
  });

  test("records come back sorted by id", () => {
    const { dir, root } = withAlien();
    write(join(dir, "T-DUP.yml"), duplicationRecord("T-DUP", "python_production", fp(1)));
    const ids = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES }).map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("T-ALIEN-X");
    expect(ids).toContain("T-DUP");
  });

  test("both real scopes load", () => {
    const { dir } = recordDir(duplicationRecord("T1", "python_production", fp(1)), "T1.yml");
    write(join(dir, "T2.yml"), duplicationRecord("T2", "python_tests_fixtures", fp(2)));
    const records = loadTombstones(dir, { allowedScopes: SCOPES });
    expect(records.map((r) => r.match["scope"]).sort()).toEqual(SCOPES);
  });

  test.each([
    ["environment_layout_coupling", "alien_code"],
    ["agent_artifact_in_repo", "alien_code"],
    ["documented_as_convention", "debt_normalization"],
  ])("family %s loads as a standing record", (fam, category) => {
    const record = alienRecord("T-STAND");
    record["category"] = category;
    record["match"] = { family: fam, artifact: "marker.txt" };
    (record["incident"] as Record<string, unknown>)["evidence"] = [
      { example: "documented incident", family: fam },
    ];
    const { dir } = recordDir(stringify(record), "T-STAND.yml");
    const records = loadTombstones(dir, { allowedScopes: SCOPES });
    expect(family(records[0]!)).toBe(fam);
    expect(isStanding(records[0]!)).toBe(true);
  });

  test("reading dates as strings survives YAML quoting", () => {
    const { dir } = recordDir(
      stringify({ ...alienRecord("T"), created_at: "2026-07-15" }),
      "T.yml",
    );
    expect(loadTombstones(dir, { allowedScopes: SCOPES })[0]!.created_at).toBe("2026-07-15");
  });
});

// -/ 2/6

// -- 3/6 HELPER · scope resolution --

describe("scope resolution", () => {
  test("explicit scopes win", () => {
    expect([...resolveAllowedScopes(["a", "b"], undefined)].sort()).toEqual(["a", "b"]);
  });

  test("scopes come from the consumer config when not passed", () => {
    const root = tempTree();
    write(join(root, ".slop", "config.yml"), configYaml());
    expect([...resolveAllowedScopes(undefined, root)].sort()).toEqual(SCOPES);
  });

  test("no explicit scopes and no config fails closed", () => {
    // The engine ships no default layout, so an unconstrained scope name would
    // let a record claim a measurement that is never taken.
    expect(() => resolveAllowedScopes(undefined, tempTree())).toThrow(/cannot resolve/);
  });

  test("a standing-only directory never needs scopes", () => {
    const { dir, root } = withAlien();
    expect(loadTombstones(dir, { repoRoot: root }).map((r) => r.id)).toEqual(["T-ALIEN-X"]);
  });
});

// -/ 3/6

// -- 4/6 HELPER · classification --

describe("classification", () => {
  const duplicate = (fingerprint: string) => ({
    lines: 7,
    tokens: 60,
    first: { path: "py/a.py", start: 1, end: 7 },
    second: { path: "py/b.py", start: 1, end: 7 },
    fingerprint,
  });

  test("everything is active without tombstones", () => {
    const result = classifyDuplicates([duplicate(fp(1)), duplicate(fp(2))], "python_production", []);
    expect(result.activeCount).toBe(2);
    expect(result.acceptedCount).toBe(0);
    expect(result.unmatched).toEqual([]);
    expect(result.duplicates.every((d) => d.status === "active" && d.tombstone === null)).toBe(true);
  });

  test("a matching fingerprint is accepted", () => {
    const { dir, root } = withAlien();
    write(join(dir, "T-A.yml"), duplicationRecord("T-A", "python_production", fp(1)));
    const records = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES });
    const result = classifyDuplicates(
      [duplicate(fp(1)), duplicate(fp(2))],
      "python_production",
      records,
    );
    const byFingerprint = new Map(result.duplicates.map((d) => [d.fingerprint, d]));
    expect(byFingerprint.get(fp(1))!.status).toBe("accepted");
    expect(byFingerprint.get(fp(1))!.tombstone).toBe("T-A");
    expect(byFingerprint.get(fp(2))!.status).toBe("active");
    expect(result.activeCount).toBe(1);
    expect(result.acceptedCount).toBe(1);
  });

  test("a record matching nothing is stale", () => {
    const { dir, root } = withAlien();
    write(join(dir, "T-STALE.yml"), duplicationRecord("T-STALE", "python_production", fp(999)));
    const records = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES });
    const result = classifyDuplicates([duplicate(fp(1))], "python_production", records);
    expect(result.activeCount).toBe(1);
    expect(result.unmatched.map((r) => r.id)).toEqual(["T-STALE"]);
  });

  test("scopes are isolated", () => {
    const { dir, root } = withAlien();
    write(join(dir, "T-T.yml"), duplicationRecord("T-T", "python_tests_fixtures", fp(1)));
    const records = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES });
    expect(classifyDuplicates([duplicate(fp(1))], "python_production", records).activeCount).toBe(1);
    expect(
      classifyDuplicates([], "python_tests_fixtures", records).unmatched.map((r) => r.id),
    ).toEqual(["T-T"]);
  });

  test("classification is order-stable and non-mutating", () => {
    const duplicates = [duplicate(fp(1)), duplicate(fp(2)), duplicate(fp(3))];
    const snapshot = JSON.parse(JSON.stringify(duplicates));
    const forward = classifyDuplicates(duplicates, "python_production", []);
    const reversed = classifyDuplicates([...duplicates].reverse(), "python_production", []);
    expect(forward.activeCount).toBe(reversed.activeCount);
    expect(forward.duplicates.map((d) => d.fingerprint).sort()).toEqual(
      reversed.duplicates.map((d) => d.fingerprint).sort(),
    );
    expect(duplicates).toEqual(snapshot);
  });

  test("standing records are excluded from duplication classification", () => {
    const { dir, root } = withAlien();
    write(join(dir, "T-D.yml"), duplicationRecord("T-D", "python_production", fp(1)));
    const records = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES });
    expect(standingTombstones(records).map((r) => r.id)).toEqual(["T-ALIEN-X"]);
  });
});

// -/ 4/6

// -- 5/6 HELPER · classifyReport --

describe("classifyReport", () => {
  test("annotates counts and carries every S1 field through", () => {
    const report = canonicalFixture("python_production", [fp(1), fp(2)]);
    (report as unknown as Record<string, unknown>)["extra_future_s1_field"] = { keep: "me" };
    const snapshot = JSON.parse(JSON.stringify(report));
    const { dir, root } = recordDir(
      duplicationRecord("T-A", "python_production", fp(1)),
      "T-A.yml",
    );
    const records = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES });

    const classified = classifyReport(report, records);
    expect(classified.statistics.active_clones).toBe(1);
    expect(classified.statistics.accepted_clones).toBe(1);
    expect(classified.statistics.clones).toBe(2);
    for (const key of Object.keys(snapshot.statistics)) {
      expect(classified.statistics).toHaveProperty(key);
    }
    expect((classified as unknown as Record<string, unknown>)["extra_future_s1_field"]).toEqual({
      keep: "me",
    });
    expect(classified.scope).toBe(report.scope);
    expect(classified.detector).toEqual(report.detector);
    expect(report).toEqual(snapshot);
  });

  test("reports unmatched records as diagnostics", () => {
    const report = canonicalFixture("python_production", [fp(1)]);
    const { dir, root } = recordDir(
      duplicationRecord("T-STALE", "python_production", fp(999)),
      "T-STALE.yml",
    );
    const records = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES });
    expect(classifyReport(report, records).diagnostics!.unmatched_tombstones).toEqual([
      { id: "T-STALE", scope: "python_production", fingerprint: fp(999) },
    ]);
  });

  test("no tombstones means everything active and nothing stale", () => {
    const classified = classifyReport(canonicalFixture("python_production", [fp(1)]), []);
    expect(classified.statistics.active_clones).toBe(1);
    expect(classified.statistics.accepted_clones).toBe(0);
    expect(classified.diagnostics!.unmatched_tombstones).toEqual([]);
  });
});

// -/ 5/6

// -- 6/6 HELPER · addTombstone --

describe("addTombstone", () => {
  test("scaffolds a standing record that loads back", () => {
    const root = tempTree();
    write(join(root, "marker.txt"), "artifact\n");
    const dir = join(root, ".slop", "tombstones");
    const path = addTombstone(dir, {
      recordId: "T-NEW",
      status: "accepted",
      category: "alien_code",
      title: "a new record",
      family: "runtime_dependency",
      artifact: "marker.txt",
      createdAt: "2026-08-04",
      repoRoot: root,
    });
    expect(path).toContain("T-NEW.yml");
    const records = loadTombstones(dir, { repoRoot: root, allowedScopes: SCOPES });
    expect(records.map((r) => r.id)).toEqual(["T-NEW"]);
  });

  test("refuses to overwrite an existing record", () => {
    const root = tempTree();
    write(join(root, "marker.txt"), "artifact\n");
    const dir = join(root, ".slop", "tombstones");
    const options = {
      recordId: "T-NEW",
      status: "accepted",
      category: "alien_code",
      title: "a new record",
      family: "runtime_dependency",
      artifact: "marker.txt",
      createdAt: "2026-08-04",
      repoRoot: root,
    };
    addTombstone(dir, options);
    expect(() => addTombstone(dir, options)).toThrow(/already exists/);
  });

  test("a duplication record without scope or fingerprint fails closed", () => {
    const root = tempTree();
    expect(() =>
      addTombstone(join(root, "tombs"), {
        recordId: "T-DUP",
        status: "accepted",
        category: "duplication",
        title: "clone",
        family: "clone_fingerprint",
        repoRoot: root,
      }),
    ).toThrow(/requires --scope/);
  });

  test("an orphan record must name a configured orphan scope", () => {
    const root = tempTree();
    write(join(root, ".slop", "config.yml"), configYaml());
    expect(() =>
      addTombstone(join(root, "tombs"), {
        recordId: "T-ORPHAN",
        status: "accepted",
        category: "orphan",
        title: "orphan",
        family: "orphan_fingerprint",
        scope: "typo",
        fingerprint: fp(9),
        repoRoot: root,
      }),
    ).toThrow(/no orphan scopes|unknown/);
  });
});

// -/ 6/6
