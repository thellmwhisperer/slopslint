/** `.slop/config.yml` loading: every malformed shape fails closed. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, readScopeNames } from "../src/config.ts";
import { DETECTOR_VERSION } from "../src/version.ts";
import { configYaml, tempTree, write } from "./helpers.ts";

function configAt(body: string): string {
  return write(join(tempTree(), "config.yml"), body);
}

describe("valid config", () => {
  test("loads scopes, defaults, and the pinned detector", () => {
    const config = loadConfig(configAt(configYaml()));
    expect(config.detector.version).toBe(DETECTOR_VERSION);
    expect(Object.keys(config.scopes).sort()).toEqual([
      "python_production",
      "python_tests_fixtures",
    ]);
    expect(config.defaults).toEqual({
      format: "python",
      mode: "mild",
      min_lines: 5,
      min_tokens: 50,
    });
    expect(config.scopes["python_production"]!.ignore).toContain("**/test_*.py");
    expect(config.scopes["python_tests_fixtures"]!.ignore).toEqual([]);
  });

  test("scope patterns stay distinct", () => {
    const config = loadConfig(configAt(configYaml()));
    expect(config.scopes["python_production"]!.pattern).not.toBe(
      config.scopes["python_tests_fixtures"]!.pattern,
    );
  });

  test("brace groups are accepted verbatim", () => {
    // The predecessor rejected commas because it joined excludes into one
    // comma-separated CLI value. The library takes a real list, so a brace
    // group is just a glob.
    const config = loadConfig(
      configAt(configYaml().replace(`pattern: "**/{test_*,conftest}.py"}`,
        `pattern: "**/{test_*,conftest}.py", ignore: ["**/{gen,vendor}/**"]}`)),
    );
    expect(config.scopes["python_tests_fixtures"]!.ignore).toEqual(["**/{gen,vendor}/**"]);
  });
});

describe("malformed config fails closed", () => {
  const cases: [string, string, string][] = [
    [
      "missing defaults",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
scopes:
  python_production: {scan_path: py, pattern: "**/*.py"}
`,
      "defaults",
    ],
    [
      "non-integer min_lines",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: "five", min_tokens: 50}
scopes:
  python_production: {scan_path: py, pattern: "**/*.py"}
`,
      "min_lines",
    ],
    [
      "boolean min_lines",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: true, min_tokens: 50}
scopes:
  python_production: {scan_path: py, pattern: "**/*.py"}
`,
      "min_lines",
    ],
    [
      "wrong detector name",
      `schema: 1
detector: {name: pmd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes:
  python_production: {scan_path: py, pattern: "**/*.py"}
`,
      "jscpd",
    ],
    [
      "unpinned detector version",
      `schema: 1
detector: {name: jscpd, version: "0.0.1"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes:
  python_production: {scan_path: py, pattern: "**/*.py"}
`,
      "pinned",
    ],
    [
      "scope is not a mapping",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes:
  python_production: "not-a-mapping"
`,
      "scope",
    ],
    [
      "scope missing pattern",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes:
  python_production: {scan_path: py}
`,
      "pattern",
    ],
    [
      "global_ignore is not a list",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
global_ignore: "not-a-list"
scopes:
  python_production: {scan_path: py, pattern: "**/*.py"}
`,
      "global_ignore",
    ],
    [
      "non-string ignore entry",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
global_ignore: ["**/ok/**", 123]
scopes:
  python_production: {scan_path: py, pattern: "**/*.py"}
`,
      "global_ignore",
    ],
    [
      "absolute scan_path",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes:
  python_production: {scan_path: /etc, pattern: "**/*.py"}
`,
      "scan_path",
    ],
    [
      "traversing scan_path",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes:
  python_production: {scan_path: "../outside", pattern: "**/*.py"}
`,
      "scan_path",
    ],
    [
      "no scopes",
      `schema: 1
detector: {name: jscpd, version: "${DETECTOR_VERSION}"}
defaults: {format: python, mode: mild, min_lines: 5, min_tokens: 50}
scopes: {}
`,
      "scopes",
    ],
    ["invalid YAML", "schema: 1\n  bad: : : indent\n", "YAML"],
    ["duplicate key", "schema: 1\nschema: 2\n", "duplicate key"],
  ];

  test.each(cases)("%s", (_name, body, needle) => {
    expect(() => loadConfig(configAt(body))).toThrow(new RegExp(needle));
  });

  test("a missing file fails closed", () => {
    expect(() => loadConfig(join(tempTree(), "does-not-exist.yml"))).toThrow(/config/);
  });
});

describe("readScopeNames", () => {
  test("returns the declared scopes", () => {
    expect(readScopeNames(configAt(configYaml()))?.sort()).toEqual([
      "python_production",
      "python_tests_fixtures",
    ]);
  });

  test("an absent file yields undefined", () => {
    expect(readScopeNames(join(tempTree(), "nope.yml"))).toBeUndefined();
  });

  test("an unparseable file fails closed rather than yielding undefined", () => {
    expect(() => readScopeNames(configAt("a: 1\na: 2\n"))).toThrow(/cannot read scopes/);
  });
});
