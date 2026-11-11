# A team join link opened while signed in says who is signed in and offers to sign out

- Date (UTC): 2026-11-11 12:23
- Branch: `fix/join-link-signed-in`
- Status: done
- Where: `web/src/App.tsx`, `web/src/pages/Auth.tsx`, the five locales. Why: sign-in and invites are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: the link no longer gets lost without a word; same page and words as a personal
  invite already has

## Goal

QA TC-200: someone signed in as A opens a team join link (`/join#t=…`) in the same browser (a shared computer, an
admin trying the link they made, the phone app already on this team). It goes to A's Home and the link is lost with no
message. A personal invite (`/invite/…`) already says who is signed in and offers to sign out and accept it (PR #387).
The team link should do the same: "이미 로그인되어 있어요 · 지금 A로 로그인되어 있어요" with 로그아웃하고 참여하기 /
이 계정으로 계속 쓰기.

## Scope

In:
- Signed-in `/join` (App.tsx `AfterJoin`): when the address still has the link's token, show the signed-in page
  instead of going Home. Right after a join the token is already gone (the join page takes it out of the address as
  soon as it opens), so that path still goes to the skill the link named, else Home.
- `InviteWhileSignedIn` (pages/Auth.tsx) serves both: for the team link it keeps the token in memory, takes it out of
  the address bar as the join page does, and after signing out opens `/join#t=…` so the join page reads it.
- Words for the team link: "이 링크는 팀에 새로 들어올 사람을 위한 거예요. 참여하려면 먼저 로그아웃해 주세요." and
  "로그아웃하고 참여하기", in all five locales.

Out: anything on the server; the forced password change screen (it keeps its own route).

## Steps

1. App.tsx `AfterJoin`: read once whether the address has the link's token; if so, render the signed-in page.
2. Auth.tsx: `InviteWhileSignedIn` reads the team link when there is no `:token`.
3. i18n: `teamLink.signedInBody`, `teamLink.signOutJoin` (EN/KO/ID/JA/ES).
4. Unit test (web/test/unit/invite-signed-in.test.tsx): the team link page, sign out and join keeps the token,
   keep the account goes Home; right after a join (no token) still goes where the join said.
5. `changes/join-link-signed-in.md`.

## Risks

- The token must not stay in the address bar (history, screenshots): taken out at once, as on the join page.
- PR #396 edits Auth.tsx (imports and the join pages); this change stays in `InviteWhileSignedIn` and adds no import
  there.
- Five locales; Korean in plain 해요체.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, the auth e2e specs; a local dev
server check with a real team link while signed in.

## Result

Built as planned. One thing the plan did not foresee: the window can be signed out before the logout request answers
(the live connection hears the session end, store/live.ts), and the signed-out join page reads the token from the
address as it opens. So "로그아웃하고 참여하기" puts the address (with the token) back first and then signs out. The
personal invite keeps its token in the path, so it did not need this; it goes the same way now.

Checked on a local dev server (Chromium and WebKit): signed in as a member, the team link shows "이미 로그인되어 있어요 ·
지금 에이로 로그인되어 있어요…" with the two buttons, and the token is gone from the address; 로그아웃하고 참여하기 ends
the session and shows the join form ("QA-Acme 팀에 참여하기"); joining there signs the new person in and lands Home;
이 계정으로 계속 쓰기 goes Home still signed in. (Headless Chromium needs the Badging API stubbed: chrome-headless-shell
kills the page when the app clears its badge on sign-out, any sign-out; not an app problem.)
