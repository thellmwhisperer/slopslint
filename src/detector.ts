/**
 * Duplication detection over one scope, using the jscpd libraries directly.
 *
 * `@jscpd/tokenizer` supplies the language grammars and the rolling
 * `minTokens`-wide frame hashes; `@jscpd/core` supplies the token modes. Clone
 * ASSEMBLY (deciding when consecutive frame hits belong to one clone) lives
 * here rather than in `@jscpd/core`'s `RabinKarp`, because that loop extends an
 * open clone with whatever frame the store last returned, without checking that
 * the stored side advanced. When a hash hit jumps backwards it emits a clone
 * whose end line precedes its start line — `roca-madre`'s
 * `py/roca/ingest/ingest_sessions.py` reproduces it as `784-640`. A range that
 * cannot exist is exactly what a fail-closed canonicalizer must reject, so the
 * assembly here requires both sides to advance monotonically and closes the
 * open clone when they do not. `test/detector.test.ts` pins that invariant.
 *
 * Scope independence needs no glob guard. `fast-glob`'s `*` does not cross `/`,
 * so `**\/{test_*,conftest}.py` matches basenames only and a directory named
 * `test_data/` keeps its production files in the production scope. The Python
 * predecessor carried a whole prefix-analysis guard because the detector it
 * shelled out to matched globs with separator-crossing wildcards;
 * `test/detector.test.ts` proves the property directly instead.
 */
import { getModeHandler } from "@jscpd/core";
import { Tokenizer, getFormatByFile } from "@jscpd/tokenizer";
import fastGlob from "fast-glob";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScanDefaults, ScopeConfig } from "./config.ts";
import { SlopslintError, ensure } from "./errors.ts";

/** One duplicated fragment pair, as the detector found it. */
export interface RawDuplicate {
  lines: number;
  tokens: number;
  firstFile: { name: string; start: number; end: number };
  secondFile: { name: string; start: number; end: number };
}

/** Totals for one scanned scope. */
export interface RawStatistics {
  sources: number;
  lines: number;
  duplicatedLines: number;
  clones: number;
}

/** The detector's output for one scope, before canonicalization. */
export interface RawReport {
  statistics: RawStatistics;
  duplicates: RawDuplicate[];
}

interface Frame {
  id: string;
  sourceId: string;
  startLine: number;
  endLine: number;
  startPos: number;
  endPos: number;
}

interface OpenClone {
  a: Frame;
  aEnd: Frame;
  b: Frame;
  bEnd: Frame;
}

/** Minimal shape of `@jscpd/tokenizer`'s map frames, kept local and explicit. */
interface TokenLike {
  loc?: { start: { line: number; position?: number }; end: { line: number; position?: number } };
}
interface MapFrameLike {
  id: string;
  sourceId: string;
  start: TokenLike;
  end: TokenLike;
}

function toFrame(raw: MapFrameLike): Frame | undefined {
  const start = raw.start.loc?.start;
  const end = raw.end.loc?.end;
  if (!start || !end || start.position === undefined || end.position === undefined) {
    return undefined;
  }
  return {
    id: raw.id,
    sourceId: raw.sourceId,
    startLine: start.line,
    endLine: end.line,
    startPos: start.position,
    endPos: end.position,
  };
}

/**
 * True when `next` continues `previous` inside the same source.
 *
 * Both endpoints must move forward. Without this check an open clone can absorb
 * a hash hit from an earlier position and end before it starts.
 */
function advances(previous: Frame, next: Frame): boolean {
  return (
    previous.sourceId === next.sourceId &&
    next.startPos > previous.startPos &&
    next.endPos >= previous.endPos
  );
}

