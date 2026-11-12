# Phones: Getting started as a full-screen flow, one Back step per step, a share sheet for the invite

- Date (UTC): 2026-11-12 02:04
- Branch: `feat/phone-welcome-flow`
- Status: in progress
- Where: trina-ax (web app, plus the phone app's bridge). Why: the phone app shows the web app in one WebView, so the
  flow is the web app's; the share sheet also needs one optional bridge message (see docs/REPOSITORY-RULES.md)
- Version impact: patch (phone layout and Back of an existing page; one optional, versioned bridge capability that
  older apps never see)

## Goal

QA TC-271 (phone audit ADM-20–23). On a phone, Getting started (/welcome) sits inside the tab layout, the whole wizard is
one history entry (the bar's ‹ and the iOS swipe leave to Home while a small "← 이전" goes back a step), the invite can
only be copied, and the count jumps 3/5 → 5/5 because 도구 연결 is counted but never shown there.

## Scope

In (below 768 px only; computers and tablets unchanged):
- Full screen: no tab bar and no tab top bar on /welcome; the page's own bar: ‹ · "2/4 스킬" · 나중에 (leaves the flow
  to where it was opened from, or Home).
- Back: each step is its own history entry (`/welcome?step=…`, a push per step). ‹, the iOS swipe and Android Back all
  go to the step before; from the first step they leave. Arriving in the middle (the Home row, a landing) puts the
  steps before under it, so ‹ and the swipe agree. lib/screens.ts names each step's parent, so an address opened from
  outside gets the same chain.
- Share: the invite message goes to the phone's share sheet: the app's own sheet through a new optional bridge message
  (`share-text-v1`, needs an app release), else `navigator.share` (iPhone app and phone browsers today), else copy.
- Count and hiding: the bar and the Home row count only the steps a phone shows (4, or 5 with AI); nothing for a
  computer only on the phone steps; 44 px taps for the skill checkboxes.

Out: the nav-v1 bridge (the swipe stopping at a tab's root, wave D); Admin › Members' invite card layout (TC-211).

## Steps

1. lib/tabs.ts `hidesTabs` includes /welcome; lib/screens.ts gives the steps their parents.
2. pages/Welcome.tsx: the step in the address on phones (push per step, replace for the AI gate), the chain under on
   arrival, the phone bar (‹ · step · 나중에), the old "← 이전" and the eyebrow only on computers.
3. lib/welcome.ts: `countedSteps`/`doneCount`/`stepTotal` take `computer`; the Progress bar and the Home row pass it.
4. lib/share.ts + lib/mobile.ts `shareTextToApp`; mobile protocol/bridge/App.tsx `share-text` behind `share-text-v1`;
   TeamLinkPanel's primary shares on phones (copy stays beside it and as the fallback).
5. PackRows checkbox: a 44 px tap box on phones.
6. Unit tests (lib/welcome, screens, mobile bridge, share) and phone e2e (Chromium + WebKit) that mirror the QA row.

## Risks

- History: the steps' entries go through lib/screenHistory.ts like any page; no change there. The desktop keeps its
  own state (no address change).
- Bridge: a new message only when the app offers `share-text-v1`; older apps get navigator.share or copy.
- Five languages: new keys in all five.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`,
`bun test tests/unit/mobile-bridge.test.ts`, the phone e2e spec in Chromium and WebKit, and the welcome e2e specs that
walk the steps on a computer.

## Result

(at the end)
