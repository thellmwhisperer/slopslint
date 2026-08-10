// Deterministic inbound-reference census for configured repository surfaces.
import fastGlob from "fast-glob";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { OrphanScopeConfig } from "./config.ts";
import { SlopslintError } from "./errors.ts";
import { enumerateSurfaces, surfaceId, type Surface } from "./surfaces.ts";
import type { Tombstone } from "./tombstone.ts";

export interface OrphanEvidence {
  source: string;
  reference: "import" | "path" | "symbol";
  reason: "self" | "test" | "generation";
}

/** One orphan and every inbound reference excluded from consumer status. */
export interface OrphanFinding extends Surface {
  fingerprint: string;
  evidence: OrphanEvidence[];
  status?: "active" | "accepted";
  tombstone?: string | null;
}

/** Canonical output for one orphan scope. */
export interface OrphanReport {
  scope: string;
  count: number;
  active_orphans?: number;
  accepted_orphans?: number;
  orphans: OrphanFinding[];
  diagnostics?: { unmatched_tombstones: { id: string; scope: string; fingerprint: string }[] };
}

interface TextSource {
  path: string;
  text: string;
  specifiers: readonly string[];
}

function readSources(repoRoot: string, ignore: readonly string[]): TextSource[] {
  const paths = fastGlob.sync(["**/*"], {
    cwd: repoRoot,
    ignore: [".git/**", ".slop/**", "node_modules/**", ...ignore],
    onlyFiles: true,
    dot: true,
    absolute: false,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  const result: TextSource[] = [];
  for (const path of paths.sort()) {
    try {
      const bytes = readFileSync(`${repoRoot}/${path}`);
      if (!bytes.includes(0)) {
        const text = bytes.toString("utf8");
        result.push({
          path: path.replaceAll("\\", "/"),
          text,
          specifiers: importSpecifiers(text),
        });
      }
    } catch {
      // Unreadable or non-text repository files cannot provide deterministic text evidence.
    }
  }
  return result;
}

function importSpecifiers(text: string): string[] {
  const result: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(pattern)) result.push(match[1]!);
  const sideEffect = /\bimport\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(sideEffect)) result.push(match[1]!);
  return result;
}

