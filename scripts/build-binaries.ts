/**
 * Build the self-contained per-platform binaries.
 *
 * `bun build --compile` links the runtime, the engine, and the jscpd detector
 * libraries into one executable, so a consumer's gate needs no Node, no npm,
 * and no separately installed detector — the whole reason the detector became a
 * linked library rather than a pinned subprocess.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Published targets. Each produces one self-contained executable. */
export const TARGETS = [
  { target: "bun-darwin-arm64", asset: "slopslint-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "slopslint-darwin-x64" },
  { target: "bun-linux-arm64", asset: "slopslint-linux-arm64" },
  { target: "bun-linux-x64", asset: "slopslint-linux-x64" },
  { target: "bun-windows-x64", asset: "slopslint-windows-x64.exe" },
] as const;

const DIST = "dist";

async function build(): Promise<void> {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  for (const { target, asset } of TARGETS) {
    const outfile = join(DIST, asset);
    console.log(`building ${asset} (${target})`);
    const proc = Bun.spawnSync([
      "bun",
      "build",
      "./src/cli.ts",
      "--compile",
      `--target=${target}`,
      "--outfile",
      outfile,
    ]);
    if (proc.exitCode !== 0) {
      console.error(new TextDecoder().decode(proc.stderr));
      throw new Error(`failed to build ${asset}`);
    }
  }

  console.log("building the npm entry (node target)");
  const npmBuild = Bun.spawnSync([
    "bun",
    "build",
    "./src/cli.ts",
    "--target=node",
    "--outfile",
    join(DIST, "slopslint.mjs"),
    "--banner",
    "#!/usr/bin/env node",
  ]);
  if (npmBuild.exitCode !== 0) {
    console.error(new TextDecoder().decode(npmBuild.stderr));
    throw new Error("failed to build the npm entry");
  }
}

if (import.meta.main) {
  await build();
}
