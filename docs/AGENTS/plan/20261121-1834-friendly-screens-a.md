# Docs: friendlier steps and screenshots for set-up and connection pages

- Date (UTC): 2026-11-21 18:34
- Branch: `docs/friendly-screens-a`
- Status: done
- Where: docs/site (all six languages), scripts/docs/screenshots.ts, docs/site/images. Why: the owner asked whether
  the docs are friendly; the readers are non-developers, and the hard steps need plain numbered steps and pictures.
- Version impact: none (documentation and the docs screenshot script only)

## Goal

A person at a company, not a developer, can follow the set-up and connection pages without guessing: where each
button is, what to press, and what they see after each step. Hard steps get a screenshot.

## Scope

In: docs/site `get-started/` (quickstart, team-setup, key-concepts) and `use/` admin, connect-apps, google-apps,
google-own-app, slack, api-connections, mcp, ai-accounts, in en, ko, ja, zh, es and id. New shots in
scripts/docs/screenshots.ts (the mock set, so they can be retaken with one command).

Out: the other `use/` pages (another branch), app code, Chinese copies of the new mock shots (the mock set is English
only in the tooling).

## Steps

1. Read each page in English and Korean; check each hard step against web/src and the i18n strings.
2. Rewrite the hard steps as numbered steps with exact labels and what you see after each; fix wrong facts
   (for example, Admin is in the team menu, not the account menu).
3. Add mock shots: the onboarding Tools step, a member's Google app page before and after Connect, the shared Google
   account row and its dialog, the Slack link page, the Claude subscription code step, the Invite people dialog.
4. Apply the same change in all six languages; plain comparisons to Drive, Slack or the iPhone where they help.
5. `bun run docs:build`, `bun run check:docs`, `bun run check:prepush`, tests/unit/docs-site.test.ts.

## Decisions

none

## Risks

Third-party screens (Google consent, Slack approve, Claude approve) are described in text only: no real accounts.
Screenshots use the mock server's fictional team "Acme" only.

## Tests

`bun run docs:build`, `bun run check:docs`, `bun run check:prepush`, `bun test tests/unit/docs-site.test.ts`.

## Result

The 11 pages in six languages, as planned. Eight new mock shots in scripts/docs/screenshots.ts (English only; zh uses its
existing localized account-menu picture). Fixed fact: connect-apps said Admin is in the menu under your photo; it is in
the team menu, and members see neither Invite people nor Admin there. Third-party screens (Google consent, Slack
approve, Claude approve, Google Admin console) are text only. The PR link is in the PR itself.
