# Friendlier "Use Trina AX" docs: plain steps and screenshots for the hard parts (part B)

- Date (UTC): 2026-11-21 18:33
- Branch: `docs/friendly-screens-b`
- Status: in progress
- Where: docs/site (user docs), scripts/docs/screenshots.ts (new shots). Why: the owner asked whether the docs are
  friendly; readers are non-developers at companies, and the hard steps need numbered steps and pictures.
- Version impact: none (docs only; no app code changes)

## Goal

A person at a company who is not a developer can follow each hard step on these pages without guessing: where the
button is, what to press (the exact label), and what they see after it. Comparisons with Google Drive, Slack or the
iPhone where that helps.

## Scope

In: docs/site/<lang>/ (en, ko, ja, zh, es, id) for use/chats-and-projects, files-and-permissions, find-work-files,
guests, room-apps, scheduled-tasks, settings-and-search, team-skills, usage-and-limits and index. New screenshots for
the hard steps through the existing tooling (scripts/docs/screenshots.ts, fictional Acme data, 1440 wide, light theme,
WebP), English and Simplified Chinese where the tooling shoots both.

Out: get-started/*, admin, connect-apps, google-*, slack, api-connections, mcp and ai-accounts (another branch).
docs/install/ is the Korean PDF guide for installing a server Mac (build-pdf.ts), not a page of the docs site, so it is
left alone. No installer screens are shot (no installed app is run, nothing on this Mac is changed).

## Steps

1. Read each page in English and Korean; list the hard spots (several clicks, buried settings, unexplained words, no
   "where is this button", no visible result, sharing that is easy to get wrong).
2. Check each step against web/src (labels from web/src/i18n, flows from the components) and fix what is out of date.
3. Rewrite the hard steps as numbered steps with exact labels and what you see after each; same change in 6 languages,
   using each language's own UI labels from web/src/i18n/<lang>.ts.
4. Add shots for the hard steps to scripts/docs/screenshots.ts and shoot them from the Acme demo (en + zh).
5. bun run docs:build, check:docs, check:prepush; changes/friendly-screens-b.md; PR into dev (not queued).

## Decisions

none

## Risks

Docs only. Wrong labels in a translation: every label is taken from web/src/i18n/<lang>.ts. Screenshots: fictional
Acme data only, no real names or emails.

## Tests

bun run docs:build, bun run check:docs, bun run check:prepush.

## Result

(filled in at the end)
