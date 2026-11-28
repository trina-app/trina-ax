# No "Continue in the app" on a team opened at this computer's own address

- Date (UTC): 2026-11-28 10:34
- Branch: `fix/loopback-no-open-in-app`
- Status: done
- Where: shared/src/team-link.ts (+ the phone copy), desktop/src/common/address.ts, web/src/lib. Why: the rule that a
  link from outside may open the desktop app belongs to the shared link reading (docs/REPOSITORY-RULES.md).
- Version impact: patch. A button that could never work is no longer offered; nothing new.

## Goal

Windows WSL QA (2026-11-28): the server and the browser on one PC at `http://127.0.0.1:47820`. The first screen, the
invite pages and setup's end offered "Windows 앱에서 계속", but the desktop app refuses every link from outside that
points at this computer (desktop/src/common/address.ts readDesktopLink), so the button did nothing. The web allowed
`localhost`, `127.0.0.1` and `[::1]` on purpose ("this machine for development"). After this, a page at a loopback
address offers no "open in the app" at all; every other address keeps the 11-25 rule (the app first on a computer).

## Scope

In:
- One shared rule, `appLinkOpens(origin)` in shared/src/team-link.ts: https and never a loopback host
  (isLoopbackHost). The desktop's readDesktopLink and the web's offers both use it.
- Web: appComputer (setup → /open-app, /open-app itself, the files line), openInAppHref's computer link (the join
  pages' "Open the app" / "앱에서 열기", the title menus' "Open in the app").
- The files line (welcome files step, My files) on a loopback page in a Mac or Windows browser: one short line that the
  app connects when this address is pasted on its first screen (docs/INSTALL-WINDOWS.md), in the six languages.
- Web e2e runs the mock team at http://127.0.0.1: the specs that test the offers set one test-only key so they keep
  testing them.

Out: the Android intent link (the phone app's own rules); using the team's public address for the link instead.

## Steps

1. Shared helper + phone copy; desktop readDesktopLink uses it.
2. Web rules, the files line's paste variant, i18n.
3. Unit tests (helper, appComputer, openInAppHref, the files line), e2e seam.
4. docs/decisions file amending 20261125-invite-open-app-first, changes/ note.

## Decisions

docs/decisions/20261128-loopback-no-open-in-app.md (amends docs/decisions/20261125-invite-open-app-first.md and
docs/decisions/20261116-desktop-first-onboarding.md: "or this machine for development" is gone).

## Risks

Developers at `http://localhost` lose the offers (they type the address in the app, as the app requires anyway).
No migration, no permission change.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/team-link.test.ts, tests/unit/e-desktop-common.test.ts,
web/test/unit/open-app.test.ts, web/test/unit/join-open-app.test.ts, the web e2e specs of the offers.

## Result

Built as planned. `appLinkOpens` (shared) is what readDesktopLink and the web's `appLinkOffered` both use; openInAppHref
returns no computer link and appComputer no computer at a loopback page, so setup, /open-app, the join pages, the title
menus and the welcome card all follow. The files line at a loopback address says to paste the address in the app. The
e2e config's `mycel.e2eAppLinks` keeps the offers testable at the mock's 127.0.0.1; a new open-app spec case runs
without it (Windows, 127.0.0.1: no offers, the paste line).