/** Files a scope selects, as repository-relative POSIX paths. */
export function selectFiles(
  scope: ScopeConfig,
  defaults: ScanDefaults,
  globalIgnore: readonly string[],
  repoRoot: string,
): string[] {
  const pattern = `${scope.scan_path.replace(/\/+$/, "")}/${scope.pattern}`;
  const matched = fastGlob.sync([pattern], {
    cwd: repoRoot,
    ignore: [...globalIgnore, ...scope.ignore],
    onlyFiles: true,
    dot: true,
    absolute: false,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  return matched
    .filter((path) => getFormatByFile(path) === defaults.format)
    .sort();
}

/**
 * Scan one scope and return its raw duplication report.
 *
 * Deterministic by construction: files are scanned in sorted order and the
 * duplicate list is sorted before returning, so two runs over one immutable
 * tree produce byte-identical output.
 */
export function scanScope(
  scopeName: string,
  scope: ScopeConfig,
  defaults: ScanDefaults,
  globalIgnore: readonly string[],
  repoRoot: string,
): RawReport {
  let scanStat: ReturnType<typeof statSync>;
  try {
    scanStat = statSync(join(repoRoot, scope.scan_path));
  } catch {
    throw new SlopslintError(
      `scope ${scopeName}: scan_path ${scope.scan_path} does not exist under ${repoRoot}`,
    );
  }
  ensure(
    scanStat.isDirectory(),
    `scope ${scopeName}: scan_path ${scope.scan_path} is not a directory`,
  );

  const mode = getModeHandler(defaults.mode);
  ensure(typeof mode === "function", `unsupported detection mode: ${defaults.mode}`);
  const tokenizerOptions = {
    minTokens: defaults.min_tokens,
    minLines: defaults.min_lines,
    maxLines: Number.MAX_SAFE_INTEGER,
    mode,
  };

  const tokenizer = new Tokenizer();
  const store = new Map<string, Frame>();
  const duplicates: RawDuplicate[] = [];
  const duplicatedLines = new Set<string>();
  let totalLines = 0;
  let sources = 0;

  const close = (open: OpenClone | null): void => {
    if (!open) {
      return;
    }
    // Upstream's line-length validator: the span must exceed min_lines rows.
    if (open.aEnd.endLine - open.a.startLine < defaults.min_lines) {
      return;
    }
    const tokens = open.aEnd.endPos - open.a.startPos;
    if (tokens <= 0) {
      return;
    }
    duplicates.push({
      lines: open.aEnd.endLine - open.a.startLine + 1,
      tokens,
      firstFile: { name: open.a.sourceId, start: open.a.startLine, end: open.aEnd.endLine },
      secondFile: { name: open.b.sourceId, start: open.b.startLine, end: open.bEnd.endLine },
    });
    for (const side of [
      { name: open.a.sourceId, from: open.a.startLine, to: open.aEnd.endLine },
      { name: open.b.sourceId, from: open.b.startLine, to: open.bEnd.endLine },
    ]) {
      for (let line = side.from; line <= side.to; line += 1) {
        duplicatedLines.add(`${side.name}:${line}`);
      }
    }
  };

  for (const path of selectFiles(scope, defaults, globalIgnore, repoRoot)) {
    const content = readFileSync(join(repoRoot, path), "utf8");
    sources += 1;
    totalLines += content.split("\n").length;

    const maps = tokenizer.generateMaps(path, content, defaults.format, tokenizerOptions);
    for (const tokensMap of maps) {
      let open: OpenClone | null = null;
      let previousHit: Frame | null = null;
      let previousFrame: Frame | null = null;
      for (;;) {
        const iteration = tokensMap.next();
        if (iteration.done || typeof iteration.value === "boolean") {
          break;
        }
        const frame = toFrame(iteration.value as unknown as MapFrameLike);
        if (!frame) {
          continue;
        }
        const hit = store.get(frame.id);
        if (hit) {
          const continues =
            open !== null &&
            previousHit !== null &&
            previousFrame !== null &&
            advances(previousHit, hit) &&
            advances(previousFrame, frame);
          if (continues && open) {
            open.aEnd = frame;
            open.bEnd = hit;
          } else {
            close(open);
            open = { a: frame, aEnd: frame, b: hit, bEnd: hit };
          }
          previousHit = hit;
          previousFrame = frame;
        } else {
          close(open);
          open = null;
          previousHit = null;
          previousFrame = null;
          store.set(frame.id, frame);
        }
      }
      close(open);
    }
  }

  duplicates.sort((left, right) => {
    const key = (dup: RawDuplicate): string =>
      [
        dup.firstFile.name,
        String(dup.firstFile.start).padStart(9, "0"),
        String(dup.firstFile.end).padStart(9, "0"),
        dup.secondFile.name,
        String(dup.secondFile.start).padStart(9, "0"),
        String(dup.secondFile.end).padStart(9, "0"),
      ].join(" ");
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
  });

  return {
    statistics: {
      sources,
      lines: totalLines,
      duplicatedLines: duplicatedLines.size,
      clones: duplicates.length,
    },
    duplicates,
  };
}
