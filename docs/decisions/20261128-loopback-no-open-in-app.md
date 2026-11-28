# A page at this computer's own address offers no "Continue in the app"

- Date: 2026-11-28
- Status: accepted
- Supersedes: none. Amends [20261125-invite-open-app-first.md](20261125-invite-open-app-first.md) and
  [20261116-desktop-first-onboarding.md](20261116-desktop-first-onboarding.md): their "https, or this machine for
  development" is now "https, never this machine".
- Branch: fix/loopback-no-open-in-app (the owner, "ㅇㅇ", 2026-11-28; Windows WSL QA)
- Plan: [docs/AGENTS/plan/20261128-1034-loopback-no-open-in-app.md](../AGENTS/plan/20261128-1034-loopback-no-open-in-app.md)

- **Ask:** on Windows with the server in WSL, the server and the browser are on one PC at `http://127.0.0.1:47820`.
  The setup's end, the invite pages and the files line offered "Windows 앱에서 계속", and the button did nothing: the
  desktop app refuses every link from outside that points at this computer (a web page must not point the app, its team
  view and its bridge at a local port). The web had allowed `localhost`, `127.0.0.1` and `[::1]` on purpose, for
  development and the tests.
- **Rule:** one shared rule, `appLinkOpens(origin)` in shared/src/team-link.ts: https, and never a loopback host
  (`isLoopbackHost`: localhost, `*.localhost`, 127.0.0.0/8, 0.0.0.0, ::1, ::, their IPv4-mapped forms). The desktop app
  reads links from outside by it (desktop/src/common/address.ts readDesktopLink) and the web offers the app only where
  it holds (web/src/lib/team-link.ts appLinkOffered): setup → /open-app, /open-app itself, the join pages' Open the app
  and "앱에서 열기", the title menus' Open in the app, the welcome card's and the files line's link. At a loopback
  address none of them shows; setup goes to the welcome steps, the join pages show the form. Every other address keeps
  the 11-25 rule (a computer's browser offers the app first).
- **One line instead, where the app matters:** the files line (welcome files step, My files) on a Mac or Windows page at
  a loopback address says "To use it, paste {address} on the app's first screen." The app's first screen takes `http://`
  for this computer's own address (docs/INSTALL-WINDOWS.md "Desktop app on this PC"). Nothing else is added.
- **Tests:** the web e2e suite runs its mock team at `http://127.0.0.1`. Its config sets the localStorage key
  `mycel.e2eAppLinks` so the specs keep testing the offers there; it counts on a loopback page only and nothing else
  sets it. Unit tests: tests/unit/team-link.test.ts (the rule, both copies), tests/unit/e-desktop-common.test.ts
  (readDesktopLink opens exactly what the rule allows), web/test/unit/open-app.test.ts and join-open-app.test.ts.
- **Left out:** the Android intent link (the phone app's own rules); handing the app the team's public https address
  instead of the page's own.
- **Version impact:** patch (a button that could never work is no longer offered).
