# A welcome for invited people: one Home card, the inviter's name, held template notices

- Date (UTC): 2026-11-11 11:07
- Branch: `feat/member-welcome`
- Status: done (rebased on dev after 997f87f4f; PR to dev)
- Where: Team AX core (server auth/onboarding/rooms/notifications, web Home, Room, Files, join pages). Why: joining,
  rooms and Home are core; nothing here is Trina-only (see docs/REPOSITORY-RULES.md)
- Version impact: minor (a new endpoint, a migration and a visible change on an invited person's first screen)

## Goal

Someone who joins with a team link, a single-use invite or "Add directly" lands on a bare Home: nobody says who invited
them, the team does not hear they joined, the first Activity item is a connector template, and ✦ in rooms is explained
only by a placeholder. The product owner approved (2026-11-11) one Home card and a few small fixes, no wizard, no tour.

## Scope

In:
1. A welcome card at the top of Home for an invited person (members and invited admins; never the team's creator), while
   they joined in the last 14 days and have not finished or hidden it: "Welcome to {team}, {first name}", "{inviter}
   invited you · {n} people are here" (no inviter: the line without "invited you"), "Get started · {done} of {total}",
   Hide, and rows: a. "You're in {rooms}" (done; opens Conversations), b. "Say hi to the team" ("👋 Hi, I'm {first
   name}" posts in Everyone as them; done once they posted any room message), c. "Add your photo" (optional, the photo
   picker in place; done with a photo), d. "Ask {AI} what you can do here" (one tap starts a normal chat with a fixed
   question; done once it ran). With no AI, row d is the no-AI action (connect my AI, or "Tell {owner}" once, then
   "Told them"), and the separate no-AI card does not show while the card does. The card replaces "Ready in your team"
   while it shows. All done: "You're all set", then gone for good.
2. The "{name} joined the team" line in Everyone and the owners' `team.joined` notice come from dev (997f87f4f, "A new
   member is told to the team": `RoomsService.memberJoined`, invites and the team link). This branch adds no event kind,
   text or notice of its own; it extends dev's mechanism to the one case dev left out, an admin's "Add directly": the
   line and the owners' notice (except the owner who added them) at the person's first successful sign-in, once, never
   for an account disabled or deleted before it (owner's decision). The line is an event, not a message: "Say hi" stays a real
   message and is done only by one.
3. The join pages say "{inviter} invited you to {team}" (team link and single-use invite).
4. No connector-template notice at join: a new person's template notices wait until they open Connected apps (the
   templates are listed there, so the offers are recorded silently then) or until 14 days have passed.
5. A one-time line under a room's header: "✦ Ask {AI} about this room. Only you see it." Dismissed or ✦ used: never again
   (a per-person preference, `prefs.roomAskHint`).
6. Small fixes: a team link opened while signed in says "You're already in {team}"; Files › Personal is not called
   read-only (it holds the person's own folder); greyed New folder / Upload get a one-line reason.

Out: an admin-written welcome message (owner: "next time"), a tooltip tour, asking role or purpose, the notification
permission in the card.

## Steps

1. Migration 342 `member_welcome` (user_id, invited_by, via, joined_at, hidden_at, asked_at, done_at, apps_seen_at,
   added_by, announced_at).
2. Server: `onboarding/member-welcome.ts` (record a join: the row only; the card's state; hide/asked), the three join
   paths (recordJoin; for "Add directly", `firstSignIn` from `signIn` calls dev's `memberJoined` and `notifyTeamJoined`), inviter on the two info
   endpoints, the template hold in `offerTemplates` and the silent offers in `listIntegrationTemplates`.
3. Contract: `GET/PATCH /api/me/welcome` (`auth: 'user'`, the caller only), `inviterName` on the two info answers,
   `prefs.roomAskHint`.
4. Web: `components/onboarding/MemberWelcome.tsx` on Home (desktop and phone, 44 px targets, no frame on phones), the
   hint in Room, the join page titles, AfterJoin's toast, Files labels. i18n in en (source), ko, id, ja, es.
5. DECISIONS.md section, `changes/member-welcome.md`.

## Risks

- Migration number: 342 (highest on dev: 341; 600/701 are other series).
- Permissions: the welcome endpoint reads and writes only the caller's row; the inviter's name is public on a valid
  token's info page only (as the team name is). Row d's question runs as the person, with their permissions.
- Template notices: held only for people with a welcome row; everyone else unchanged.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; server unit tests (dev's join line and notices for the
three ways, no template notice at join and the silent offer on Connected apps, the welcome endpoint only for the caller, the
security matrix case); web unit tests (the card's rows and done states, hide, phone, no-AI rows, the inviter line with
and without an inviter, the ✦ hint once, Files labels); the e2e specs closest to Home, rooms and join; a look at
1440×900 and 390×844, light and dark.

## Result

Built as planned. Rebased on dev after 997f87f4f ("A new member is told to the team"), which had shipped the joined line
and the invite notice meanwhile: the branch's own `Rooms.joined`, its duplicate event type, texts and notice code were
dropped for dev's, recordJoin now keeps only the welcome row, and "Add directly" calls dev's `memberJoined` and
`notifyTeamJoined` at the person's first sign-in (owner's decision: not when the account is made). Migration 342 was still free.
