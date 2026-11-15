# Folder access adds up like Google Drive (P2)

- Date (UTC): 2026-11-13 23:44
- Branch: `feat/folder-access-additive`
- Status: done (PR open as draft; waiting for the owner's C1 and M6 decisions)
- Where: Team AX core (`server/src/policy/`, `server/src/admin/`, `server/src/db*.ts`, `server/migrations/`,
  `shared/src/api/`, the writers in `server/src/chat/`, `skills/`, `team-files/`, `system/backup.ts`). Why: folder
  permissions are core (see docs/REPOSITORY-RULES.md).
- Version impact: minor, a migration and a new permission model. With the default M6-A the database reader level goes
  to 7, so this release cannot be rolled back automatically (owner decision).

**Owner decided (2026-11-14):** C1-A with the warning before saving, M6-A with a rehearsed manual roll-back runbook
(docs/BACKUP-RESTORE.md), item 9-A, item 12-A also at save time. The coordinator merges.

## Goal

Today the deepest folder with a rule decides, and inside it a person rule beats a group rule beats everyone. That
cannot say what Google Drive says ("access adds up from the folders above; Limit access cuts it"). After this change
access adds up from parent folders, a folder can be **limited** (nothing from above reaches it), and the rules that
exist today are converted once so that nobody gets more access than before.

## Scope

In:
- `folders.limited` and `folder_rules.origin` (migration `121_a_folder_limited.sql`, reader level 7), triggers that
  refuse "no access" rows and role rows except the legacy marker, the project exception and the managed marker.
- The permission function: the widest applying rule up to and including the nearest limited folder; a person's own
  `none` on `projects/<name>` is the project exception (rule only).
- One loader (`RuleSet.fromDb`, private constructor, `fromWorld` for tests), `boundaryFolders()`.
- The one-time conversion (`policy/convert-additive.ts`, with a frozen copy of today's resolver
  `policy/legacy-deepest.ts`) as a post-migration step inside the migration transaction; the safe-ops trigger step.
- `writeFolderAccess` (the one write helper), `hasAccessSettings`, every writer and row-drop listed in the spec.
- API: `Folder.limited`; `limited` on create, save and previews (missing = keep); 400 for `none` / role rules; 409
  `client_outdated`; `rules-v2` hash; `cutAt` and the `left` reason in explain.
- C1-A: origin rows kept on unchanged saves; group and person changes name who keeps access by name (API answer,
  audit, connector tool result).
- Restore: the staged and the live DB converted, `limited` and `origin` copied, backup-only rows not limited.
- Fingerprints: schedule save scope, remote MCP policy hash, rules hash.
- `scripts/dry-run/folder-additive.ts` (no data in the repo).
- Web: only what keeps the build and tests working with the new API (Restricted saves as a limit, not
  `everyone: none`).

Out (later, after P1 is on dev):
- The "Limit access" switch, the Access removed › Add list, the Manager row and the origin tag in the Share dialog.
- The group-change warning before saving on Admin › Groups and the person's edit page (the server already answers
  who keeps access).
- C1-B, C1-C and M6-B (structured for, not built; their open review items are TODO in DECISIONS).

## Steps

1. Migration 121, `db-steps.ts` post-loop hook in `db.ts`, reader level 7.
2. Resolver, loader, legacy copy, conversion.
3. Write helper, triggers' writers, API and routes.
4. Restore, fingerprints, caches, connector.
5. Test migration (fixtures with `none` / role rows, direct RuleSet constructions) and new tests.
6. Dry run on the QA team copy and the demo seed. DECISIONS, changes fragment, QA rows.

## Risks

- Security: every path that reads or writes folder rules. The rule "nobody gets more than today" is checked by the
  conversion's own assertion, the dry run, and random-world tests.
- No roll-back with reader level 7 (owner decision M6).
- Large test migration (~250 test files mention `none`).
- The P1 dialog branch edits `web/src/lib/access-edit.ts` and `folder-sharing.ts` too: whichever lands second rebases.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the full `bun run test:unit` under Bun 1.3.12, new
unit tests (additive resolver, loader, conversion worlds, triggers, atomic migration, roll-back reader, safe-ops,
restore, origin warnings).

## Result

Built as planned with the defaults C1-A, M6-A, 9-A, 12-A (docs/DECISIONS.md "Folder access adds up like Google Drive
(P2)"). Differences from the spec:
- The web step came second in the same PR, after P1 was on dev: the Limit access switch, Access removed › Add, the
  Manager row, the "Added when folders changed" tag, the warning before saving on Admin › Groups and the person's page
  (with Remove), the one-time Admin notice (GET/POST `/api/admin/folder-access/notice[/dismiss]`), "Limit access" in the
  By folder / By person reasons, and P1's "lower than" captions removed. Shots of a QA-Acme copy at 1440/390
  light/dark.
- Inside a project's zone the conversion names a person only with what rules at or below `projects/<name>` gave them
  (otherwise promoting them to admin later would let them in by that name); access through a rule above the project is
  a listed fail-closed case (7.5-1), as the spec's §7.4 expects.
- `copy = ∅` applies to `projects/<name>` itself; folders deeper in a project copy from the chain up to it.
- C1-B, C1-C and M6-B are not built; their open review items are TODO in DECISIONS.
- The conversion prepares and finalizes its own statements (with Bun 1.3 a cached statement left unfinalized kept the
  connection open after close, and a restored database could not be opened again in the same process).
Dry run: QA-Acme (live copy and newest backup) and the demo seed: 0 widened, invariants ok.
