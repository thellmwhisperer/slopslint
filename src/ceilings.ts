// Committed clone/orphan ceilings and monotonic ratchet.
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
  orphan_scopes?: Record<string, { active_orphans_ceiling: number }>;
}

function loadScopeCeilings(
  raw: unknown,
  what: string,
  key: "active_clones_ceiling" | "active_orphans_ceiling",
  required: boolean,
): Record<string, Record<typeof key, number>> | undefined {
  if (raw === undefined && !required) return undefined;
  ensure(
    isMapping(raw) && Object.keys(raw).length > 0,
    `${what}: missing or empty ${key === "active_clones_ceiling" ? "scopes" : "orphan_scopes"}`,
  );
  const result: Record<string, Record<typeof key, number>> = {};
  for (const [name, value] of Object.entries(raw)) {
    ensure(isMapping(value), `${what}: scope ${name} must be a mapping`);
    const ceiling = value[key];
    ensure(
      typeof ceiling === "number" && Number.isInteger(ceiling) && ceiling >= 0,
      `${what}: scope ${name} ${key} must be a non-negative integer ` +
        `(got ${typeof ceiling} ${JSON.stringify(ceiling ?? null)})`,
    );
    result[name] = { [key]: ceiling } as Record<typeof key, number>;
  }
  return result;
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
  const scopes = loadScopeCeilings(
    parsed["scopes"],
    what,
    "active_clones_ceiling",
    true,
  ) as Record<string, { active_clones_ceiling: number }>;
  const orphanScopes = loadScopeCeilings(
    parsed["orphan_scopes"],
    what,
    "active_orphans_ceiling",
    false,
  ) as Record<string, { active_orphans_ceiling: number }> | undefined;
  return { schema: 1, scopes, ...(orphanScopes ? { orphan_scopes: orphanScopes } : {}) };
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

function compareCeilings(
  label: string,
  key: "active_clones_ceiling" | "active_orphans_ceiling",
  headRaw: Record<string, Record<string, number>> | undefined,
  baseRaw: Record<string, Record<string, number>> | undefined,
  violations: string[],
  decreases: string[],
  allowIntroduction = false,
): string[] {
  const head = headRaw ?? {};
  const base = baseRaw ?? {};
  const headNames = Object.keys(head).sort();
  const baseNames = Object.keys(base).sort();
  if (allowIntroduction && baseRaw === undefined && headRaw !== undefined) {
    return headNames.map((scope) => `orphan_scopes.${scope}=${head[scope]![key]}`);
  }
  const mismatchLabel = label === "duplication" ? "scope mismatch" : "orphan scope mismatch";
  ensure(
    JSON.stringify(headNames) === JSON.stringify(baseNames),
    `${mismatchLabel}: head has ${JSON.stringify(headNames)}, ` +
      `base has ${JSON.stringify(baseNames)}`,
  );
  for (const scope of headNames) {
    const headValue = head[scope]![key]!;
    const baseValue = base[scope]![key]!;
    const prefix = label === "duplication" ? scope : `orphan_scopes.${scope}`;
    if (headValue > baseValue) violations.push(`  ${prefix}: ${baseValue} -> ${headValue} (INCREASE)`);
    else if (headValue < baseValue) decreases.push(`  ${prefix}: ${baseValue} -> ${headValue} (decrease - OK)`);
  }
  return headNames.map((scope) =>
    label === "duplication"
      ? `${scope}=${head[scope]![key]}`
      : `orphan_scopes.${scope}=${head[scope]![key]}`,
  );
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

  const violations: string[] = [];
  const decreases: string[] = [];
  const parts = [
    ...compareCeilings("duplication", "active_clones_ceiling", head.scopes, base.scopes, violations, decreases),
    ...compareCeilings(
      "orphans",
      "active_orphans_ceiling",
      head.orphan_scopes,
      base.orphan_scopes,
      violations,
      decreases,
      true,
    ),
  ];

  if (violations.length > 0) {
    throw new SlopslintError(
      `CEILING VIOLATION: committed ceilings increased from base (${baseRef}):\n` +
        `${violations.join("\n")}\n` +
        `The ceiling ratchet is monotonic - ceilings can only go DOWN.`,
    );
  }

  return {
    bootstrap: false,
    decreases,
    summary: `Ceiling ratchet OK: base=${baseRef} ${parts.join(" ")}`,
  };
}
