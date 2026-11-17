# Folder sharing switched on, and no card when nothing changes

- Date (UTC): 2026-11-16 21:18
- Branch: `feat/folder-sharing-on`
- Status: done
- Where: server (files gate, chat tool), tests. Why: folder sharing in My files (decision 20261116-folder-share-server)
  waited behind a one-line switch in code until the widening checks were on dev (they are: #1151, #1152).
- Version impact: minor, a user-visible feature turns on.

## Goal

People can share a folder in My files with teammates and groups, from Files and by asking the AI. And when an admin asks
the AI for a team folder change that changes nobody's access (QA TC-4390), no card offers "Change": the AI says in one
sentence that nothing would change.

## Scope

In:
- `FOLDER_SHARES_OPEN = true` (server/src/files/folder-share-gate.ts). It stays a switch in code only: no config key, no
  environment variable; tests close it with `config.folderShares: false`.
  - Update: gate removed, always on (owner 2026-11-17): the switch, `config.folderShares` and the closed-state tests are removed.
- Tests that assumed the closed default: they now close it explicitly (the closed path keeps its tests) or expect open.
- change_folder_access: when the plan changes nobody's access (no counted change here, none in a folder inside, none for
  whoever joins later), no card, nothing saved, audit reason `no_change`, one sentence in the person's language (six).
- Changelog fragment.

Out: the user docs already describe folder sharing as available in all six languages; nothing to change there.

## Steps

1. Flip the switch; update the gate tests (security, c-folder-share-web, c-shared-folder-ai).
2. The no-change answer in folder-access-tool.ts, with a test in c-folder-access-tool.
3. All pre-push checks and the repo-wide guard tests under Bun 1.3.12; Playwright folder-share specs.

## Decisions

None new. The gate's switch is the one decision 20261116-folder-share-server.md "Gate" describes.

## Risks

The interim "I can't share the whole folder yet" words for a person's own folder now give way to share_folder (they
stay for team folders, which change_folder_access handles). No migration.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `features:check`, the folder-share test files and the repo-wide guard
tests under Bun 1.3.12, web unit tests, Playwright folder-share, folder-cards-always, share-card.

## Result

See the PR.
