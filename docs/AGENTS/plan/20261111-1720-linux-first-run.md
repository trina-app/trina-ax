# Linux first run: the setup code goes away, a link only this computer can open says so, the docs name the AI page

- Date (UTC): 2026-11-11 17:20
- Branch: `fix/linux-first-run`
- Status: done
- Where: `server/src/auth/accounts.ts`, `scripts/install-linux.sh`, `scripts/install-macos.sh`, `web/` (Members, the
  team link panel), `docs/`. Why: first setup, invites and the install guides are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch — fixes to first setup, a warning and docs; no new feature

## Goal

QA TC-211 (Linux kit, Debian 13, no public host yet; TC sheet TC-161, TC-163, TC-164):

1. After setup with `/var/lib/mycel/setup/code`, the file stays on disk. The server deletes its copy
   (`data/setup-token`) but not `setup/code`: a spent one-time secret left behind.
2. An invite made while the app is open through the SSH tunnel is `http://127.0.0.1:47820/invite/…`, with no warning:
   nobody else can open it.
3. INSTALL-LINUX sends the owner to "관리자 › 연결 › 제공자" (and INSTALL.md to "Admin → Connections → Providers"); the app
   calls the page 관리자 › AI 계정 / Admin › AI accounts.

## Scope

In:
- Setup: when the first account is made, the server deletes `<base>/setup/code` with `data/setup-token`. The Linux
  and Mac installers delete a code left from before (the team is set up: `data/app.db` exists and `data/setup-token`
  does not).
- A link only this computer can open (host 127.0.0.1 / localhost / ::1 / *.localhost): the invite link, the lead
  link, a password reset link and the team link show a note: other computers can't open it; set the team address in
  관리자 › 시스템 › 연결, open the app at that address and make the link again. Five languages.
- Docs: INSTALL-LINUX (and the same page names in INSTALL.md, CONFIGURATION.md, DESIGN-SYSTEM.md) say 관리자 › AI 계정 /
  Admin › AI accounts; INSTALL-LINUX's first setup says the code is removed after use and that links made over the
  SSH tunnel are for this computer only.

Out:
- Choosing a public address for links made over a loopback origin outside office mode (`linkBase`): a behaviour
  change; the note says what to do instead.

## Steps

1. `server/src/auth/accounts.ts` `bootstrapOwner`: remove `resolveLayout(config).setupDir/code` (force; a failure is
   logged, setup still succeeds).
2. Installers: the stale-code cleanup next to the code's creation.
3. `web/src/components/LocalLinkNote.tsx` (+ `isThisComputerOnly`), used in Members (invite, lead, reset) and
   TeamLinkPanel; i18n in ko/en/id/ja/es.
4. Docs.
5. Tests: setup removes the code file (unit); the note's host check and words (web unit); installers' text check if
   one covers the block.

## Risks

- Installers are root scripts: the cleanup only removes `setup/code` and only when the team is set up.
- e2e runs at 127.0.0.1, so the note shows in e2e invite dialogs (an extra line; no text assertion depends on its
  absence — checked).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the auth/setup unit tests, the installer text
tests, web unit (Members / team link).

## Result

Built as planned; INSTALL-LINUX's other page names in the first-week steps follow the app too (관리자 › 팀 설정, 부서,
폴더 권한, 멤버·초대). Tests: `tests/unit/a-auth.test.ts` "first-run setup" (the code file goes, the folder's other
files stay), `tests/unit/setup-code-cleanup.test.ts` (the installers' line run by bash: removed only when the team is
set up), `web/test/unit/local-link-note.test.tsx` (hosts, words). Local dev server: a fresh team's `setup/code` was
gone after setup; in the browser, Admin › 멤버·초대 › 팀에 초대 at http://127.0.0.1 showed the note under the link
(screenshot kept with the QA files).

Rebased 2026-11-12: dev's `drop_spent_setup_code` (install-linux.sh, same condition, also on an uninstall that keeps the
data) replaces this branch's Linux line; the macOS line and the server's deletion stay. The cleanup test runs dev's
function for Linux and the Mac line.
