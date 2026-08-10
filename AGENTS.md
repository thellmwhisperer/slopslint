# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Public configuration and output contracts live in `README.md` and
  `docs/check-output.schema.json`; optional checks must preserve the legacy
  output shape when they are not configured.
- Use the scripts in `package.json` for the authoritative test, typecheck, and
  build commands.
- Do not add ceremonial file headers or numbered reading-guide markers; a
  file-level comment must be at most one line.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
