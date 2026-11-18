# Repo-wide guard tests run in check:prepush and in every pull request's quick checks

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: feat/named-app-links (PR #1271 left the merge queue on a route with no permission matrix case)

- **Rule:** the tests that check the whole repository holds together (route coverage of the permission matrix, i18n
  completeness, exact tool lists, reader counters, the guest allow-list, the API contract, the docs site, ...) are one
  list, `scripts/ci/guard-tests.ts`. `bun run check:prepush` runs it, and so does CI's "typecheck, docs, native, relay"
  job on every pull request and queued entry. A new repo-wide guard is added there once. Only fast files (each well
  under 5 s; about a minute together); the full permission matrix stays in the unit shards.
- **Why:** since 2026-11-17 a pull request runs quick checks only, so a guard that lived only in the unit shards failed
  for the first time in the merge queue and cost a whole queue cycle.
