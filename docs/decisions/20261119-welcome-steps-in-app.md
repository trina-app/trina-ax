# The welcome steps start at setup, so the desktop app resumes them

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (adds to [20261116-desktop-first-onboarding.md](20261116-desktop-first-onboarding.md) and [W4/W5 of the archive](../DECISIONS.md))
- Branch: fix/welcome-steps-in-app (plan: docs/AGENTS/plan/20261119-1812-welcome-steps-in-app.md)

- **Ask:** the owner of a new hosted team pressed "Continue in the Mac app" after `/setup` and saw only "Connect AI" and
  skills, then nothing: no company profile, no team files, no invite, no "Continue setup · n/5". The welcome-progress row
  was made only when `/welcome` opened once, in the browser tab the owner had just left, so Home's landing check and the
  setup row in the app read no row. The setup link's company website stayed in that tab's sessionStorage too.
- **Rule:**
  - `POST /api/setup` makes the owner's welcome-progress row (fresh steps, nothing finished) right after the team and
    owner exist (`startWelcomeAtSetup`, server/src/onboarding/welcome.ts). Same for every install, since every setup page
    went on to `/welcome` or `/open-app` anyway. It never fails the setup (a failure is logged; `/welcome` still starts
    the row on its first visit). A row already there is kept as it is, only a missing website is added (idempotent).
  - The setup page sends the link's website (`SetupBody.site`, optional, at most 300 characters). The server keeps it
    normalized (http(s) only, `normalizeWebsite`; anything else is dropped, not an error) in the row's existing `site`
    field, which owners and admins read and members cannot (403), as before. The company profile step reads it there,
    on any device. The tab's sessionStorage copy stays as a fallback for an older server.
  - `/app-signin` → Continue is unchanged: it lands on Home with the landing state, which now finds the row and opens
    the steps where they stopped. "Continue setup · n/5" follows the existing rules (lib/welcome.ts setupRowState); while
    no AI answers, Home's no-AI card still stands in for it on Home.
  - Not changed: teams made before this (no row) get no row: an old team whose owner never opened the steps is not sent
    into them now. The command-line owner (`admin create-owner`) gets no row either. Members are not affected (the row is
    the owner's; members never read it).
- **Also in this branch (owner 2026-11-20):**
  - Every Home onboarding card can be closed with the member welcome card's quiet "Hide" (one component,
    components/onboarding/CardHide.tsx): the 7-day goal card (open and reached) and "Ready in your team". The hide is a
    person's preference on the server (`prefs.goalCard`, `prefs.preparedCard` = `'hidden'`, cleared with `null` through
    `PATCH /api/me`), so it holds in the app and the browser alike. A toast offers Undo; Settings › Profile shows one
    "Show … on Home again" row per hidden card, and Admin › Home shows the goal's (beside the owner checklist).
    "Continue setup" already had ✕ (Admin › Home "Show setup again" brings it back); the member welcome card has its
    own Hide. The reached goal's per-browser localStorage dismissal is still read, never written.
  - Company profile while it reads (the welcome steps only): no "Do this later" while the AI works. After 90 seconds
    (counted from the reading's start, kept with the reading across a reload) one quiet "Don't wait, go on" puts the step
    off and goes on. The reading keeps running on the server; the step's kept reading (sessionStorage of that window)
    picks up its draft and saves it when Company profile opens again ("Still to do" row). A failed reading opens the
    fallback with its controls as before. Admin › Team settings keeps its Cancel throughout.
- **Tests:** tests/unit/b-welcome-at-setup.test.ts, tests/unit/b-onboarding-welcome.test.ts, web/test/unit/goal-card.test.tsx,
  web/test/unit/profile-step.test.tsx, web/test/e2e/open-app.spec.ts, web/test/e2e/home-card-hide.spec.ts,
  web/test/e2e/welcome-profile-reading.spec.ts.
- **Version impact:** patch (one optional request field, two optional preferences; nothing removed).
