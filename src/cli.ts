#!/usr/bin/env node
// Command-line adapter for checks, ratchets, and tombstone management.
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { ratchet } from "./ceilings.ts";
import { runCheck } from "./check.ts";
import { loadConfig } from "./config.ts";
import { SlopslintError, TombstoneConfigError } from "./errors.ts";
import { findRepoRoot } from "./repo.ts";
import type { AddTombstoneOptions, LoadOptions } from "./tombstone.ts";
import {
  CATEGORIES,
  STATUSES,
  addTombstone,
  family,
  isDuplication,
  isOrphan,
  isStanding,
  loadTombstones,
} from "./tombstone.ts";
import { VERSION } from "./version.ts";


const USAGE = `slopslint ${VERSION} - blocking slop gate: duplication, orphans, claims, tombstones, ratchets.

usage:
  slopslint check [--classify] [--enforce] [--tombstones DIR] [--ceilings FILE]
  slopslint ratchet <base-ref>
  slopslint tombstone list [--tombstones DIR]
  slopslint tombstone check [--tombstones DIR]
  slopslint tombstone add --id ID --status STATUS --category CATEGORY \\
                          --title TITLE --family FAMILY [--artifact PATH] \\
                          [--scope SCOPE] [--fingerprint SHA256] [--created-at DATE]

global:
  --repo-root DIR   repository root holding .slop/ (default: walk up from cwd)
  --version         print the slopslint version
  --help            print this message

commands:
  check       run every configured detector and claims sync; --classify applies tombstones,
              --enforce fails closed on ceiling violations and stale records
  ratchet     verify committed ceilings only decrease against a git base ref
  tombstone   list, validate, or scaffold .slop/tombstones records
`;

interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

const VALUE_FLAGS = new Set([
  "--repo-root",
  "--tombstones",
  "--ceilings",
  "--id",
  "--status",
  "--category",
  "--title",
  "--family",
  "--artifact",
  "--scope",
  "--fingerprint",
  "--created-at",
  "--pattern",
  "--what-went-wrong",
  "--root-cause",
  "--rule-established",
  "--example",
]);

const BOOLEAN_FLAGS = new Set(["--classify", "--enforce", "--help", "-h", "--version"]);

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined) {
        throw new UsageError(`${name} requires a value`);
      }
      values.set(name, value);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    throw new UsageError(`unknown option: ${token}`);
  }
  return { positionals, flags, values };
}

function resolveRoot(args: ParsedArgs): string {
  const explicit = args.values.get("--repo-root");
  return explicit ? join(explicit) : findRepoRoot();
}

function tombstonesDir(args: ParsedArgs, root: string): string {
  return args.values.get("--tombstones") ?? join(root, ".slop", "tombstones");
}



function commandCheck(args: ParsedArgs, out: (line: string) => void): number {
  const options = {
    repoRoot: resolveRoot(args),
    classify: args.flags.has("--classify"),
    enforce: args.flags.has("--enforce"),
    ...(args.values.has("--tombstones")
      ? { tombstonesDir: args.values.get("--tombstones")! }
      : {}),
    ...(args.values.has("--ceilings") ? { ceilingsPath: args.values.get("--ceilings")! } : {}),
  };
  out(canonicalJson(runCheck(options)));
  return 0;
}

function commandRatchet(args: ParsedArgs, out: (line: string) => void): number {
  const baseRef = args.positionals[0];
  if (baseRef === undefined || args.positionals.length !== 1) {
    throw new UsageError("usage: slopslint ratchet <base-ref>");
  }
  const result = ratchet(baseRef, resolveRoot(args));
  for (const line of result.decreases) {
    out(line);
  }
  out(result.summary);
  return 0;
}



function loadOptionsFor(root: string): LoadOptions {
  const config = loadConfig(join(root, ".slop", "config.yml"));
  const orphanScopeNames = Object.keys(config.orphan_scopes ?? {});
  return {
    repoRoot: root,
    allowedScopes: Object.keys(config.scopes),
    ...(orphanScopeNames.length > 0 ? { allowedOrphanScopes: orphanScopeNames } : {}),
  };
}

