/**
 * `.slop/ceilings.yml` — the committed active-clone ceiling per scope, and the
 * ratchet that keeps it monotonic.
 *
 * Two independent checks share this file. `enforceReport` (in `canonical.ts`)
 * compares MEASURED clones against the committed ceiling. The ratchet here
 * compares the COMMITTED ceiling against a git base ref, so a change can lower
 * it but never raise it. Both fail closed: a malformed or unreachable ceiling
 * is never treated as "no ceiling".
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SlopslintError, ensure } from "./errors.ts";
import { YamlError, isMapping, parseYamlStrict } from "./yaml.ts";

/** Path of the ceilings file, relative to the repository root. */
export const CEILINGS_PATH = ".slop/ceilings.yml";

/** The validated ceilings document. */
export interface CeilingsConfig {
  schema: 1;
  scopes: Record<string, { active_clones_ceiling: number }>;
}

/** Parse and validate a ceilings document from text. */
export function loadCeilingsFromText(raw: string, what: string): CeilingsConfig {
  let parsed: unknown;
  try {
    parsed = parseYamlStrict(raw);
  } catch (error) {
    const detail = error instanceof YamlError ? error.message : String(error);
    throw new SlopslintError(`invalid YAML in ${what}: ${detail}`);
  }
  ensure(isMapping(parsed), `${what} must be a mapping`);
  ensure(parsed["schema"] === 1, `${what}: schema must be 1`);
  const scopesRaw = parsed["scopes"];
  ensure(
    isMapping(scopesRaw) && Object.keys(scopesRaw).length > 0,
    `${what}: missing or empty scopes`,
  );

  const scopes: Record<string, { active_clones_ceiling: number }> = {};
  for (const [name, value] of Object.entries(scopesRaw)) {
    ensure(isMapping(value), `${what}: scope ${name} must be a mapping`);
    const ceiling = value["active_clones_ceiling"];
    ensure(
      typeof ceiling === "number" && Number.isInteger(ceiling),
      `${what}: scope ${name} active_clones_ceiling must be a non-negative ` +
        `integer (got ${typeof ceiling} ${JSON.stringify(ceiling ?? null)})`,
    );
    ensure(
      ceiling >= 0,
      `${what}: scope ${name} active_clones_ceiling must be a non-negative ` +
        `integer (got ${ceiling})`,
    );
    scopes[name] = { active_clones_ceiling: ceiling };
  }
  return { schema: 1, scopes };
}

/** Load and validate the ceilings file at `path`. */
export function loadCeilings(path: string): CeilingsConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SlopslintError(`ceilings file is missing or invalid YAML: ${String(error)}`);
  }
  return loadCeilingsFromText(text, `head (${path})`);
}

/**
 * Read the base ref's ceilings file through `git show`.
 *
 * Returns `undefined` when the file does not exist in an otherwise valid,
 * reachable ref (bootstrap — the ceiling is being introduced). Every other git
 * failure, including an unreachable ref in a shallow clone, fails closed.
 */
export function getBaseText(baseRef: string, repoRoot?: string): string | undefined {
  const result = spawnSync("git", ["show", `${baseRef}:${CEILINGS_PATH}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    timeout: 30_000,
  });
  if (result.error) {
    throw new SlopslintError(`git show ${baseRef} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    if (stderr.includes("exists on disk, but not in") || stderr.includes("does not exist in")) {
      return undefined;
    }
    throw new SlopslintError(
      `cannot fetch ${CEILINGS_PATH} from ${baseRef}: ${stderr.split("\n")[0] ?? ""}`,
    );
  }
  return result.stdout;
}

/** Outcome of a ratchet check. */
export interface RatchetResult {
  bootstrap: boolean;
  decreases: string[];
  summary: string;
}

/**
 * Verify the committed ceilings only decrease against `baseRef`.
 *
 * Fails closed on a missing or unfetchable ref, a malformed ceilings document
 * on either side, a scope-set mismatch, or any increase.
 */
export function ratchet(baseRef: string, repoRoot: string): RatchetResult {
  ensure(baseRef.trim().length > 0, "base-ref must be non-empty");

  const baseText = getBaseText(baseRef, repoRoot);
  if (baseText === undefined) {
    return {
      bootstrap: true,
      decreases: [],
      summary:
        `Ceiling ratchet OK: ${CEILINGS_PATH} not present at ${baseRef} ` +
        `(bootstrap - initial introduction).`,
    };
  }

  const base = loadCeilingsFromText(baseText, `base (${baseRef})`);
  const head = loadCeilings(`${repoRoot}/${CEILINGS_PATH}`);

  const headScopes = Object.keys(head.scopes).sort();
  const baseScopes = Object.keys(base.scopes).sort();
  ensure(
    JSON.stringify(headScopes) === JSON.stringify(baseScopes),
    `scope mismatch: head has ${JSON.stringify(headScopes)}, ` +
      `base has ${JSON.stringify(baseScopes)}`,
  );

  const violations: string[] = [];
  const decreases: string[] = [];
  for (const scope of headScopes) {
    const headValue = head.scopes[scope]!.active_clones_ceiling;
    const baseValue = base.scopes[scope]!.active_clones_ceiling;
    if (headValue > baseValue) {
      violations.push(`  ${scope}: ${baseValue} -> ${headValue} (INCREASE)`);
    } else if (headValue < baseValue) {
      decreases.push(`  ${scope}: ${baseValue} -> ${headValue} (decrease - OK)`);
    }
  }

  if (violations.length > 0) {
    throw new SlopslintError(
      `CEILING VIOLATION: committed ceilings increased from base (${baseRef}):\n` +
        `${violations.join("\n")}\n` +
        `The ceiling ratchet is monotonic - ceilings can only go DOWN.`,
    );
  }

  const parts = headScopes
    .map((scope) => `${scope}=${head.scopes[scope]!.active_clones_ceiling}`)
    .join(" ");
  return {
    bootstrap: false,
    decreases,
    summary: `Ceiling ratchet OK: base=${baseRef} ${parts}`,
  };
}
