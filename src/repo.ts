/** Repository-root discovery for the CLI. */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SlopslintError } from "./errors.ts";

/** Path of the scope config, relative to the repository root. */
export const CONFIG_REL = join(".slop", "config.yml");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Walk upward from `start` (default: cwd) until `.slop/config.yml` exists.
 *
 * Throws {@link SlopslintError} when no ancestor carries the slopslint data
 * directory: running the gate against an unknown root would silently measure
 * the wrong tree.
 */
export function findRepoRoot(start?: string): string {
  let current = resolve(start ?? process.cwd());
  for (;;) {
    if (existsSync(join(current, CONFIG_REL)) && isFile(join(current, CONFIG_REL))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new SlopslintError(
    `no ${CONFIG_REL} found from ${resolve(start ?? process.cwd())} upward; pass ` +
      `--repo-root or run from inside a repository that keeps .slop/ data`,
  );
}
