# Admin › System on a phone: a list of pages; server setup says "set this up on a computer"

- Date (UTC): 2026-11-12 02:36
- Branch: `fix/phone-admin-system`
- Status: done (PR #551)
- Where: `web/` (pages/admin). Why: the phone app shows the web app; System's layout and its server forms are web code.
- Version impact: patch, phone layout only; computers keep the one page

## Goal

QA TC-269 step 1 (ADM-14): Admin › System on a phone was one page of about 2,500 px. It becomes a list of pages like
Team settings: storage, version and updates, health, connection, connected folders, backups and export, each its own
page at `/admin/system/<group>` under "‹ System"; ‹ and Back return to the list.

QA TC-270, System's part (ADM-15): the connected folder form (a Mac path "/Volumes/…" with a Finder hint), the
connection mode change (relay address, claim code) and the update's server commands are not phone forms. On a phone
they become the status plus "컴퓨터에서 설정해요", as #468 did for Slack and the engines.

## Scope

In:
- `pages/admin/systemGroups.ts` (pure): the groups, which a person sees (owner / admin, the server's features), and
  where `/admin/system/<group>` goes (a computer: the one page; an unknown group: the list).
- `AdminLayout.tsx`: System's group addresses, its bar title and ‹ label, like Team settings.
- `System.tsx`: on a phone the list (PhoneList rows with a short value: storage %, version, problems, connection state)
  or one group; the sections stay mounted while hidden, so a running backup or export keeps its progress. Computers
  unchanged.
- Phones: connected folders keep their rows (sync, remove) and the add form becomes "컴퓨터에서 설정해요"; Connection
  keeps its status and the Change button becomes the same; an update that needs the server's command or has no feed
  says it.
- The links into System that name a part (Admin's attention rows for storage, checks and updates, the owner's backup
  step, the office update banner, Drive's public address) open that group on a phone; a computer's page as before.
- Strings in 5 locales, phone e2e (Chromium + WebKit; owner and admin), unit tests, changes fragment.

Out: Plugins, Activity log, Usage, AI apps (in dev with #468); TC-208/209/221 behaviour (kept as is).

## Steps

1. Plan (this file).
2. systemGroups.ts + AdminLayout routing + System.tsx list and groups; unit tests.
3. TC-270 phone forms in System; links into the groups.
4. e2e (phone-admin-system), adjust the specs that read System on a phone; checks; PR.

## Risks

Phone layout only. The computer page keeps its order and markup (no wrappers). An old link to `/admin/system` still
opens the list on a phone.
