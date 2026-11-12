# The phone app's icon shows the unread count

- Date (UTC): 2026-11-12 13:53
- Branch: `feat/phone-app-badge`
- Status: done
- Where: Team AX core (`mobile/`, `push-gateway/`, `shared/src/cloud-protocol/push-gateway.ts`,
  `server/src/notifications/`, `web/src/lib/`). Why: phone and push are core (docs/REPOSITORY-RULES.md).
- Version impact: patch. A field the gateway and the app may ignore; nothing else changes.

## Goal

QA TC-408: pushes reach the iPhone, but the app icon never shows a number. The app asks the OS with `allowBadge: false`,
nothing sends a count and nothing sets one. After this the icon shows the same number as the Mac Dock and the tab title
(the one count n, docs/DECISIONS.md "Session markers": AI chats that need me and rooms that want me), on iOS and Android,
and clears when everything is read.

## Scope

In:
- The count rules (`attentionCount`, `markerOf`, `roomWantsMe`) move to `shared/` so the server counts with the same code
  the page uses; the web keeps importing them from where it does.
- Server: each native push carries the recipient's n at send time (`badge`). The gateway contract gets an optional
  `badge` (0 to 9999); APNs `aps.badge` (not FCM: Android launchers add up each notification's count). A gateway that does not know the
  field yet (it refuses unknown keys with 400) gets the push again without it, so servers can update before the gateway.
- Phone app: asks with `allowBadge: true`; an iPhone that already answered is not asked again by a dialog (iOS shows it
  once). New capability `badge-v1`: the page sends n (`badge`), the app sets it (`setBadgeCountAsync`). The page sends it
  when it changes, when the app comes to the foreground, and 0 at sign-out; the app sets 0 itself at sign-out and when it
  leaves a team.
- Privacy: a number only. Lock-screen text rules (TC-365) unchanged.

Out: a badge for Web Push (the browser's own), per-team badges for more teams on one phone (the phone holds one team).

## Steps

1. Shared count module + web re-exports.
2. Gateway contract, APNs and FCM payloads, gateway tests.
3. Server: count per recipient (`server/src/notifications/push-badge.ts`), carried by the native transport, the
   fallback without it; tests.
4. Phone: permission (`allowBadge`), `badge-v1` in the bridge and `src/badge.ts`, App wiring; tests.
5. Web: `setAppBadge` in `lib/mobile.ts`, sent from `store/sessionMarkers.ts`.
6. DECISIONS.md section, gateway README, changelog fragment `changes/phone-app-badge.md`.

## Risks

- Gateway deploy: needed for the number to reach phones from a push (until then the app still sets it when opened).
  Deploys need the owner's OK.
- Ships with the next phone build (the app is 1.0.5 on dev since the photo picker); older apps ignore `badge` messages (no capability) and never asked for badge
  permission, so iOS shows nothing for them.
- iOS people who answered the notification question before 1.0.5 may have Badges off; iOS does not ask again. Settings ›
  Notifications › Trina AX › Badges turns it on.
- Cost: the count reads the person's rooms and recent chats once per push (pushes are at most ten a second per server).
- No migration.

## Result

Built as planned (docs/DECISIONS.md "휴대폰 앱 아이콘의 숫자"). The count rules are in `shared/src/api/attention.ts`;
`server/src/notifications/push-badge.ts` counts per recipient; the transport sends `badge` and falls back without it for
an older gateway; the app asks with `allowBadge: true`, takes `badge-v1` and clears the icon at sign-out and team change.
Needs: the gateway deploy (push.trina.app) for the number to come with pushes, and the next phone build.
