// Mechanical public-surface claim synchronization.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ClaimsConfig } from "./config.ts";
import { ensureRepoRelative } from "./config.ts";
import { SlopslintError, ensure } from "./errors.ts";
import { enumerateSurfaces, surfaceId } from "./surfaces.ts";
import { YamlError, isMapping, parseYamlStrict } from "./yaml.ts";

interface ClaimEntry {
  contract: { file: string; item: string };
}

/** One verified surface-to-contract mapping. */
export interface VerifiedClaim {
  scope: string;
  kind: "file" | "directory" | "exported_symbol";
  surface: string;
  contract: { file: string; item: string };
}

/** Deterministic claims verification output. */
export interface ClaimsReport {
  count: number;
  surfaces: VerifiedClaim[];
}

/** Resolve a declared file and reject symlinks that leave the repository. */
function resolveRepoFile(repoRoot: string, path: string, missingMessage: string): string {
  const requested = join(repoRoot, path);
  ensure(existsSync(requested), missingMessage);
  let root: string;
  let resolved: string;
  try {
    root = realpathSync(repoRoot);
    resolved = realpathSync(requested);
  } catch (error) {
    throw new SlopslintError(`cannot resolve repository file ${path}: ${String(error)}`);
  }
  const fromRoot = relative(root, resolved);
  ensure(
    fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
    `repository file escapes the repository after symlink resolution: ${path}`,
  );
  return resolved;
}

function loadClaims(repoRoot: string, path: string): Record<string, ClaimEntry> {
  let parsed: unknown;
  try {
    const resolved = resolveRepoFile(repoRoot, path, `claims file does not exist: ${path}`);
    parsed = parseYamlStrict(readFileSync(resolved, "utf8"));
  } catch (error) {
    if (error instanceof SlopslintError) throw error;
    const detail = error instanceof YamlError ? error.message : String(error);
    throw new SlopslintError(`claims file is missing or invalid YAML: ${detail}`);
  }
  ensure(isMapping(parsed), "claims file must be a mapping");
  ensure(parsed["schema"] === 1, "claims file schema must be 1");
  const rawClaims = parsed["claims"];
  ensure(isMapping(rawClaims), "claims file claims must be a mapping");
  const claims: Record<string, ClaimEntry> = {};
  for (const [surface, raw] of Object.entries(rawClaims)) {
    ensure(surface.length > 0, "claims keys must be non-empty surface ids");
    ensure(isMapping(raw), `claim ${surface} must be a mapping`);
    const contract = raw["contract"];
    ensure(isMapping(contract), `claim ${surface}.contract must be a mapping`);
    const file = contract["file"];
    const item = contract["item"];
    ensure(typeof file === "string" && file.length > 0, `claim ${surface}.contract.file missing`);
    ensureRepoRelative(file as string, `claim ${surface}.contract.file`);
    ensure(typeof item === "string" && item.length > 0, `claim ${surface}.contract.item missing`);
    claims[surface] = { contract: { file: file as string, item: item as string } };
  }
  return claims;
}


/** Verify every censused surface has a live contract file containing its opaque item. */
export function verifyClaims(
  repoRoot: string,
  config: ClaimsConfig,
  globalIgnore: readonly string[] = [],
): ClaimsReport {
  const claims = loadClaims(repoRoot, config.file);
  const surfaces = Object.entries(config.surfaces)
    .flatMap(([scope, surfaceConfig]) =>
      enumerateSurfaces(repoRoot, scope, surfaceConfig, globalIgnore),
    )
    .sort((left, right) => {
      const a = `${left.scope}\0${surfaceId(left)}`;
      const b = `${right.scope}\0${surfaceId(right)}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const ids = new Set(surfaces.map(surfaceId));
  ensure(
    ids.size === surfaces.length,
    "claims surface globs overlap: one surface identity was selected by multiple groups",
  );
  const missing = surfaces.map(surfaceId).filter((id) => claims[id] === undefined);
  ensure(missing.length === 0, `unclaimed public surface(s): ${JSON.stringify(missing)}`);

  const stale = Object.keys(claims).filter((id) => !ids.has(id)).sort();
  ensure(stale.length === 0, `claims entries name uncensused surface(s): ${JSON.stringify(stale)}`);

  const verified: VerifiedClaim[] = [];
  for (const surface of surfaces) {
    const id = surfaceId(surface);
    const contract = claims[id]!.contract;
    const contractPath = resolveRepoFile(
      repoRoot,
      contract.file,
      `claim ${id} contract file does not exist: ${contract.file}`,
    );
    let text: string;
    try {
      text = readFileSync(contractPath, "utf8");
    } catch (error) {
      throw new SlopslintError(`cannot read claim ${id} contract file ${contract.file}: ${String(error)}`);
    }
    ensure(
      text.includes(contract.item),
      `claim ${id} contract file ${contract.file} does not contain item ${contract.item}`,
    );
    verified.push({
      scope: surface.scope,
      kind: surface.kind,
      surface: id,
      contract,
    });
  }
  return { count: verified.length, surfaces: verified };
}
