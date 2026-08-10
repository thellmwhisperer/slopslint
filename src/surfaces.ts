/**
 * @overview Deterministic generic surface enumeration. ~140 lines, 3 public symbols.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at enumerateSurfaces()       <- CORE census entry
 *   2. exportedSymbols()                  <- JS/TS export discovery
 *   3. select()                           <- sorted fail-closed glob expansion
 *
 *   MAIN FLOW
 *   SurfaceGlobs -> fast-glob -> export parsing -> sorted Surface[]
 *
 *   PUBLIC API
 *   enumerateSurfaces()  Enumerate files, directories, and exported symbols
 *   surfaceId()          Stable committed identity for one surface
 *   Surface              Canonical surface record
 *
 *   INTERNALS
 *   select, exportedSymbols, compareSurface
 *
 * @exports enumerateSurfaces, surfaceId, Surface
 * @deps fast-glob, node:fs, SurfaceGlobs, errors
 */
import fastGlob from "fast-glob";
import { readFileSync } from "node:fs";
import type { SurfaceGlobs } from "./config.ts";
import { SlopslintError } from "./errors.ts";

/** One configured public or orphan-census surface. */
export interface Surface {
  scope: string;
  kind: "file" | "directory" | "exported_symbol";
  path: string;
  symbol?: string;
}

/** Stable map key for a surface. */
export function surfaceId(surface: Surface): string {
  return surface.kind === "exported_symbol"
    ? `${surface.path}#${surface.symbol}`
    : surface.path;
}

function select(
  patterns: readonly string[],
  cwd: string,
  ignore: readonly string[],
  onlyDirectories: boolean,
): string[] {
  if (patterns.length === 0) return [];
  return fastGlob
    .sync([...patterns], {
      cwd,
      ignore: [...ignore, ".git/**", "node_modules/**"],
      onlyFiles: !onlyDirectories,
      onlyDirectories,
      dot: true,
      absolute: false,
      followSymbolicLinks: false,
      suppressErrors: true,
      unique: true,
    })
    .map((path) => path.replaceAll("\\", "/").replace(/\/$/, ""))
    .sort();
}

function exportedSymbols(text: string): string[] {
  const names = new Set<string>();
  const declarations =
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declarations)) names.add(match[1]!);

  const lists = /\bexport\s*\{([^}]+)\}/g;
  for (const match of text.matchAll(lists)) {
    for (const item of match[1]!.split(",")) {
      const clean = item.trim().replace(/^type\s+/, "");
      if (!clean) continue;
      const parts = clean.split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0])?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(text)) names.add("default");
  for (const match of text.matchAll(/\b(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

function compareSurface(left: Surface, right: Surface): number {
  const a = `${left.scope}\0${left.kind}\0${surfaceId(left)}`;
  const b = `${right.scope}\0${right.kind}\0${surfaceId(right)}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

// -- 1/1 CORE · enumerateSurfaces -- <- START HERE

/** Enumerate configured surfaces, rejecting unreadable symbol source files. */
export function enumerateSurfaces(
  repoRoot: string,
  scope: string,
  config: SurfaceGlobs,
  globalIgnore: readonly string[] = [],
): Surface[] {
  const ignore = [...globalIgnore, ...config.ignore];
  const result: Surface[] = [];
  for (const path of select(config.files, repoRoot, ignore, false)) {
    result.push({ scope, kind: "file", path });
  }
  for (const path of select(config.directories, repoRoot, ignore, true)) {
    result.push({ scope, kind: "directory", path });
  }
  for (const path of select(config.exported_symbols, repoRoot, ignore, false)) {
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${path}`, "utf8");
    } catch (error) {
      throw new SlopslintError(`cannot read exported-symbol surface ${path}: ${String(error)}`);
    }
    for (const symbol of exportedSymbols(text)) {
      result.push({ scope, kind: "exported_symbol", path, symbol });
    }
  }

  const ids = new Set<string>();
  for (const surface of result) {
    const id = `${surface.kind}\0${surfaceId(surface)}`;
    if (ids.has(id)) {
      throw new SlopslintError(`surface ${surfaceId(surface)} is selected more than once in ${scope}`);
    }
    ids.add(id);
  }
  if (result.length === 0) {
    throw new SlopslintError(
      `surface scope ${scope} selected zero files, directories, or exported symbols`,
    );
  }
  return result.sort(compareSurface);
}

// -/ 1/1
