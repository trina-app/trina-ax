# Aside: read the account list from an Aside CLI without `account list --json`

- Date (UTC): 2026-11-21 00:40
- Branch: `fix/aside-old-cli-account-list`
- Status: done
- Where: desktop/src/common/local-apps.ts. Why: the desktop app runs the listed Aside connector (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix in the desktop app's Aside connector with no new interface

## Goal

On a Mac with an older Aside CLI (1.26.1023, Oct 2026), Trina told the AI "Aside Browser isn't signed in" and listed no
profile, while the person has many profiles and Claude Code reaches them. That CLI has no `--json` on
`aside account list` ("unknown option '--json'", exit 1). Aside's current account there has no profile, so the first
`browser_profiles` is empty; the manager then reads the account list to find an account with profiles, gets nothing
back, and sends ASIDE_SIGNED_OUT. The same CLI does have `aside host profiles --account uN --json` and
`aside mcp --account uN`.

After this, Trina finds the accounts with profiles from that CLI's plain `aside account list` and lists every
account's profiles, as on a newer CLI.

## Scope

In: when `aside account list --json` prints nothing (fails), run `aside account list` and read its lines
(`* u1  <name>  signed out  profiles: none`); use them for the retry account and for the all-accounts profile list.
Out: asking people to update Aside; any change to the words the AI is given.

## Steps

1. Test fake (`tests/fixtures/local-apps/fake-mcp.ts`): FAKE_ASIDE_NO_LIST_JSON makes `account list --json` fail like
   the old CLI and prints the plain lines for `account list`.
2. Unit test in `tests/unit/e-local-apps.test.ts`: current account without profiles, other accounts with profiles,
   old CLI: browser_profiles lists all of them and no ASIDE_SIGNED_OUT. Parser test for the plain lines.
3. Fix in `local-apps.ts`: one reader of Aside's account list that falls back to the plain lines.
4. `changes/aside-old-cli-account-list.md`.

## Decisions

none

## Risks

Only the listed Aside connector. The plain lines are Aside's human output and may change; when they cannot be read,
the result is the same as before (no account found).

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/e-local-apps.test.ts` and the related local-apps tests.

## Result

Built as planned: `asideAccountLines` reads the plain lines, `asideAccountList` and `asideAccountsWithProfiles`
fall back to it, and `asideAccountsOut` runs `aside account list` when `--json` printed nothing. Accounts now carry
`hasProfiles` (the plain lines name profiles by label, not id). The new unit test fails with the old code with
exactly ASIDE_SIGNED_OUT. PR linked in the PR description.
