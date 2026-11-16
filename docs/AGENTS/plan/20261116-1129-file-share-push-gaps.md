# File sharing P2, PR 4: a push for "Ask for access" and a "File sharing" switch

- Date (UTC): 2026-11-16 11:29
- Branch: `feat/file-share-push-gaps` (PR 4 of P2; QA TC-3093 "P2"), on `batch/1116c` (PR #1111: Shared with me and
  the notice-read fix)
- Status: done
- Where: Team AX core (`server/src/files/share-push.ts`, `server/src/notifications/`, `push-gateway/src/text.ts`,
  `web/pwa/sw.js`, Settings › Notifications). Why: phone push and file sharing are core (docs/REPOSITORY-RULES.md).
- Version impact: **minor** (a push event, a setting, an additive migration 358; gateway text with the release train).

Follows the P2 plan in [20261116-0947-files-shared-with-me.md](20261116-0947-files-shared-with-me.md) ("PR 4 — Push
gaps") and its review: the switch is called **File sharing** (not "Files shared with me": it also covers requests to
open *my* files); mark-read on open moved to PR 1.

## Goal

Someone asks to open a file: the person who answers it (the file's owner, or the owner and admins for a team file with
nobody to answer) gets a phone and browser push, with a generic line and no names. Anyone can turn file pushes off.

## Scope

In:
1. `file.access_requested` push: server SOURCES row, `PushEventType`, server text, gateway text, service worker,
   `pushPaths` (`/activity/<notice id>`, a new web route that opens the notice by itself). Wanted while unread, the
   request still waits, the receiver may still answer it, outside quiet hours, the switch on. A new request after an
   answer pushes again (bounded by the existing request limits).
2. Settings › Notifications **File sharing** (default on) for `file.shared` and `file.access_requested`: migration
   358 `notification_preferences.file_shares`, preferences, `pushEventEnabled`, `cancelDisabledPushDeliveries`, the
   service worker's `PUSH_PREF`.

Out: the iPhone extension naming the sharer or asker and `/f/*` app links (need a store build, PR 5); the greyed guest
row in the Share dialog (PR 3).

## Steps

1. Migration 358, preferences, contract (`fileShares`, `PushEventType`).
2. `share-push.ts`: request target and wanted check (`FileShares.requestWaitsOn`, the same check as Activity's
   `canAnswer`); SOURCES `only`; re-arm deletes the finished deliveries of a new request.
3. Texts (server, gateway, six languages), `sw.js`, `/activity/:noticeId`, Settings row, i18n.
4. Tests: `c-file-share-push-gaps`, gateway and locale texts, worker; e2e for the switch; docs and decision.

## Result

Built as planned. See [docs/decisions/20261116-file-share-push-gaps.md](../../decisions/20261116-file-share-push-gaps.md).
