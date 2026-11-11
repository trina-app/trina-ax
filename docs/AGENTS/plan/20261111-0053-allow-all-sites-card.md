# "Allow all websites" covers the AI's web reads, from Settings and from the address card

- Date (UTC): 2026-11-11 00:53 (security review applied 2026-11-11)
- Branch: `feat/allow-all-sites-card`
- Status: done
- Where: Team AX core (`server/src/tools/url-gate.ts`, new `server/src/tools/web-allow-all.ts`, `server/src/routes/auth.ts`,
  `server/src/routes/admin.ts`, `shared/src/api/auth.ts`, `web/src/pages/BrowserSettings.tsx`,
  `desktop/src/main/app-window.ts`). Why: web access rules and permissions are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new per-person setting, a new team setting (on by default), a new answer on a card, new
  `Me` fields and a route, a migration. Old apps keep working.

## Goal

A teammate: "After I make a request, lots of these permissions pop up. Can I set a mode that lets everything through?"
The screenshot is the server's address card (`url-gate.ts` `TEXT.unseen`: Open / Allow this site in this conversation /
Don't open). The owner: it is possible in Settings, and it should be possible from the card too.

**Checked first: Settings › Browser "Allow all websites" does not cover this card today.** It is the desktop app's own
value (`permissions.json`, per team and computer; `site-permissions.ts isAllowed('site')`), read only by the in-app
browser's pane. `gateUrl` reads no per-person setting, and web_fetch, save_url and the browser tools' server check all
go through it. DECISIONS "앱 안 브라우저 … 모든 웹사이트 허용" lists this as left out ("서버 쪽 주소 규칙 … 이 설정을
모른다 … 범위 밖으로 남긴다"), and "설정 › 브라우저와 팀의 정책" says the web_fetch check stays. The Browser tab exists
only inside the desktop app.

After this change, every person gets one switch, "Allow all websites" (an admin can take it away). When a person turns
it on, the AI opens ordinary public addresses without the address card when that person asks, in chats and rooms. The person can turn
it on from Settings or from the first address card, and turn it off in Settings.

## Security review (2026-11-11): "build after fixing the MUSTs", and the owner's call

Every MUST below is in this plan, and the SHOULDs the owner kept; the NITs are folded in where they belong.

**The owner's calls (2026-11-11, final), overruling MUST 1 and three SHOULDs:**
- MUST 1 dropped: "it's a team, leave it". ①d and the card's answer also apply in rooms, in shared chats and after a room
  read. It is always the switch of the person whose turn it is, never another member's.
- SHOULD 3 dropped: no ①d budget. "Always allow" means no more cards for plain addresses; the other exceptions stay.
- SHOULD 7 dropped: the fourth answer shows on the **first** address card wherever ①d would apply ("Claude's own apps
  show 'always allow' right away").
- SHOULD 6 changed: the separate team key `webAllowAll` stays, but it is **on by default** for existing and new teams.
  Admins can turn it off (one indented line under the existing switch).

The review's list, as built:

- ~~MUST 1: own chat only~~ (dropped by the owner: rooms, shared chats and chats that read rooms are in; always the
  caller's own switch). §2.
- MUST 2: one honest risk sentence, versioned, on the card, in Settings and in the desktop app's window; it names room
  messages. §3, §4, Risks.
- ~~SHOULD 3: ①d has its own budget~~ (dropped by the owner).
- SHOULD 4: the echo test is inside `plainAddress`, so echoes ask under ①b and ①d. §2 names the order.
- SHOULD 5: the policy is race-free through an epoch. §1.
- SHOULD 6: a separate team key `webAllowAll`, one indented line under the existing switch; `browserAllowAll` keeps its
  meaning. On by default (the owner). §1, §4.
- ~~SHOULD 7: the fourth answer only from the third card~~ (dropped by the owner: the first card offers it). §3.

## Decisions

### 1. One switch, one value per person on the server, behind its own team key

- **Team key.** A new team setting `webAllowAll` ("…also for web pages the AI opens"), **on by default** for existing
  and new teams (the owner's call, 2026-11-11). It is one indented line under "Members can turn on 'Allow all websites'" (`browserAllowAll`) in Admin ›
  Team settings, and it needs that switch on. `browserAllowAll` keeps its meaning: admins agreed to it for the desktop's
  own browser only. While `browserAllowAll && webAllowAll` is not on, nobody's flag works, Settings shows no server
  switch, and the card does not offer it.
- **Where the person's value lives.** A new table `user_web_access`, migration `339_c_web_allow_all.sql` (the next free
  number in C's range 300–399 on dev; check it again before merge). It is additive (reader 1), with these columns:
  `user_id` (PK, cascade), `allow_all`, `warning` (the version of the risk text the person accepted,
  `WEB_ALLOW_ALL_WARNING_VERSION` in shared), `epoch` (the policy epoch when it was turned on), `via` (`settings` |
  `card`), `turn_id`, `updated_at`.
  - Not `users.prefs`: PATCH /api/me writes prefs freely, with no warning and no audit. A test shows that a `webAllowAll`
    key sent in prefs leaves the flag off.
- **The effective value.** `webAllowAll(db, userId)` in `tools/web-allow-all.ts` is true only when all of these hold:
  the row is on; its warning version is the current one; its epoch is the current policy epoch; the team allows it
  (both keys); the account is active. The gate reads it on every call, with no cache.
- **Race-free policy (epoch).** The setting `web.allowAllEpoch` counts policy changes. When an admin turns either key
  off, one transaction writes an audit row (`web.allow_all_off`, `via: 'policy'`, the admin as actor) for each person
  whose flag was on, turns their rows off, and adds one to the epoch. A PUT or a card answer reads the policy and the
  epoch and writes its row in one transaction, so a row written under the old policy can never count. Turning the key
  back on turns nobody's switch on.
- **Implicit off is audited too.** A warning-version bump (the row reads as off the next time it is read: one
  `web.allow_all_off` row, `via: 'warning'`) and an account deactivated or deleted (Admin › Members, `via: 'account'`).
- **The route.** `PUT /api/me/web-access` takes `{ on, acceptWarning? }` and returns `{ allowAll }`.
  - Turning on needs `acceptWarning === WEB_ALLOW_ALL_WARNING_VERSION` (else 409 `web_allow_all_warning`) and the team
    allowing it (else 409 `web_allow_all_off`). Turning off always works.
  - Not `allowWhilePasswordChange`: a person who must change the password cannot turn it on.
  - `Me.user.webAllowAll?: boolean` (effective) and `Me.team.webAllowAll?: boolean` (the team allows it). Absent (an
    older server) means off.
  - A change sends `notice web_access_changed` to that person's own windows.
- **How it relates to the desktop app's own value.** The desktop rule stays: the team server can make the in-app browser
  stricter, never wider ("팀 페이지·사이트·AI는 못 바꾼다": that browser holds the person's signed-in sites).
  - **Turning it on inside the desktop app**: one decision sets both. The app's own window (its text now
    carries the risk sentence) → on yes, the page PUTs on. If the PUT fails, the page puts the browser back to asking.
  - **Turned on somewhere else** (the card, the web app, another computer): this computer's browser keeps asking until
    the person confirms in the app's window. Settings › Browser in the desktop app shows one line under the switch, "The
    in-app browser on this computer still asks for each new site", with [Allow here too], which opens the app's window.
  - **Turning it off anywhere**: the desktop app follows, because that makes it stricter. `fetchTeamInfo` reads
    `me.user.webAllowAll` where it reads the team policy now. When it sees the value change from true to false (the last
    value is kept in `permissions.json`), it puts the browser back to asking. It never widens because of this value.
  - **A browser set to "all" before this release** (the server value was never on) stays as it is.
  - **With the team key turned off by an admin**, Settings › Browser in the desktop app is what it is today (this
    computer's browser only).
  - **⚙ in the browser panel** still changes this computer's browser only.

### 2. Rule ①d in `gateUrl`: what opens, in what order, and what still asks

The order in `gateUrl` (addresses with a long query, or while the exit address is unknown, skip all of it and ask):
1. ① typed by the person or allowed on a card: opens.
2. `plain = plainAddress(…)`: the address has a site (a registrable domain); no long random-looking part
   (`opaqueParts`); the name before the site is shorter than `MAX_SITE_SUBDOMAIN`; no user name or password; and **it is
   not an echo** (a learned link that carried what the AI had sent). The echo test now sits here, so an echo asks under
   ①b too (before, ①b returned before the echo test).
3. ①b: `plain` and its site allowed in this chat: opens. ①b still works in rooms (unchanged).
4. A learned link within the link budget (30 / 150): opens.
5. An echo: asks (its own text).
6. ①d: `plain`, a turn ①d applies to (below), and the flag of the turn's own person is on: opens. No budget (the owner).
7. Anything else: the card.

**Where ①d applies.** The owner dropped the review's MUST 1 (2026-11-11: "it's a team, leave it"): rooms, shared
chats and chats that read rooms are in. What stays:
- **always the caller's own switch**: `gateUrl` takes `userId` from the turn (web_fetch `t.user.id`, the browser tools
  `spec.userId`); a room's AI session is the asker's, a shared chat's turn is the person's who asked. Another member's
  switch never applies;
- the turn was asked from the person's own app with its steps shown live: `clientKind` web, desktop or mobile
  (`TurnPerson.allSitesHere`). Not a scheduled run, a Slack question (its cards wait in the app, but nobody sees its
  steps live), a company-profile draft, or a turn started by the server;
- not a confidential chat.

What the owner accepted: room messages go into the prompt as `<room_context>` (`rooms/ai.ts`), and web_fetch gets no
room card there, so another member's message can steer the asker's AI to send what the asker can read. The risk
sentence names room messages for that reason.

**No ①d budget** (the owner's call, 2026-11-11). The review's 60 / 300 cap is dropped: "always allow" means no
more cards for plain addresses.

**Runs nobody watches: not covered.** Scheduled runs, calls outside a turn and company-profile drafts keep today's
rules (card-allowed addresses, 8 learned links). Nobody sees their steps as they happen; the person confirmed a schedule
card that listed the task's addresses, and the flag could be turned on later; a run that reads team files unwatched is
where an injected instruction does most harm. The refusal in such a run says that "Allow all websites" does not apply.

**save_url and addresses from connections: covered, the address check only.** Same gate, same channel (a GET). Its
large-file card, redirect check, type check, disk check and the room and wider-audience save cards stay. Not covered:
connection writes, the room card from `carriesAddress`, MCP tools, the dev environment's network (its own Full internet
switch).

**Unchanged around it.** No DNS lookup before the gate says yes. Private, local, metadata and the server's own addresses
are refused (`precheckTarget` before the gate, the checks after the lookup). The in-app browser's office-network card
stays. **Redirect hops** are checked by `redirectGuard` (echo of what the AI sent) and the network rules only, as today:
they do not get ①d's other checks (random-looking parts, long names), with or without the flag.

### 3. The card's fourth answer

- **The answers.** Open / Allow this site in this conversation / **Allow all websites (turn off in Settings)** (value
  `all_sites`; ko "모든 사이트 허용 (설정에서 끌 수 있어요)") / Don't open. English first in `url-gate.ts` `TEXT`, then ko,
  id, ja, es. The line under the question: "If you allow all websites, the AI opens public websites without asking when
  you ask it, in your chats and in rooms, until you turn it off in Settings › Browser. Long hard-to-read strings and long
  queries still ask, but that catches obvious tokens only." followed by the risk sentence (below).
- **On the first card** (the owner's call, 2026-11-11; the review's "third card" rule is dropped). Offered when all of
  these hold: ①d could cover this address (`plain`, no long query, exit address known, not an echo); a turn ①d applies
  to (§2); the person can choose; the team allows it; the person's flag is off.
- **Picking it.** This address opens. In one transaction the gate reads the policy and the epoch again and, if the team
  still allows it, sets the flag (`via: 'card'`, `turn_id`, the current warning version), audits `web.allow_all_on` and
  sends the notice. If an admin turned it off while the card was open, the address opens and the flag stays off.
- **Only the person can answer it.**
  - The card is `origin: 'server'`; the only way to answer it is `POST /api/turns/:id/answer`, by the turn's owner
    (`ownTurn`), with one of the card's own options (`TurnExec.answer` → `not_an_option`). Typed text never counts.
  - The AI has no session, and its ways onto the network refuse the team server: web_fetch and save_url block private
    addresses and the server's exit address, the in-app browser refuses the team address, the dev environment refuses
    team hosts (`userSiteProblem`), and the desktop PC runner (PR #37, not merged yet) runs code on the person's
    computer with no session of its own.
  - Outside AI apps hold remote-MCP tokens, which are not sessions. The gate never reads the AI's own ask_user cards.
    Room messages are not answers. Scheduled runs raise no card, and what a schedule card approved is stored data.
  - No tool and no MCP tool writes `user_web_access`.
- **No second confirm on the card.** Four answers keep the radio buttons and [답하기] (two actions); the card shows the
  full address, the line and the risk sentence; only the person's session can answer. Settings keeps its confirm.
- **Honest text (MUST 2).** One risk sentence, versioned as one text in shared (`WEB_ALLOW_ALL_RISK`, five languages,
  version `WEB_ALLOW_ALL_WARNING_VERSION` stored in the row): "A hidden instruction in a document, page or message can
  make the AI send anything it can read to any site." The card, Settings and the desktop app's window all show it. The
  texts also say the exceptions catch obvious tokens only (long random-looking strings and long queries still ask).
  Changing the sentence means a new version, and everyone's flag reads as off until they accept it again.
- **Seeing it, turning it off.** After the card: a toast "All websites are allowed. Turn it off in Settings › Browser."
  in that window. Settings › Browser shows the switch and the badge "Allowing all sites". Each address opened this way
  has "(all websites allowed)" at the end of its audit line. Off: Settings › Browser on any client; the team key off
  turns it off for everyone.

### 4. Settings UI

- Settings › Browser shows on every client when the team allows it (web, phone, desktop); inside the desktop app it shows
  as today. The tab id stays the same.
  - With the team key on, its one choice (Ask / Allow all) is the server value; the desktop app also shows this
    computer's browser line and the always-allowed sites.
  - With the team key turned off, the web and phone show no Browser tab, and the desktop shows today's page.
- **Text** (English first): the description names web pages the AI reads and files it saves from the web; the "Allow all
  websites" hint says it opens public websites without asking in your chats and rooms, that scheduled tasks still ask,
  that long random-looking strings and long queries still ask but that catches obvious tokens only, plus the risk
  sentence.
- **Turning it on**: web and phone, a confirm dialog with the risk sentence; desktop, the app's own window (its detail
  text gets the risk sentence too).
- **Admin**: Team settings, one indented line under the browser switch: "Also for web pages the AI opens" with a short
  description and the risk sentence in "Learn more". Disabled while the browser switch is off.

### 5. Audit

- `web.allow_all_on`: `via` (`settings` | `card`), `warningVersion`, `turnId` for the card.
- `web.allow_all_off`: `via` (`settings` | `policy` | `warning` | `account`).
- The actor is the person, or the admin for `policy` and `account`, or none for `warning`.
- Uses go into the existing tool audit line (full URL plus "(all websites allowed)"), not new rows.
- Labels `audit.act.web.*` in five languages. No admin list of who has it on; the audit log shows it.

## Steps

1. Plan update (this commit).
2. Shared: the team key, `Me` fields, the route, `WEB_ALLOW_ALL_WARNING_VERSION`, `WEB_ALLOW_ALL_RISK`.
3. Server: migration, `tools/web-allow-all.ts` (flag, epoch), `url-gate.ts` (`plainAddress` with the
   echo, ①d, the fourth answer, texts), `chat/tools.ts turnPerson` (`allSitesHere`, the notice), routes (PUT, `Me`,
   admin PATCH with the epoch, deactivation), summaries in web_fetch and save_url.
4. Web: Settings › Browser, the admin line, the notice and the toast, i18n in five languages, the mock server.
5. Desktop: follow the value when it turns off, the window text.
6. Tests, docs, `changes/allow-all-sites-card.md`, `bun run docs:api`.

## Risks

- **What it does not stop.** With the flag on, a hidden instruction in a document, page or room message the AI reads can
  make it send anything it can read to any site. The exceptions catch obvious tokens only:
  `opaqueParts` is a hint, not a rule. Lowercase-only data, or data cut into pieces shorter than 20 characters, passes;
  so do readable words in a path, a short name before the site or a short query, as many times as the AI calls. There is
  no budget (the owner's call). This is the risk the sentence names; each person opts in, and an admin can turn the
  team key off.
- **Rooms.** Another member's room message can steer the asker's AI (the owner accepted it; the sentence names it).
- **Migration number.** Another open branch may take 339. Check it again before merge.
- **Languages and screens.** The server card, the web and the desktop window, in five languages. On a phone, the card
  shows four radio answers.
- **Old and new apps.** An old desktop app with the new server ignores the field; the web value still works. A new
  desktop app with an old server gets no field; nothing changes.
- **Coordination.** No edits to `projects.ts`, `shared.ts` or `chat/read-rooms.ts` (another session's branch);
  `readRooms` is only called.

## Tests

New `tests/unit/web-allow-all.test.ts`, with the same harness and DNS stub as `site-allow.test.ts`:
- **Flag off**: the first card already offers the fourth answer, with the risk sentence; not with the team key off.
- **Flag on**: no card, and no lookup before the decision, for an address the AI wrote, a learned link over the link
  budget, save_url, a browser tool's address.
- **Flag on, still a card**: a random-looking part; a long name before the site; a user name or password (browser
  tool); a query over 200 characters; an unknown exit address (web_fetch and save_url only: the browser tools never pass
  `egressKnown`); an IP address or an address with no site; a confidential chat. A private IP literal is refused before
  any card; a name that resolves into the office network is refused after the lookup.
- **Always the caller's switch**: a room's @트리나 asked by Alice (on) opens without a card, asked by Bob (off) in the
  same room gets a card; in a chat others wrote in, another member's switch never counts.
- **Echo**: refused (a card) under ①b and under ①d.
- **Risk text**: the card's text holds `WEB_ALLOW_ALL_RISK` for its language, and the stored warning version is
  `WEB_ALLOW_ALL_WARNING_VERSION`.
- **Team key**: on by default; off → the fourth answer and the Settings switch are not offered (`Me.team.webAllowAll`
  absent), PUT on is 409, the gate ignores a row. Policy off → PUT → policy on leaves everyone off (epoch); the reset is audited.
- **Only the person**: the AI's own ask_user card answered `all_sites`, typed text, or another person's answer cannot set
  it; PATCH /api/me with `prefs.webAllowAll` leaves it off; a person who must change the password cannot PUT; a wrong
  warning version is 409.
- **Scheduled run** with the flag on: an address that did not appear is still refused; the run never sets the flag.
- **Implicit off**: a stale warning version reads as off and is audited once; deactivating an account is audited.
- **Card answer**: opens the address, sets the flag, audits `web.allow_all_on` via card with the turn id, sends the notice.

Elsewhere: the permission matrix and `security-route-coverage` (the new route), `site-allow.test.ts` (a real card now
offers the fourth answer), `web/test/unit/browser-settings.test.tsx` (the tab follows the team key, the confirm, the
desktop lines), `e-desktop-common.test.ts` (narrows on true → false, never widens on true).

Checks: `bun run typecheck`, `test:unit` (area files), `check:i18n`, `check:docs`, `docs:api` with
`tests/unit/docs-site.test.ts`, the web unit tests.

## Docs

- DECISIONS.md: a new section "Allow all websites covers the AI's web reads (feat/allow-all-sites-card)"; a note at the
  end of "Outbound web channels"; the "남은 것" line of "앱 안 브라우저 … 모든 웹사이트 허용" points to it.
- User docs: `docs/security-and-permissions.md` and `.ko.md`, `docs/site/use/settings-and-search.md`,
  `docs/site/agents/runtime.md`, `docs/for-admins.md` and `.ko.md`, `desktop/README.md`, the generated
  `docs/site/reference/http-api.md`.
- `changes/allow-all-sites-card.md`.

## Owner questions

None. The owner decided the open points on 2026-11-11 (no budget, first card, team key on by default).

## Result

Built as the plan says after the owner's calls of 2026-11-11: no ①d budget, the fourth answer on the first card,
rooms, shared chats and chats that read rooms included (always the caller's own switch), and the team key `webAllowAll`
on by default. The review's other points are in: the versioned risk sentence that names room messages, the echo test
inside `plainAddress`, the policy epoch, audit rows for implicit offs, and no `allowWhilePasswordChange`.

Differences from the plan:
- An independent code review asked for two more things, both done: deleting a member also turns the switch off with an
  audit row, and the team-wide notice now goes out when either team switch changes.
- Two tests were sharpened in the same review: the race test checks the stored row, and the shared-chat test runs the
  turn as a person who does not own the chat.
- `teamPolicyOff` also audits rows with an older risk sentence (`via: 'warning'`).
- Scheduled runs, Slack questions and drafts never use the switch. Their refusal says so.

PR: PR_LINK
