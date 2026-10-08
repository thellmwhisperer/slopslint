import { expect, test } from "bun:test";
import { join } from "node:path";
import type { OrphanScopeConfig } from "../src/config.ts";
import { censusOrphans } from "../src/orphans.ts";
import { tempTree, write } from "./helpers.ts";

const scope: OrphanScopeConfig = {
  files: [],
  directories: ["internal/cli"],
  exported_symbols: [],
  test_files: [],
  generation_files: [],
  ignore: [],
};

test("a Go module import path that resolves to the target is a consumer", () => {
  const root = tempTree();
  write(join(root, "go.mod"), "module github.com/acme/app\n");
  write(join(root, "internal/cli/cli.go"), "package cli\n");
  write(join(root, "cmd/app/main.go"), `package main\n\nimport "github.com/acme/app/internal/cli"\n`);
  expect(censusOrphans(root, "cli", scope, []).orphans).toEqual([]);
});
