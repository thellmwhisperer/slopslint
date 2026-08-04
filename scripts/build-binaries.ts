/**
 * Build the self-contained per-platform binaries.
 *
 * `bun build --compile` links the runtime, the engine, and the jscpd detector
 * libraries into one executable, so a consumer's gate needs no Node, no npm,
 * and no separately installed detector — the whole reason the detector became a
 * linked library rather than a pinned subprocess.
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
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

  // No --banner here: src/cli.ts already carries the shebang and bun preserves
  // it, so adding one would emit a second `#!` on line 2, where node rejects it
  // as a syntax error rather than treating it as an interpreter line.
  console.log("building the npm entry (node target)");
  const npmEntry = join(DIST, "slopslint.mjs");
  const npmBuild = Bun.spawnSync([
    "bun",
    "build",
    "./src/cli.ts",
    "--target=node",
    "--outfile",
    npmEntry,
  ]);
  if (npmBuild.exitCode !== 0) {
    console.error(new TextDecoder().decode(npmBuild.stderr));
    throw new Error("failed to build the npm entry");
  }
  const built = await Bun.file(npmEntry).text();
  if (!built.startsWith("#!")) {
    throw new Error("the npm entry lost its shebang; npx would not be able to run it");
  }
  chmodSync(npmEntry, 0o755);
}

if (import.meta.main) {
  await build();
}
