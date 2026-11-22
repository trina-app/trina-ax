# Google sign-in guide: Google's two-click warning and Google Cloud screenshots

- Date (UTC): 2026-11-22 06:55
- Branch: `docs/google-signin-guide`
- Status: in progress
- Where: `docs/site/` (the public docs at ax.trina.app/docs). Why: user guide pages live in the docs site (see
  docs/REPOSITORY-RULES.md).
- Version impact: none, docs only (no code, no behaviour change).

## Goal

People connecting Google Drive, Gmail, Calendar, Docs or Sheets through Trina's sign-in meet Google's "Google hasn't
verified this app" screen and stop there. IT admins making their company's own Google app follow text-only steps in
Google Cloud and get lost. The two guides show both with pictures:

- `use/google-apps`: the two clicks that pass Google's warning (**Advanced**, then **Go to Trina AX (unsafe)**), and a
  short "which sign-in" choice between Trina's sign-in and the company's own app.
- `use/google-own-app`: one screenshot per Google Cloud step (new project, enable an API, Get started with the app name
  and Internal, Data access with Manually add scopes, Create client with Web application and the two return addresses).

## Scope

In: the English pages and the five translations (ko, zh, ja, es, id) of both guides; WebP images in
`docs/site/images/google-own-app/` and `docs/site/images/connect/`; one decision file.
Out: the app's UI, the broker's start page (trina-cloud), Google's own verification of Trina's app.

## Steps

1. Screenshots of Google Cloud in a throwaway project named "acme-trina", made for this and deleted afterwards: English
   console, cropped to the form (no account, no project picker), WebP.
2. Google's warning pictures: the two crops the hosting service's start page already uses, per language.
3. Update both English pages, then the five translations with the same structure and the same images.
4. `bun run docs:build`, `bun run check:docs`, `bun run check:prepush`.

## Decisions

`docs/decisions/20261122-google-signin-guide.md`: the own-app guide now shows Google Cloud's screens, taken in a
made-up project and cropped to the form. Changes the rule in `docs/AGENTS/plan/20261113-0917-google-own-app.md` step 6
("Google Cloud's own screens are not captured").

## Risks

Google changes its console: the pictures will age. Each picture keeps the quoted label and the link to the page, so the
text still works when a picture is out of date. No real account, project or client ID is shown (the repo is public).

## Tests

`bun run docs:build`, `bun run check:docs`, `bun run check:prepush`.

## Result

Filled in at the end.
