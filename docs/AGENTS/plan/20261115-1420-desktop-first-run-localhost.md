# Desktop first start never strands on a localhost team; sign-in line; one team screen for every switch

- Date (UTC): 2026-11-15 14:20
- Branch: `fix/desktop-first-run-localhost`
- Status: done
- Where: trina-ax (desktop app `desktop/`, the desktop bridge `shared/src/desktop-bridge.ts`, the web sign-in pages). Why: the desktop shell, its bridge and the team page's sign-in screens are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch (a first-start fix; an optional bridge method, no API change)

## Goal

Owner bug report 2026-11-15: the signed 0.5.7 Mac DMG opened on "팀 서버에 연결할 수 없어요 — http://localhost:19100".
A fresh install must open "Join your team". Saved state that points at a dead localhost team must fall back to the team
screen with a clear choice; real teams keep the offline card with 다시 시도. Same PR (owner): a quiet "address · Switch
team" line under the desktop sign-in card, and every desktop "Switch team" goes to the app's team screen (no popup menu).

## Scope

In:
- Cause: `bun run app` shared the installed app's settings folder (`Team AX`). Dev runs get `Team AX (dev)`.
- `openLast` of a `localhost` / `*.localhost` team that does not answer: the first-run screen with the list and a line.
- `DesktopBridge.hostLine`: the page's line under the sign-in card replaces the app's strip on sign-in paths.
- `switchTeam` and `bridge:team-menu` open the team screen; the OS 팀 menu and ⌘1–9 stay.
- Copy in en first, then ko/id/ja/es/zh.

Out: loopback IPs (Office Mac's own server keeps the card), the phone app (keeps its native footer), an app-drawn line.

## Steps

1. Reproduce with the 0.5.7 DMG on isolated profiles (clean, stale localhost, qa.trina.app).
2. Desktop fix, unit tests, desktop e2e.
3. Web line, bridge, web e2e + pictures 1440/390 light/dark.
4. DECISIONS entry, changes fragment, QA rows TC-3120..3124, independent review, signed local build check.
