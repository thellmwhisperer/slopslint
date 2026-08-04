/**
 * `slopslint check` — run every configured scope and return a privacy-safe
 * summary.
 *
 * Three layers, each strictly additive:
 *   * default: measure and report (the canonical S1 report and its identity);
 *   * `--classify`: apply tombstone records, splitting accepted from active;
 *   * `--enforce`: fail closed on ceiling violations and stale tombstones.
 */
import { join } from "node:path";
import type { CanonicalReport, UnmatchedTombstone } from "./canonical.ts";
import { canonicalSha256, canonicalizeReport, enforceReport } from "./canonical.ts";
import { loadConfig } from "./config.ts";
import { scanScope } from "./detector.ts";
import { SlopslintError } from "./errors.ts";
import { loadCeilings } from "./ceilings.ts";
import type { LoadOptions, Tombstone } from "./tombstone.ts";
import {
  asUnmatched,
  classifyDuplicates,
  family,
  loadTombstones,
  standingTombstones,
} from "./tombstone.ts";

/** Options for {@link runCheck}. */
export interface CheckOptions {
  repoRoot: string;
  classify?: boolean;
  enforce?: boolean;
  tombstonesDir?: string;
  ceilingsPath?: string;
}

/** One scope's entry in the summary. */
export interface ScopeSummary {
  scope: string;
  sha256: string;
  statistics: CanonicalReport["statistics"];
  clones: number;
  diagnostics?: { unmatched_tombstones: UnmatchedTombstone[] };
}

/** The `--classify` summary shape. */
export interface ClassifiedSummary {
  scopes: ScopeSummary[];
  diagnostics: {
    unmatched_tombstones: UnmatchedTombstone[];
    standing_tombstones: { id: string; category: string; family: string | undefined }[];
  };
}

/**
 * Apply tombstones to a canonical report (the classify integration).
 *
 * Pure: every S1 field is carried through unchanged, the statistics gain
 * active/accepted counts, and this scope's stale records become diagnostics.
 */
export function classifyReport(
  report: CanonicalReport,
  tombstones: readonly Tombstone[],
): CanonicalReport {
  const classification = classifyDuplicates(report.duplicates, report.scope, tombstones);
  return {
    ...report,
    statistics: {
      ...report.statistics,
      active_clones: classification.activeCount,
      accepted_clones: classification.acceptedCount,
    },
    duplicates: classification.duplicates,
    diagnostics: {
      unmatched_tombstones: classification.unmatched.map(asUnmatched),
    },
  };
}

function loadRecords(options: CheckOptions, scopeNames: string[]): Tombstone[] {
  const dir = options.tombstonesDir ?? join(options.repoRoot, ".slop", "tombstones");
  const loadOptions: LoadOptions = {
    repoRoot: options.repoRoot,
    allowedScopes: scopeNames,
  };
  return loadTombstones(dir, loadOptions);
}

function assertScopeParity(configScopes: string[], ceilingScopes: string[]): void {
  const extra = ceilingScopes.filter((scope) => !configScopes.includes(scope)).sort();
  const missing = configScopes.filter((scope) => !ceilingScopes.includes(scope)).sort();
  if (extra.length > 0) {
    throw new SlopslintError(
      `ceilings defines unknown scope(s) ${JSON.stringify(extra)} not in .slop/config.yml`,
    );
  }
  if (missing.length > 0) {
    throw new SlopslintError(
      `ceilings missing scope(s) ${JSON.stringify(missing)} present in .slop/config.yml`,
    );
  }
}

/** Run every configured scope; return the report-only or classified summary. */
export function runCheck(options: CheckOptions): ScopeSummary[] | ClassifiedSummary {
  if (options.enforce && !options.classify) {
    throw new SlopslintError("--enforce requires --classify");
  }

  const config = loadConfig(join(options.repoRoot, ".slop", "config.yml"));
  const scopeNames = Object.keys(config.scopes);

  const records = options.classify ? loadRecords(options, scopeNames) : [];

  let ceilingsPath: string | undefined;
  let ceilings: ReturnType<typeof loadCeilings> | undefined;
  if (options.enforce) {
    ceilingsPath = options.ceilingsPath ?? join(options.repoRoot, ".slop", "ceilings.yml");
    ceilings = loadCeilings(ceilingsPath);
    // Scope parity: the ceiling config must cover exactly the detection
    // scopes, so no scope is silently left unenforced.
    assertScopeParity(scopeNames, Object.keys(ceilings.scopes));
  }

  const summary: ScopeSummary[] = [];
  const unmatched: UnmatchedTombstone[] = [];
  for (const [scopeName, scopeConfig] of Object.entries(config.scopes)) {
    const raw = scanScope(
      scopeName,
      scopeConfig,
      config.defaults,
      config.global_ignore,
      options.repoRoot,
    );
    const report = canonicalizeReport(raw, scopeName, config.defaults);
    const entry: ScopeSummary = {
      scope: scopeName,
      // The measured identity is unchanged by classification.
      sha256: canonicalSha256(report),
      statistics: report.statistics,
      clones: report.duplicates.length,
    };
    if (options.classify) {
      const classified = classifyReport(report, records);
      entry.statistics = classified.statistics;
      entry.diagnostics = classified.diagnostics!;
      unmatched.push(...classified.diagnostics!.unmatched_tombstones);
      if (options.enforce && ceilings) {
        const ceiling = ceilings.scopes[scopeName]!.active_clones_ceiling;
        enforceReport(classified, ceiling, ceilingsPath);
      }
    }
    summary.push(entry);
  }

  if (!options.classify) {
    return summary;
  }

  return {
    scopes: summary,
    diagnostics: {
      unmatched_tombstones: unmatched.sort((left, right) => {
        const key = (record: UnmatchedTombstone): string =>
          `${record.scope ?? ""} ${record.fingerprint ?? ""} ${record.id}`;
        return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
      }),
      standing_tombstones: standingTombstones(records).map((record) => ({
        id: record.id,
        category: record.category,
        family: family(record),
      })),
    },
  };
}
