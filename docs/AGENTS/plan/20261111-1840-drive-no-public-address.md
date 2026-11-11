# Google Drive on a server without a public address says what to do next and who does it

- Date (UTC): 2026-11-11 18:40
- Branch: `fix/drive-no-public-address`
- Status: in progress
- Where: `web/src/components/integrations/DriveConnector.tsx`, the five locales, a short `docs/DECISIONS.md` section.
  Why: connectors are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: words and a link where a dead end was; nothing changes on the server

## Goal

QA TC-196: on a self-installed server without a public https address, Google Drive is a dead end. In Admin › 연결한
서비스 › Google Drive the admin and the owner see only "먼저 이 서버의 공개 주소가 필요해요." and "설정 안 됨", with no
button or link and nothing about who can fix it. In the sidebar's 연결한 서비스 the owner gets a disabled [연결] with
"관리자가 먼저 켜야 해요" (`useDriveParts`: not set up → `connectors.adminNeeded` whatever the role), although the
owner is the one who has to act.

## Decision (simplest option that meets the row)

The public address (`tunnel.host`) is not set in the app: whoever installed the server sets it on the server computer
(`--public-host` of the Linux installer, `teamax public-address set` on the office Mac). So:
- Admin › 연결한 서비스 › Google Drive, not set up for lack of a public address (`blocked: 'public_host'`): one plain
  paragraph under the title. The owner: Google needs an internet address to send people back to after they sign in;
  the person who installed the server turns it on on the server computer; once it shows in 시스템 › 연결 방식, set Drive
  up here; with a link to Admin › 시스템. An admin (not the owner): the same reason, and "ask the owner" (only the owner
  sees the connection settings).
- 연결한 서비스 (the person's own Drive), not set up: an owner or admin reads "Google Drive를 아직 설정하지 않았어요" with
  a [설정하러 가기] button to Admin › 연결한 서비스 › Google Drive, where the reason and the next step are. Members keep
  "관리자가 먼저 켜야 해요" (for them it is true).

Out: setting a public address from the app (a server change, and open PR #393 adds sign-in through the hosting service
for registered self-installed servers, which removes the need for many); the setup dialog's own steps (QA TC-197, a PR
of its own).

## Steps

1. `useDriveParts`: owner or admin and not set up → `drive.setUpFirst` and the button to `/admin/connectors?drive=1`.
2. `DriveAdminDetail`: `blocked === 'public_host'` → the paragraph (owner / admin words) and, for the owner, the link to
   `/admin/system`.
3. New strings in EN/KO/ID/JA/ES.
4. Unit test (render with the DOM host): owner, admin and member lines; the paragraph and link per role.
5. `changes/drive-no-public-address.md`, a short `docs/DECISIONS.md` section.

## Risks

Open PRs: #393 (server side of Google sign-in) does not touch these files; #399 (connectors simple page) touches
`Connectors.tsx` and the locales elsewhere, not `DriveConnector.tsx`. Five locales, Korean in plain 해요체. Who-sees-what:
no new data, only words by role.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new unit test and the Drive/connectors unit tests;
a local dev server look as owner and admin (a dev server has no public address, which is the case).

## Result

(filled in at the end)
