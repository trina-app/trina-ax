# Phones: Getting started as a full-screen flow, one Back step per step, a share sheet for the invite

- Date (UTC): 2026-11-12 02:04
- Branch: `feat/phone-welcome-flow`
- Status: done
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

Built as planned, PR #540. Decisions on the way:
- 나중에 in the bar leaves the steps (to the page under them, else Home) and records nothing; each step keeps its own
  "나중에 하기" (put this step off, go on). A full-screen flow needs one way out; ‹ is the step before.
- The invite asked for by itself (the goal card's [팀원 초대]) gets no steps under it: Back returns to where it came from.
- The share button replaces copy as the primary only on phones with a sheet; copy stays one quiet press under it, and
  a sheet that cannot open copies and says so. Admin › Members' invite card (same panel) gets the same on phones.
- `share-text-v1` is new in the app: Android gets the share sheet only after an app release (it copies until then);
  the iPhone app uses `navigator.share` today.
- Review (head ea7af54fd): a finished setup goes Home whatever step the address names; leaving the steps for good (the
  finish, the end screen's 홈으로 and its skill) takes their entries away, so Back never walks or records them again;
  Back while a step is saved keeps that step; AI connected writes the steps under the resumed one; a refused share
  sheet points at the copy button instead of copying without the press. Merged with dev's nav-v1 (#536).
