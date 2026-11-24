# The document kit on every install: shared parts and Ubuntu

- Date (UTC): 2026-11-24 05:49
- Branch: `feat/doc-kit-everywhere` (on `feat/doc-skills`, #499)
- Status: in progress
- Where: `scripts/system/`, `server/src/files/`, `server/src/tools/isolate.ts`, `server/src/devenv/`. Why: the package
  list, the page render and the dev environment are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor, documents are designed on more installs; a root update (the package list)
- Design: `docs/AGENTS/plan/20261124-0314-doc-quality-all-situations.md` ("Docker and office Mac")

## Goal

Word, PowerPoint and Excel files come out designed and checked on hosted servers, Debian 13, Ubuntu 24.04, Docker and the
office Mac, with one path: the AI builds in an srt run, and LibreOffice draws the pages outside it. This branch holds
the parts every install shares, plus Ubuntu. Docker and the office Mac build on it in their own branches.

## Scope

In:
1. **Per-distribution minimum versions** in `scripts/system/packages.json`: a package may name its minimum per
   distribution. LibreOffice moves to a `default` group, with the Debian 13 minimum that DSA-6635-1 set, and installs on
   Ubuntu 24.04 and Debian 12 with no minimum.
2. **One font rule for the page render:** the kit's fonts and one replacement table (Calibri to Carlito, Cambria to
   Caladea, Malgun Gothic to Noto Sans CJK KR, ...) in the render's throwaway LibreOffice profile. Macros off, no
   link updates.
3. **Our seccomp filter on the page render** (`mycel-sandbox exec` inside the converter bwrap), wherever the server has
   the sandbox helper.
4. **Documents mode:** where the dev environment is off for a person, `box_shell` still runs, offline and in the chat's
   work folder only, so documents are built the same way. Decision file and changes note: this turns one capability
   on without an admin step.
5. **Ubuntu 24.04:** apt LibreOffice for the page render only.

Out: Docker image and office Mac kit (their own branches), guests (deferred), the phase 1 work of #499.

## Steps

1. Package list format, packages.sh, packages.ts, tests.
2. Render profile (fonts, replacement table, macro and link settings) and the seccomp step.
3. Documents mode in the dev environment setting and the turn; decision file, changes note.
4. Ubuntu: real Word, PowerPoint and Excel files with Korean rendered in an Ubuntu 24.04 container through the real
   isolation; the held-out set of #499.

## Decisions

docs/decisions/20261124-documents-mode.md (new). Changes `docs/DECISIONS.md` "DS3"-style "nothing turns on by itself"
for this one capability.

## Risks

The documents run widens who runs AI-written code (people with the dev environment off): offline, work folder only,
the srt attack suites must pass. The package list change is a root update. No migration.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run check:prepush` on Bun 1.3.12, `tests/unit/system-packages.test.ts`,
the office and dev environment tests, the srt attack suites.

## Result

Filled in at the end.
