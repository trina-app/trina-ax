# Linked browser profiles on every turn, the app's browser as one more choice

- Date (UTC): 2026-11-28 18:54
- Branch: `fix/chrome-profiles-every-turn`
- Status: done
- Where: server/src/chat, server/src/chrome, web/src/components/settings. Why: a desktop-app turn never saw the person's
  linked Chrome unless a hidden switch was on (see docs/REPOSITORY-RULES.md)
- Version impact: patch — a fix to how existing browser choices reach the AI; one settings switch removed, no new feature
  or API a client depends on (the web page is served by the same server)

## Goal

Owner bug on 0.21.0: the extension said "Potenlab에 dion(으)로 연결됨 · 온라인", yet in the desktop app the AI said no
Trina in Chrome was connected and fell back to Gmail/Aside. `browserTarget()` defaults to 'app', so a desktop-app turn
only got the app's own browser and the AI was not even told the linked profiles exist. After this, whoever linked a
profile has it on every turn (desktop app, web, their scheduled runs), and the AI picks per call; no switch decides.

## Scope

In:
- chat/turn.ts: linked profiles whenever the person has any (no `user_browser_target` read). In the desktop app the
  app's own browser is one more profile (`app`), so the AI picks per call. Offline profiles are listed as "not open".
- chrome/profiles.ts pickProfile: a call that names nothing goes to the run's last profile, else the profile whose sites
  hold the address, else the one linked Chrome that is open (several: ask), else the app's browser.
- prompt.ts: both browsers' rules when both exist; the profile list (name, account, open or not); an explicit ask for
  Chrome / "<app> in Chrome" wins over a memory or habit for another tool (Aside, mail); on the web with profiles but
  none open, a plain line on how to connect (open that browser; the extension connects by itself).
- Settings › Browser: the "Use my Chrome" switch goes; one line says the AI uses the linked browsers and the app's own
  one, step by step. `PUT /api/chrome/target` and `target` in `GET /api/chrome/links` go.
- `user_browser_target` rows: no longer read (kept in place, so a rollback build still reads them); no migration.

Out: a phone turn (still no browser); MCP apps' browser tools (already per profile).

## Steps

1. Plan (this commit).
2. turn.ts + profiles.ts + tools.ts routing (app pseudo-profile).
3. prompt.ts rules.
4. API + Settings copy (6 languages), docs (decision file, CONNECTIONS.md, changes/).
5. Unit tests (pickProfile, prompt, turn routing), e2e with the extension in throwaway Chromium profiles.

## Decisions

docs/decisions/20261128-browser-profiles-every-turn.md (changes 20261128-trina-in-chrome.md "Settings › Browser: this
app or my Chrome").

## Risks

Shared chats keep their one notice (Chrome wording when profiles are offered). Scheduled runs: unchanged (no app
browser there). No migration. Five app languages + id. Desktop and web settings page.

## Tests

`bun run typecheck`, `bun run test:unit` (chrome, prompt, turn), `bun run check:prepush`, the Chrome e2e.

## Result

Built as planned. Independent review: no blocker; fixed an address pinned to a closed profile (the AI now hears it may
use "app" once the user says so), a linked profile named "app" (asks which), the upload rule for an old desktop app,
the app's own lines (preview_start), and no "how to connect" rule in a scheduled run. Left as is: one shared-chat
browser notice covers both browsers (as on the web before). Extension 0.3.3 (its fingerprint includes
shared/src/api/chrome.ts). Unit (chrome-link 30+), the extension e2e in throwaway Chromium profiles (4/4).
