# A free-roam demo's screens: one bar, one dialog at the limit, nothing of the AI account

- Date: 2026-11-19
- Status: accepted
- Supersedes: none
- Branch: feat/demo-free-roam-web (the owner's free-roam demo plan, 2026-11-19, part D, web)

- **Ask:** the visitor of the live demo (docs/decisions/20261119-demo-free-roam-a.md) must see at once who they are and
  what to try, how much demo AI is left near the end, and what happens at the limit; never which AI account answers.
  The scripted demo hands over to it only when the gate can take a visitor.

- **Rule: finding the demo.** A free-roam instance has `me.server.dev` false, so the web app asks GET /api/demo when
  signed out (every server, as before), on a development server, or when the feature row is all off on a
  self-installed server (lib/freeRoam.ts mayBeDemoServer). Only a free-roam demo has that row
  (server/src/system/deployment.ts FREE_ROAM_OFF); a real install, office mode and dev keep update and connected folders
  on, and the hosted service says `deployment: 'hosted'`. We chose this over a new `me.server` flag so part A's
  contract stays as it is. If the feature table changes, the check changes with it (web/test/unit/demo-free-roam.test.tsx checks it
  against a self-installed, a hosted and a free-roam row). The
  signed-in app waits for the answer (App.tsx), so a hidden screen never shows for a moment first, and code outside a
  component can ask `freeRoamNow()` (store/session canChooseEngine).

- **Rule: the bar.** It takes the demo bar's place at the top, in the page's flow, so it never covers a message box.
  It says "You're {name} at {company}, a made-up company. Try anything." and shows 2-3 suggestions. They come from
  GET /api/demo `freeRoam.suggestions` (the demo content's, each a short `label` on the chip and the `prompt` it
  sends), else the person's `questions` from the demo file, else built-in ones ("Make next week's social posts",
  "Check Chris's reply", "What's in our Brand assets folder?"). **A tap sends the suggestion's prompt as a new chat**, the existing pattern of the scripted demo's questions
  (components/demo/Demo.tsx DemoQuestions). Filling a box would not work: the bar is on every screen and a box is not.
  On phones the suggestions are one row that scrolls sideways and hides while the keyboard is up. Home does not show
  the same suggestions a second time.

- **Rule: the meter and the limit.**
  - Under 80 % of `cap` the meter says nothing. From 80 % it shows one quiet line, "About N% of your demo AI left". N
    goes in steps of 5, rounded up, at most 20. No number of tokens is ever shown.
  - The use is read again after every answer (store/live.ts message.done → store/demo.ts).
  - The limit is marked used up when any of these happens:
    - GET /api/demo counts `used >= cap`;
    - any request is refused with 403 and `params.reason: demo_limit` (lib/api.ts onDemoLimit);
    - an answer ends with that reason.
  - The dialog ("You've used this demo's AI" / "Everything you made stays here to look around." / Start free / Look
    around) opens once per tab (sessionStorage). Then every AI message box does not send and shows one calm line with
    Start free: the chat's, Home's, and ✦ in a room. The room's own box is untouched.
  - Start free opens the demo file's `signupUrl` in a new tab. Without one, there is no button.

- **Rule: words.**
  - A failed answer with `demo_rest`, `demo_busy` or `demo_limit` reads the web's own line from the i18n tables. The
    server sends the same words. The words are never the AI account's.
  - A refusal with `demo_fenced` (any area) reads "Not available in the demo" (lib/api.ts errorText). It is short and
    the same everywhere.

- **Rule: hidden surfaces.**
  - Settings drops Usage, AI providers, AI apps, Dev environment sites, Security & devices and Apps
    (pages/settingsTabs.ts); the pages under them (account deletion, password, devices) go back to Settings by address
    too (lib/freeRoam.ts FREE_ROAM_HIDDEN_PAGES).
  - Profile: name, job title and email are read-only, with one line that they belong to the demo; "Delete my account"
    is gone. Photo, language and theme still change. (The title is read-only too: it is saved by the same call as the
    name, which the server refuses.)
  - Notifications: no phone notifications and no push to this device; the "turn on notifications" line never asks.
  - Connectors: the connected services as rows to read (no page to open), one line that new ones are not available,
    no Add, no Discover, no requests, no Slack row, no "ask your admin" empty state.
  - No Scheduled in the Trina panel, the phone drawer or search (its address shows the one line); no Invite people
    (team menu, search, the phone's team row) and no guest invite in rooms and projects.
  - No mic in any message box (lib/voice.ts micState).
  - At the limit the dialog starts on Start free (Look around when there is no sign-up address), never on ✕ with its
    tooltip; the AI message boxes become read-only (aria-disabled) and send looks off.
  - Phones: while more suggestion chips are past the bar's right edge, the edge fades (data-more).
  - Nobody picks the AI, and "answered by" is gone (canChooseEngine is false).
  - The admin pages show one line instead. The dev environment's line is "The dev environment isn't available in the
    demo.". The server refuses all of these anyway.
  - The sign-in page shows only "Continue as {name}". It POSTs to the gate's `/__demo/resume` (same origin), which
    signs the visitor back in on their own instance. A 2xx opens the app; anything else, or no answer, goes to
    `/__demo/start` (lib/freeRoam.ts resumeFreeRoam).

- **Rule: the scripted demo's handoff.**
  - At the story's end the overlay reads `https://demo.trina.app/__demo/status?lang=<locale>` once, with a 2.5 s
    timeout and no credentials (web/demo/live.ts).
  - Only `{ available: true }` in time offers **Now try it yourself** (primary, to `https://demo.trina.app/?lang=<locale>`)
    beside the plans link.
  - Anything else shows "The live demo is busy right now" and keeps the plans link alone, as before, with a small
    "Try again" that reads the status once more.
  - While it is asked, the button waits (it is never a link that may lead nowhere).
  - The words are in the story's strings in all six languages. The build may replace the address
    (VITE_DEMO_LIVE_URL).
  - The page's CSP must allow `connect-src https://demo.trina.app`. The test server's does (web/test/demo/serve.ts);
    the site's header for /demo/ needs the same.

- **Found on the way:** the scripted demo's build had stopped at load on main and dev ("AsyncLocalStorage is not a
  constructor"). Since a76bae7d6, server/src/policy/access.ts (which the mock server imports) uses
  node:async_hooks, and the demo build had no stand-in for it. web/demo/shims/node.ts now has a one-thread
  AsyncLocalStorage, and web/demo/vite.ts aliases node:async_hooks to it.

- **Left out:**
  - a test of ✦ in a room at the limit (the side chat's box uses the same hook, useDemoOut, as the chat's box, which
    the e2e covers);

- **Tests:**
  - web/test/unit/demo-free-roam.test.tsx;
  - web/test/unit/demo-live-end.test.tsx;
  - web/test/e2e/demo-free-roam.spec.ts (1440 and 390, light and dark, a mocked GET /api/demo and /api/me);
  - web/test/demo/walk.spec.ts (the end, busy by default; `DEMO_LIVE=available` for the other state).

- **Version impact:** none (demo mode only).
