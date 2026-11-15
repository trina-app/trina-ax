# Tell people about older AI-made files that still hold one of their stored keys

- Date (UTC): 2026-11-15 14:21
- Branch: `feat/old-files-key-scan`
- Status: in progress
- Where: server/src/integrations/connections (the scan), server/src/notifications, web Activity. Why: a server
  start-up pass and an Inbox notice (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a security follow-up (one notice, one additive migration, no API removed)

## Goal

Since fix/files-hide-keys (TC-3041) the files the AI saves never get a person's stored connection key. Files saved
before that fix were not rewritten, and their search text (the text cache of docx, pdf, hwpx) still has the key
(QA tracking TC-3082). The person whose key it is gets one plain notice: how many such files, and a list of them to
open. Nothing is rewritten: the files are theirs (or their team's) and only they can judge what to do.

## Scope

In:
- Once, a moment after the server starts (like the memory clean-up of #953, settings key `files.storedKeyScan`): for
  each person with stored keys, the files their AI turns created or updated (`file_events` with a `turn_id`) that still
  exist are read (text up to a size limit) together with their text cache, and checked for any form of the person's
  stored keys (`allSecretsFor`, the same redactor as the answer).
- Found files are kept in a small table; each person with any gets one Activity notice (`files.stored_key`, never a
  push). The notice says how many and lists the files under it as links (`/files/view?path=…`), only the ones the
  person may open now, read when the notice is shown (no access is widened; a file that is gone drops off).
- Marked done only when every stored key could be read (as #953); otherwise it runs again at the next start.
- Bounded: at most 20,000 files and 4 MB of text per file per run, a pause between batches, logs only counts.

Out: rewriting or deleting files or their text cache; files the person uploaded themselves; telling the team owner
(they may not be allowed to open the person's files; open question in the PR).

## Steps

1. Plan (this commit).
2. Migration 354: `stored_key_files` (who, path, when found) and `stored_key_file_notices` (the notice, own table as
   in 353). The scan in `server/src/integrations/connections/file-scan.ts`, started from the chat runtime as #953.
3. Notice type `files.stored_key` in shared/api, notifications service (Activity only, always shown), account
   clean-up; web Activity row with the file list; text in the six languages.
4. Unit tests that fail without it; screenshots of the notice at 1440 and 390.

## Risks

Migration number: 353 is the highest on dev (2026-11-15), this is 354. Cost on big teams: bounded and run once.
Plain-words check: "Some files the AI made for you have one of your connection keys in them", "Open each one and remove
the key, or delete the file". No "token", "secret", "cache" in the text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit c-integrations-*, c-notifications*,
web unit for the Activity row, `bun run test:web`, `bun run build:web`.

## Result

Filled in at the end.