function resolveSpecifier(source: string, specifier: string): string | undefined {
  const clean = specifier.split(/[?#]/, 1)[0]!;
  if (clean.startsWith(".")) return posix.normalize(posix.join(posix.dirname(source), clean));
  if (clean.startsWith("/")) return undefined;
  return clean;
}

function moduleMatches(candidate: string, target: string): boolean {
  const withoutExtension = target.replace(/\.[^./]+$/, "");
  const candidateWithoutExtension = candidate.replace(/\.[^./]+$/, "");
  const directoryIndex = target.replace(/\/index\.[^./]+$/, "");
  return (
    candidate === target ||
    candidate === withoutExtension ||
    candidateWithoutExtension === withoutExtension ||
    candidate === directoryIndex
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasBoundedPathReference(text: string, target: string, directory: boolean): boolean {
  const descendant = directory ? "(?:/[A-Za-z0-9_@+.-]+)*" : "";
  return new RegExp(
    `(?:^|[^A-Za-z0-9_./-])${escapeRegExp(target)}${descendant}(?=$|[^A-Za-z0-9_./-])`,
    "m",
  ).test(text);
}

function referencesPath(source: TextSource, surface: Surface): "import" | "path" | undefined {
  for (const specifier of source.specifiers) {
    const candidate = resolveSpecifier(source.path, specifier);
    if (!candidate) continue;
    if (surface.kind === "directory") {
      if (candidate === surface.path || candidate.startsWith(`${surface.path}/`)) return "import";
    } else if (moduleMatches(candidate, surface.path)) {
      return "import";
    }
  }
  if (hasBoundedPathReference(source.text, surface.path, surface.kind === "directory")) return "path";
  return undefined;
}

function referencesSymbol(source: TextSource, surface: Surface): boolean {
  const symbol = surface.symbol!;
  const escapedSymbol = escapeRegExp(symbol);
  for (const match of source.text.matchAll(/\b(?:import|export)\s*\{([^}]+)\}\s*from\s*["'`]([^"'`]+)["'`]/g)) {
    const candidate = resolveSpecifier(source.path, match[2]!);
    if (!candidate || !moduleMatches(candidate, surface.path)) continue;
    const names = match[1]!.split(",").map((item) => {
      const clean = item.trim().replace(/^type\s+/, "");
      return clean.split(/\s+as\s+/)[0]?.trim();
    });
    if (names.includes(symbol)) return true;
  }
  if (symbol === "default") {
    for (const match of source.text.matchAll(/\bimport\s+[A-Za-z_$][\w$]*\s+from\s*["'`]([^"'`]+)["'`]/g)) {
      const candidate = resolveSpecifier(source.path, match[1]!);
      if (candidate && moduleMatches(candidate, surface.path)) return true;
    }
  }
  for (const match of source.text.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    const candidate = resolveSpecifier(source.path, match[2]!);
    if (!candidate || !moduleMatches(candidate, surface.path)) continue;
    const names = match[1]!.split(",").map((item) => item.trim().split(/\s*:\s*/)[0]);
    if (names.includes(symbol)) return true;
  }
  for (const match of source.text.matchAll(/\bimport\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*["'`]([^"'`]+)["'`]/g)) {
    const candidate = resolveSpecifier(source.path, match[2]!);
    if (candidate && moduleMatches(candidate, surface.path)) {
      const namespace = match[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${namespace}\\.${escapedSymbol}\\b`).test(source.text)) return true;
    }
  }
  for (const match of source.text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    const candidate = resolveSpecifier(source.path, match[2]!);
    if (candidate && moduleMatches(candidate, surface.path)) {
      const namespace = match[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${namespace}\\.${escapedSymbol}\\b`).test(source.text)) return true;
    }
  }
  return false;
}

function matchedPaths(patterns: readonly string[], repoRoot: string): ReadonlySet<string> {
  if (patterns.length === 0) return new Set();
  return new Set(fastGlob.sync([...patterns], {
    cwd: repoRoot,
    onlyFiles: true,
    dot: true,
    absolute: false,
    followSymbolicLinks: false,
  }).map((candidate) => candidate.replaceAll("\\", "/")));
}

function classifyReason(
  source: string,
  surface: Surface,
  testFiles: ReadonlySet<string>,
  generationFiles: ReadonlySet<string>,
): OrphanEvidence["reason"] | "consumer" {
  const self =
    surface.kind === "directory"
      ? source === surface.path || source.startsWith(`${surface.path}/`)
      : source === surface.path;
  if (self) return "self";
  if (generationFiles.has(source)) return "generation";
  if (testFiles.has(source)) return "test";
  return "consumer";
}

function orphanFingerprint(surface: Surface): string {
  return createHash("sha256")
    .update(JSON.stringify([surface.scope, surface.kind, surface.path, surface.symbol ?? null]))
    .digest("hex");
}

function referencesFor(
  surface: Surface,
  sources: readonly TextSource[],
  testFiles: ReadonlySet<string>,
  generationFiles: ReadonlySet<string>,
): { ignored: OrphanEvidence[]; consumed: boolean } {
  const ignored: OrphanEvidence[] = [];
  let consumed = false;
  for (const source of sources) {
    const reference =
      surface.kind === "exported_symbol"
        ? referencesSymbol(source, surface)
          ? "symbol"
          : source.path === surface.path && source.text.includes(surface.symbol!)
            ? "symbol"
            : undefined
        : referencesPath(source, surface);
    if (!reference) continue;
    const reason = classifyReason(source.path, surface, testFiles, generationFiles);
    if (reason === "consumer") consumed = true;
    else ignored.push({ source: source.path, reference, reason });
  }
  ignored.sort((a, b) => {
    const left = `${a.source}\0${a.reference}\0${a.reason}`;
    const right = `${b.source}\0${b.reference}\0${b.reason}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { ignored, consumed };
}


/** Census one scope and return only surfaces without a genuine external consumer. */
export function censusOrphans(
  repoRoot: string,
  scope: string,
  config: OrphanScopeConfig,
  globalIgnore: readonly string[],
): OrphanReport {
  const surfaces = enumerateSurfaces(repoRoot, scope, config, globalIgnore);
  const sources = readSources(repoRoot, [...globalIgnore, ...config.ignore]);
  const testFiles = matchedPaths(config.test_files, repoRoot);
  const generationFiles = matchedPaths(config.generation_files, repoRoot);
  const orphans: OrphanFinding[] = [];
  for (const surface of surfaces) {
    const references = referencesFor(surface, sources, testFiles, generationFiles);
    if (!references.consumed) {
      orphans.push({
        ...surface,
        fingerprint: orphanFingerprint(surface),
        evidence: references.ignored,
      });
    }
  }
  return { scope, count: orphans.length, orphans };
}



/** Apply `orphan_fingerprint` tombstones to one census report. */
export function classifyOrphans(report: OrphanReport, tombstones: readonly Tombstone[]): OrphanReport {
  const matching = tombstones.filter(
    (record) => record.category === "orphan" && record.match["scope"] === report.scope,
  );
  const byFingerprint = new Map(
    matching.map((record) => [String(record.match["fingerprint"]), record.id]),
  );
  const seen = new Set<string>();
  const orphans = report.orphans.map((orphan) => {
    const id = byFingerprint.get(orphan.fingerprint);
    if (id !== undefined) seen.add(orphan.fingerprint);
    return {
      ...orphan,
      status: id !== undefined ? "accepted" as const : "active" as const,
      tombstone: id ?? null,
    };
  });
  const unmatched = matching
    .filter((record) => !seen.has(String(record.match["fingerprint"])))
    .map((record) => ({
      id: record.id,
      scope: String(record.match["scope"]),
      fingerprint: String(record.match["fingerprint"]),
    }));
  return {
    ...report,
    active_orphans: orphans.filter((item) => item.status === "active").length,
    accepted_orphans: orphans.filter((item) => item.status === "accepted").length,
    orphans,
    diagnostics: { unmatched_tombstones: unmatched },
  };
}



/** Enforce the committed active-orphan count and reject stale exemptions. */
export function enforceOrphanReport(report: OrphanReport, ceiling: number): void {
  if (report.active_orphans === undefined) {
    throw new SlopslintError(
      `Slopslint enforcement FAILED: ${report.scope} orphan report is not classified.`,
    );
  }
  const stale = report.diagnostics?.unmatched_tombstones ?? [];
  if (stale.length > 0) {
    throw new SlopslintError(
      `Slopslint enforcement FAILED: ${report.scope} has ${stale.length} stale orphan tombstone(s) ` +
        `${JSON.stringify(stale.map((item) => item.id).sort())}.`,
    );
  }
  const active = report.active_orphans;
  if (active > ceiling) {
    throw new SlopslintError(
      `Slopslint enforcement FAILED: ${report.scope} has ${active} active orphans, exceeding the ` +
        `committed ceiling of ${ceiling}. This is a regression - orphan debt increased.`,
    );
  }
  if (active < ceiling) {
    throw new SlopslintError(
      `Slopslint enforcement FAILED: ${report.scope} has ${active} active orphans, below the ` +
        `committed ceiling of ${ceiling}. Debt has decreased - lower ` +
        `orphan_scopes.${report.scope}.active_orphans_ceiling to ${active}.`,
    );
  }
}
