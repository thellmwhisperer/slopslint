// Deterministic enumeration of configured files, directories, and exported symbols.
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

/** Mask comments and string literals while preserving source layout for lexical export scans. */
function maskCommentsAndStrings(text: string): string {
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const next = text[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        result += "  ";
        state = "line";
        index += 1;
      } else if (character === "/" && next === "*") {
        result += "  ";
        state = "block";
        index += 1;
      } else if (character === "'" || character === '"' || character === "`") {
        result += " ";
        state = character === "'" ? "single" : character === '"' ? "double" : "template";
      } else {
        result += character;
      }
      continue;
    }
    if (character === "\n") {
      result += "\n";
      if (state === "line") state = "code";
      continue;
    }
    if (state === "block" && character === "*" && next === "/") {
      result += "  ";
      state = "code";
      index += 1;
      continue;
    }
    if (character === "\\" && state !== "line" && state !== "block" && next !== undefined) {
      result += next === "\n" ? " \n" : "  ";
      index += 1;
      continue;
    }
    const closes =
      (state === "single" && character === "'") ||
      (state === "double" && character === '"') ||
      (state === "template" && character === "`");
    result += " ";
    if (closes) state = "code";
  }
  return result;
}

function exportedSymbols(text: string): string[] {
  const code = maskCommentsAndStrings(text);
  const names = new Set<string>();
  const declarations =
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of code.matchAll(declarations)) names.add(match[1]!);

  const lists = /\bexport\s*\{([^}]+)\}/g;
  for (const match of code.matchAll(lists)) {
    for (const item of match[1]!.split(",")) {
      const clean = item.trim().replace(/^type\s+/, "");
      if (!clean) continue;
      const parts = clean.split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0])?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(code)) names.add("default");
  for (const match of code.matchAll(/\b(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

function compareSurface(left: Surface, right: Surface): number {
  const a = `${left.scope}\0${left.kind}\0${surfaceId(left)}`;
  const b = `${right.scope}\0${right.kind}\0${surfaceId(right)}`;
  return a < b ? -1 : a > b ? 1 : 0;
}


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
