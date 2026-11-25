# Admin guide: Google with the company's own Google app on a self-installed server, from a real end-to-end run

- Date (UTC): 2026-11-25 05:07
- Branch: `docs/google-own-app-admin-guide`
- Status: done
- Where: docs/site (operate) and web/src/components/integrations. Why: the per-card own-app path had never been run
  against real Google; this records how an admin does it and fixes one step the dialog left out.
- Version impact: patch (a missing line in a setup dialog, and a new docs page; no behaviour change)

## Goal

A non-developer admin of a self-installed server (with a public address, not signing in through the hosting service)
can set up Google Drive, Gmail, Calendar, Docs and Sheets with the company's own Google OAuth app, and members can
connect them, by following one page.

## Scope

In:
- A docs page `docs/site/operate/google-own-app-self-installed.md` with screenshots from a real run (fictional Acme
  team), in every language's navigation.
- Fix: "Use the same Google app as Google Drive" in a Google app's setup dialog now shows the app's return address
  (`/api/integrations/google-apps/callback`) and says to add it to Drive's client. Before, the dialog said "Nothing
  else to upload" and hid it, so members hit Google's `redirect_uri_mismatch` on their first connect.

Out (reported as QA rows, not fixed here): the Gmail/Calendar own-client dialog has no Google Cloud step list like
Drive's; the member's "Connect this account?" confirm is lost on a reload.

## Steps

1. Run it for real: a test OAuth client (External, Testing, test users), a local dev server behind a quick tunnel with
   `MYCEL_GOOGLE_DRIVE_BROKER_URL=off`, admin setup in the UI, members connect Drive, Gmail and Calendar, a chat reads
   them.
2. Fix the dialog (six languages) and assert it in `web/test/e2e/google-apps.spec.ts`.
3. Write the page from what the run showed; screenshots retaken on a fictional team with the address replaced.

## Decisions

None.

## Risks

Docs-site tests (navigation in six languages, image sizes and use). No migration, no server change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/docs-site.test.ts`, web e2e
`google-apps.spec.ts`.

## Result

Run passed end to end (admin setup, members connected Drive, Gmail and Calendar, a chat read all three). Built as
planned: the dialog fix, the e2e assertion, and the operate page with six screenshots in every language's navigation.
Google names the server's address on its screens for an unverified External app, not the app name; the page says so.