function commandTombstoneList(args: ParsedArgs, out: (line: string) => void): number {
  const root = resolveRoot(args);
  const records = loadTombstones(tombstonesDir(args, root), loadOptionsFor(root));
  out(
    canonicalJson(
      records.map((record) => ({
        id: record.id,
        status: record.status,
        category: record.category,
        family: family(record),
        title: record.title,
      })),
    ),
  );
  return 0;
}

function commandTombstoneCheck(
  args: ParsedArgs,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const root = resolveRoot(args);
  const records = loadTombstones(tombstonesDir(args, root), loadOptionsFor(root));
  if (records.length === 0) {
    err("tombstone: no records to validate");
    return 2;
  }
  const duplication = records.filter(isDuplication).length;
  const orphans = records.filter(isOrphan).length;
  const standing = records.filter(isStanding).length;
  const detail =
    orphans === 0
      ? `${duplication} duplication, ${standing} standing`
      : `${duplication} duplication, ${orphans} orphan, ${standing} standing`;
  out(
    `tombstone: ${records.length} record(s) valid (${detail})`,
  );
  return 0;
}

function commandTombstoneAdd(args: ParsedArgs, out: (line: string) => void): number {
  const root = resolveRoot(args);
  const required = (name: string): string => {
    const value = args.values.get(name);
    if (value === undefined) {
      throw new UsageError(`${name} is required`);
    }
    return value;
  };
  const status = required("--status");
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new UsageError(`--status must be one of ${JSON.stringify([...STATUSES])}`);
  }
  const category = required("--category");
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw new UsageError(`--category must be one of ${JSON.stringify([...CATEGORIES])}`);
  }
  const config = loadConfig(join(root, ".slop", "config.yml"));
  const orphanScopeNames = Object.keys(config.orphan_scopes ?? {});
  const options: AddTombstoneOptions = {
    recordId: required("--id"),
    status,
    category,
    title: required("--title"),
    family: required("--family"),
    repoRoot: root,
    allowedScopes: Object.keys(config.scopes),
    ...(orphanScopeNames.length > 0 ? { allowedOrphanScopes: orphanScopeNames } : {}),
  };
  for (const [flag, key] of [
    ["--artifact", "artifact"],
    ["--scope", "scope"],
    ["--fingerprint", "fingerprint"],
    ["--created-at", "createdAt"],
    ["--pattern", "pattern"],
    ["--what-went-wrong", "whatWentWrong"],
    ["--root-cause", "rootCause"],
    ["--rule-established", "ruleEstablished"],
    ["--example", "example"],
  ] as const) {
    const value = args.values.get(flag);
    if (value !== undefined) {
      (options as unknown as Record<string, unknown>)[key] = value;
    }
  }
  out(`tombstone: wrote ${addTombstone(tombstonesDir(args, root), options)}`);
  return 0;
}



/** Run the CLI. Returns the process exit code; never throws. */
export function main(
  argv: readonly string[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  err: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): number {
  try {
    const args = parseArgs(argv);
    if (args.flags.has("--version")) {
      out(`slopslint ${VERSION}`);
      return 0;
    }
    if (args.flags.has("--help") || args.flags.has("-h") || args.positionals.length === 0) {
      out(USAGE);
      return args.positionals.length === 0 && !args.flags.has("--help") && !args.flags.has("-h")
        ? 2
        : 0;
    }
    const [command, ...rest] = args.positionals;
    const sub = { ...args, positionals: rest };
    switch (command) {
      case "check":
        return commandCheck(sub, out);
      case "ratchet":
        return commandRatchet(sub, out);
      case "tombstone": {
        const [action, ...tail] = rest;
        const tombstoneArgs = { ...args, positionals: tail };
        if (action === "list") return commandTombstoneList(tombstoneArgs, out);
        if (action === "check") return commandTombstoneCheck(tombstoneArgs, out, err);
        if (action === "add") return commandTombstoneAdd(tombstoneArgs, out);
        throw new UsageError("usage: slopslint tombstone <list|check|add>");
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof TombstoneConfigError) {
      err(`tombstone: config error: ${error.message}`);
      return 2;
    }
    if (error instanceof UsageError) {
      err(`slopslint: ${error.message}`);
      return 2;
    }
    if (error instanceof SlopslintError) {
      err(`slopslint: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
