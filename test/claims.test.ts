/**
 * @overview Claims-sync contract tests. ~100 lines, no public symbols.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at "sync failures"      <- fail-closed contract
 *   2. Read "valid claims"           <- successful census mapping
 *
 *   MAIN FLOW
 *   configured surfaces -> claims.yml -> contract evidence -> verified report
 *
 *   PUBLIC API
 *   (none; test module)
 *
 *   INTERNALS
 *   config, claims helper
 *
 * @exports
 * @deps bun:test, node:path, ../src/claims.ts, ./helpers.ts
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ClaimsConfig } from "../src/config.ts";
import { verifyClaims } from "../src/claims.ts";
import { tempTree, write } from "./helpers.ts";

const config: ClaimsConfig = {
  file: ".slop/claims.yml",
  surfaces: {
    commands: {
      files: ["bin/*"],
      directories: [],
      exported_symbols: [],
      ignore: [],
    },
  },
};

function claims(root: string, body: string): void {
  write(join(root, ".slop/claims.yml"), body);
}

// -- 1/2 CORE · sync failures -- <- START HERE

describe("claims sync failures", () => {
  test("a surface glob that selects nothing fails closed", () => {
    const root = tempTree();
    claims(root, "schema: 1\nclaims: {}\n");
    expect(() => verifyClaims(root, config)).toThrow(/selected zero/);
  });
  test("a censused surface without a claims entry fails", () => {
    const root = tempTree();
    write(join(root, "bin/slopslint"), "#!/bin/sh\n");
    claims(root, "schema: 1\nclaims: {}\n");

    expect(() => verifyClaims(root, config)).toThrow(/unclaimed.*bin\/slopslint/i);
  });

  test("a claim whose contract file no longer exists fails", () => {
    const root = tempTree();
    write(join(root, "bin/slopslint"), "#!/bin/sh\n");
    claims(
      root,
      `schema: 1\nclaims:\n  bin/slopslint:\n    contract: {file: docs/missing.md, item: CLI-001}\n`,
    );

    expect(() => verifyClaims(root, config)).toThrow(/contract file.*does not exist/i);
  });

  test("a claim whose opaque item disappeared from the contract fails", () => {
    const root = tempTree();
    write(join(root, "bin/slopslint"), "#!/bin/sh\n");
    write(join(root, "docs/contracts.md"), "CLI-002: another command\n");
    claims(
      root,
      `schema: 1\nclaims:\n  bin/slopslint:\n    contract: {file: docs/contracts.md, item: CLI-001}\n`,
    );

    expect(() => verifyClaims(root, config)).toThrow(/does not contain.*CLI-001/i);
  });

  test("a claim for a surface outside the census fails", () => {
    const root = tempTree();
    write(join(root, "bin/slopslint"), "#!/bin/sh\n");
    write(join(root, "docs/contracts.md"), "CLI-001: current command\nCLI-OLD: removed command\n");
    claims(
      root,
      `schema: 1
claims:
  bin/slopslint:
    contract: {file: docs/contracts.md, item: CLI-001}
  bin/removed:
    contract: {file: docs/contracts.md, item: CLI-OLD}
`,
    );
    expect(() => verifyClaims(root, config)).toThrow(/uncensused.*bin\/removed/i);
  });
});

// -/ 1/2

// -- 2/2 HELPER · valid claims --

test("valid claims return a deterministic surface-to-contract report", () => {
  const root = tempTree();
  write(join(root, "bin/slopslint"), "#!/bin/sh\n");
  write(join(root, "docs/contracts.md"), "CLI-001: slopslint command\n");
  claims(
    root,
    `schema: 1\nclaims:\n  bin/slopslint:\n    contract: {file: docs/contracts.md, item: CLI-001}\n`,
  );

  expect(verifyClaims(root, config)).toEqual({
    count: 1,
    surfaces: [
      {
        scope: "commands",
        kind: "file",
        surface: "bin/slopslint",
        contract: { file: "docs/contracts.md", item: "CLI-001" },
      },
    ],
  });
});

// -/ 2/2
