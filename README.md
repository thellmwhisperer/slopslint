# slopslint

A blocking slop gate for repositories where a lot of the code is written by
agents. It measures duplication in independent scopes, lets you accept specific
debt as a permanent reviewable record, and holds the total under a committed
ceiling that can only ever go down.

One self-contained binary. No runtime, no package manager, no separately
installed detector.

```sh
slopslint check --classify --enforce
```

## Why

Agent-written code duplicates. Not dramatically, and rarely in a way any single
review catches: a helper re-derived in a second module, a setup block pasted
into a fourth test, a rejection path written four times with one word changed.
Each instance is defensible. The aggregate is not.

A percentage threshold does not hold that line, because it drifts up quietly as
the repository grows. slopslint holds an absolute count per scope, and the
committed count is monotonic: a change may lower it, never raise it. Debt you
decide to keep is not silently subtracted — it is written down as a tombstone
that names the incident, the rule it established, and the evidence.

## Install

**Binary** (recommended — nothing else needed):

```sh
curl -fsSL https://github.com/thellmwhisperer/slopslint/releases/latest/download/slopslint-linux-x64 \
  -o /usr/local/bin/slopslint && chmod +x /usr/local/bin/slopslint
```

Published for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and
`windows-x64`.

**GitHub Action:**

```yaml
- uses: thellmwhisperer/slopslint@v0.1.0
  with:
    args: check --classify --enforce
```

**npm** (needs Node 20+):

```sh
npx slopslint check --classify --enforce
```

## Configure

Two files under `.slop/`, both yours to own and commit.

`.slop/config.yml` declares what to measure. Scope names, paths, and globs are
your data — slopslint ships no default layout.

```yaml
schema: 1

detector:
  name: jscpd
  version: "4.2.5"   # must match the detector linked into the binary

defaults:
  format: python
  mode: mild
  min_lines: 5
  min_tokens: 50

global_ignore:
  - "**/__pycache__/**"
  - "**/node_modules/**"

scopes:
  python_production:
    scan_path: py
    pattern: "**/*.py"
    ignore:
      - "**/test_*.py"
      - "**/conftest.py"

  python_tests_fixtures:
    scan_path: py
    pattern: "**/{test_*,conftest}.py"
```

Scopes are measured independently and never leak into each other, so
duplication in production code cannot hide inside the test scope. Globs match
basenames: a directory named `test_data/` keeps its production files in the
production scope.

`.slop/ceilings.yml` declares what you will tolerate:

```yaml
schema: 1
scopes:
  python_production:
    active_clones_ceiling: 21
  python_tests_fixtures:
    active_clones_ceiling: 110
```

The ceiling is not a budget to spend. `check --enforce` fails when the measured
count is **above** it (a regression) *and* when it is **below** it (an
improvement you did not record). Paying debt down means lowering the number in
the same change, so the base branch always states the truth.

## Commands

| Command | What it does | Exit |
| --- | --- | --- |
| `slopslint check` | measure every scope, print the canonical report | `0` |
| `slopslint check --classify` | additionally split accepted from active | `0` |
| `slopslint check --classify --enforce` | additionally fail on ceiling violations and stale records | `0` / `1` |
| `slopslint ratchet <base-ref>` | verify the committed ceilings only went down | `0` / `1` |
| `slopslint tombstone list \| check \| add` | manage `.slop/tombstones` | `0` / `2` |

Exit `1` is a gate condition. Exit `2` is invalid usage or an invalid record.

## Tombstones

A tombstone is a permanent, reviewable record of debt you decided to keep. It
CONSUMES a finding; it never produces one.

```yaml
schema: 1
id: T-SHARED-FIXTURE-HEADER
status: accepted            # accepted | legacy
category: duplication       # duplication | alien_code | debt_normalization
title: "Fixture header shared by the ingest suites"
created_at: 2026-08-04
incident:
  pattern: >
    What the smell is, in general terms.
  what_went_wrong: >
    What actually happened here.
  root_cause: >
    Why it got through.
  rule_established: >
    What the team does differently now.
  evidence:
    - example: "the concrete instance"
      family: clone_fingerprint
match:
  family: clone_fingerprint
  scope: python_tests_fixtures
  fingerprint: <64 hex chars from `slopslint check`>
```

Accepted clones stop counting as active, so the ceiling measures live debt
only. Two rules keep that honest:

* a record whose fingerprint matches nothing is **stale** and fails the gate —
  debt you paid off cannot leave its exemption behind;
* categories with no detector (`alien_code`, `debt_normalization`) are
  **standing** records: validated, reported, never matched, never stale. They
  carry the incident now and reserve the schema path for a detector later.

## What fails closed

The gate refuses to pass rather than guess. Missing or invalid config, a
detector version that disagrees with the linked library, zero scanned files, a
clone path that escapes the repository, a range that runs backwards, a
duplicated or ambiguous YAML key, a tombstone citing a file that does not
exist, two records claiming one clone, a ceiling scope that no detection scope
declares, an unreachable git base ref — each is an error, never a silent pass.

Output carries integer totals, repository-relative paths, and a synthetic
fingerprint per clone. It never carries source text, timestamps, floating
percentages, or absolute paths, so a report is safe to paste into an issue. Two
runs over one unchanged tree produce byte-identical output.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build:binaries
```

## Provenance

Extracted from [roca-madre](https://github.com/thellmwhisperer/roca-madre),
where it ran as an in-tree Python wrapper around a pinned `jscpd` executable.
The port to TypeScript replaced that process boundary with a linked library,
which removed the apparatus the boundary required — a subprocess version probe,
JSON revalidation of the detector's output, and a glob-prefix guard that existed
only because the external detector matched globs with separator-crossing
wildcards. The Python suite is the contract these tests were written against.

Clone assembly is owned here rather than taken from `@jscpd/core`, whose
`RabinKarp` loop extends an open clone with whatever frame its store last
returned without checking that the stored side advanced; a hash hit that jumps
backwards yields a clone whose end line precedes its start line. A range that
cannot exist is exactly what a fail-closed gate must never emit.

## License

MIT
