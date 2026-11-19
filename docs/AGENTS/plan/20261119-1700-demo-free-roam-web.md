# Free-roam demo, part D2: the web's free-roam screens and the scripted demo's handoff

- Date (UTC): 2026-11-19 17:00
- Branch: `feat/demo-free-roam-web` (on `feat/demo-free-roam-a`, the server side)
- Status: done
- Where: web/ (the app's screens and web/demo/, the scripted demo) and scripts/demo/mina/strings (its words). Why: what
  a free-roam visitor sees is the web app's; the server already refuses what they must not reach (part A).
- Version impact: none (demo mode only; a normal install never asks GET /api/demo and shows nothing new)

## Goal

The visitor who presses "Now try it yourself" at the end of the scripted Mina demo lands in their own real server as
Mina. The web app must make that obvious and calm: who they are, what to try, how much demo AI is left, what happens at
the limit, and none of the AI account behind it.

## Scope

In:
- Free-roam detection without `me.server.dev` (false in free roam): ask GET /api/demo also when the feature row is the
  free-roam one (all off on a self-installed server); the app waits for the answer before its screens.
- The free-roam bar (in place of the demo bar): "You're Mina at Steepling, a made-up company. Try anything." and 2-3
  suggestions (the demo file's, else built-in en/ko ones); a tap sends one as a new chat, like the scripted demo's
  questions on Home.
- The meter: nothing until 80 %, then "About 20% of your demo AI left".
- The limit: the app's Modal (a bottom sheet on phones) once per tab, Start free / Look around; then every AI message
  box (chat, Home, ✦ in rooms) stops with one line and Start free. Rooms' own messages go on.
- Neutral words: `demo_rest`, `demo_busy` for failed answers; `demo_fenced` reads "Not available in the demo".
- Hidden: Settings › Usage, AI providers, AI apps, Dev environment sites; the engine choice and "answered by"; the admin
  pages (one line; the dev environment's own line).
- The sign-in page: only "Continue as Mina" → `/__demo/start`.
- The scripted demo's end: "Now try it yourself" (primary) beside the plans link once the gate's
  `/__demo/status` says `available` within 2.5 s; else "The live demo is busy right now" and the plans link alone.
  Words in all 6 story languages.

Out: demo-gate itself (part D1), the fakes, the Steepling content, hosting.

## Steps

1. lib/freeRoam.ts (rules), store/demo.ts (limit state), lib/api.ts (403 demo_limit listener, fenced words).
2. components/demo/FreeRoam.tsx; Demo.tsx, Layout, Auth, Home, App (wait + admin fence), Composer, SideChatPanel,
   Messages, settingsTabs/SettingsDialog, session canChooseEngine.
3. i18n in all locales, English first.
4. web/demo/live.ts + end.tsx, overlay.tsx, story.ts, strings/*.ts; the demo test server's CSP.
5. Tests: unit (demo-free-roam, demo-live-end), e2e demo-free-roam at 1440/390 light/dark, the walk's end.

## Decisions

docs/decisions/20261119-demo-free-roam-web.md

## Result

Built as planned. Unit: web/test/unit/demo-free-roam.test.tsx, demo-live-end.test.tsx; e2e:
web/test/e2e/demo-free-roam.spec.ts; the demo walk checks the busy (default) and available (DEMO_LIVE=available) ends.
