# Google Drive's admin setup guides the Google Cloud steps

- Date (UTC): 2026-11-11 18:54
- Branch: `fix/drive-setup-steps`
- Status: in progress
- Where: `web/src/components/integrations/DriveConnector.tsx` (`DriveSetupDialog`, `GoogleClientFields`), the five
  locales, a short `docs/DECISIONS.md` section. Why: connectors are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: the setup could not be finished without outside help; now the dialog says how

## Goal

QA TC-197: Admin › 연결한 서비스 › Google Drive › 한 번 설정하기 shows only "Google Cloud에 추가할 리디렉션 URI" with
Copy, "클라이언트 파일(JSON) 올리기" or the client ID and secret, and Save. Nothing says what to do in Google Cloud, in
which order, or where: about five Google Cloud pages and eight actions an admin has to know already. Expected: an admin
finishes without docs: project, Drive API, consent screen, web client with the shown redirect URI, JSON, with links.

## Decision (simplest option that meets the row)

The steps go into the dialog itself, as a short numbered list above the fields, each with a link that opens the right
Google Cloud page in a new tab:
1. Make or pick a project (console.cloud.google.com/projectcreate).
2. Turn on the Google Drive API (…/apis/library/drive.googleapis.com).
3. Make the sign-in screen (OAuth consent screen): app name and support email; "Internal" when only the company's Google
   Workspace accounts use it, else "External" with the people's accounts as test users (…/apis/credentials/consent).
4. Make a client: type "Web application", and the address below under "Authorized redirect URIs"
   (…/apis/credentials/oauthclient).
5. Download its JSON file and upload it below, then Save.
Google's own labels are quoted as Google shows them (the person has to find them there); our own labels say what each
field is for ("the address to put under 'Authorized redirect URIs'", "Upload the JSON file you downloaded").

Out: the Google apps' setup dialogs (Gmail, Calendar, Docs, Sheets: `GoogleAppAdmin.tsx`) keep their own steps; they get
the plainer field labels because they share `GoogleClientFields`. Doing the Google Cloud part for the admin (the hosting
service's one client is PR #393's way, for registered servers).

## Steps

1. `DriveSetupDialog`: the numbered steps with links (only when the page may set it up and it is not set yet, or to
   replace it).
2. The field labels in `GoogleClientFields`: plainer, with Google's names quoted.
3. Strings in EN/KO/ID/JA/ES.
4. Unit test: the five steps, their links, the redirect address after them; every locale has the strings.
5. `changes/drive-setup-steps.md`, a short `docs/DECISIONS.md` section.

## Risks

Google moves its console pages: the links are the ones Google documents and redirect when moved. Five locales, Korean in
plain 해요체. PR fix/drive-no-public-address edits other parts of `DriveConnector.tsx` and other keys.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new unit test, the e2e `admin-app-connectors` spec
(the dialog), a local dev server look at the dialog.

## Result

(filled in at the end)
