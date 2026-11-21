# Plan: one map of every connection mode (docs/CONNECTIONS.md)

Why: onboarding "Tools for your team" offered only a per-person Team pick for Google Drive and Gmail although a shared
team Google account already exists (GoogleAppTeam.tsx, PR #177). Nothing lists, per tool, which modes exist and which
surface offers each.

Change: docs only. Add `docs/CONNECTIONS.md` (one table built from the code on dev, plus the mismatches found), link it
from `docs/README.md` and `docs/REPOSITORY-RULES.md`, and add the rule "a change to a connection mode updates
docs/CONNECTIONS.md" to `CLAUDE.md`. No code is changed.

Version impact: none (documentation only).

Checks: `bun run check:docs`, `bun run check:prepush`.
