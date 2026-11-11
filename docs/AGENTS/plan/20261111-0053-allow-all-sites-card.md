# "Allow all websites" covers the AI's web reads, from Settings and from the address card

- Date (UTC): 2026-11-11 00:53 (security review applied 2026-11-11)
- Branch: `feat/allow-all-sites-card`
- Status: in progress
- Where: Team AX core (`server/src/tools/url-gate.ts`, new `server/src/tools/web-allow-all.ts`, `server/src/routes/auth.ts`,
  `server/src/routes/admin.ts`, `shared/src/api/auth.ts`, `web/src/pages/BrowserSettings.tsx`,
  `desktop/src/main/app-window.ts`). Why: web access rules and permissions are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new per-person setting, a new team setting (off by default), a new answer on a card, new
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

After this change, a team whose admin allows it gets one switch, "Allow all websites". When a person turns it on, the
AI opens ordinary public addresses without the address card, in that person's own chats, within a budget. The person
can turn it on from Settings or from the card (from the third address card in a row), and turn it off in Settings.

## Security review (2026-11-11): "build after fixing the MUSTs"

Every MUST and SHOULD below is in this plan; the NITs are folded in where they belong.

- MUST 1: ①d and the card's offer only in the person's own chat (no room session, no shared chat, no chat that read
  rooms). §2.
- MUST 2: one honest risk sentence, versioned, on the card, in Settings and in the desktop app's window. §3, §4, Risks.
- SHOULD 3: ①d has its own budget, 60 per answer and 300 per chat. §2.
- SHOULD 4: the echo test is inside `plainAddress`, so echoes ask under ①b and ①d. §2 names the order.
- SHOULD 5: the policy is race-free through an epoch. §1.
- SHOULD 6 (decided): a separate team key `webAllowAll`, off by default, one indented line under the existing switch.
  `browserAllowAll` keeps its meaning. §1, §4.
- SHOULD 7: the fourth answer shows only from the third address card in one answer or in 10 minutes. §3.

## Decisions

### 1. One switch, one value per person on the server, behind its own team key

- **Team key.** A new team setting `webAllowAll` ("…also for web pages the AI opens"), **off by default** for existing
  and new teams. It is one indented line under "Members can turn on 'Allow all websites'" (`browserAllowAll`) in Admin ›
  Team settings, and it needs that switch on. `browserAllowAll` keeps its meaning: admins agreed to it for the desktop's
  own browser only. While `browserAllowAll && webAllowAll` is not on, nobody's flag works, Settings shows no server
  switch, and the card does not offer it.
- **Where the person's value lives.** A new table `user_web_access`, migration `339_c_web_allow_all.sql` (the next free
  number in C's range 300–399 on dev; check it again before merge). It is additive (reader 1), with these columns:
  `user_id` (PK, cascade), `allow_all`, `warning` (the version of the risk text the person accepted,
  `WEB_ALLOW_ALL_WARNING_VERSION` in shared), `epoch` (the policy epoch when it was turned on), `via` (`settings` |
  `card`), `turn_id`, `updated_at`. The same migration adds `chat_all_sites` for the ①d budget (§2).
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
  `web.allow_all_off` row, `via: 'warning'`) and an account deactivation (Admin › Members, `via: 'account'`).
- **The route.** `PUT /api/me/web-access` takes `{ on, acceptWarning? }` and returns `{ allowAll }`.
  - Turning on needs `acceptWarning === WEB_ALLOW_ALL_WARNING_VERSION` (else 409 `web_allow_all_warning`) and the team
    allowing it (else 409 `web_allow_all_off`). Turning off always works.
  - Not `allowWhilePasswordChange`: a person who must change the password cannot turn it on.
  - `Me.user.webAllowAll?: boolean` (effective) and `Me.team.webAllowAll?: boolean` (the team allows it). Absent (an
    older server) means off.
  - A change sends `notice web_access_changed` to that person's own windows.
- **How it relates to the desktop app's own value.** The desktop rule stays: the team server can make the in-app browser
  stricter, never wider ("팀 페이지·사이트·AI는 못 바꾼다": that browser holds the person's signed-in sites).
  - **Turning it on inside the desktop app** (team key on): one decision sets both. The app's own window (its text now
    carries the risk sentence) → on yes, the page PUTs on. If the PUT fails, the page puts the browser back to asking.
  - **Turned on somewhere else** (the card, the web app, another computer): this computer's browser keeps asking until
    the person confirms in the app's window. Settings › Browser in the desktop app shows one line under the switch, "The
    in-app browser on this computer still asks for each new site", with [Allow here too], which opens the app's window.
  - **Turning it off anywhere**: the desktop app follows, because that makes it stricter. `fetchTeamInfo` reads
    `me.user.webAllowAll` where it reads the team policy now. When it sees the value change from true to false (the last
    value is kept in `permissions.json`), it puts the browser back to asking. It never widens because of this value.
  - **A browser set to "all" before this release** (the server value was never on) stays as it is.
  - **With the team key off**, Settings › Browser in the desktop app is what it is today (this computer's browser only).
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
6. ①d: `plain`, the turn is the person's own chat (below), the person's flag is on, and the ①d budget has room: opens.
   Over the budget: a card with its own text.
7. Anything else: the card.

**Own chat only (MUST 1).** ①d and the card's fourth answer apply only when all of these hold:
- the chat is the person's own (`chats.user_id`), not a room's AI session (`room_id IS NULL`), not a shared project
  chat or one others wrote in (`sharedChat`), not a chat that read rooms (`rooms_seen`, a ✦ side chat, or a quote on
  the answer's branch: `chat/read-rooms.ts readRooms`, used as is), not confidential;
- the turn was asked from the person's own app with its steps shown live: `clientKind` web, desktop or mobile. Not a
  scheduled run, a Slack question (its cards wait in the app, but nobody sees its steps live), a company-profile draft,
  or a turn started by the server.

Why: room messages go into the prompt as `<room_context>` (`rooms/ai.ts`), and web_fetch gets no room card there
(`rooms/ai-tools.ts` `ROOM_READ_ONLY_TOOLS`, `ROOMS_SEEN_READ_ONLY_TOOLS`; `chat/turn.ts confirmRoomChange`). Member B
could make Alice's AI send Alice's folders out with no card. ①b still helps in rooms.

The check is done twice: the turn says so (`TurnPerson.allSitesHere()`, from the exec: no room, not shared, not
restricted, a live client, `readRooms` false) and `gateUrl` checks the chat row itself.

**①d budget (SHOULD 3).** At most 60 addresses per answer and 300 per chat open through ①d (`ALL_SITES_BUDGET`), counted
like `spendLinkBudget`: synchronously, the same address again in the chat is free (`chat_all_sites`). Over it, the card
asks again ("…as many addresses as Allow all websites lets it open without asking (60 per answer, 300 per
conversation). This limits how much can go out, not small secrets…").

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
  id, ja, es. The line under the question: "If you allow all websites, the AI opens public websites without asking in
  your own chats, until you turn it off in Settings › Browser." followed by the risk sentence (below).
- **Lean (SHOULD 7).** It is offered only from the **third address card in a row**: within one answer, or within 10
  minutes (like the desktop's `RepeatPromptHint`, counted per person in memory). The first two cards keep their three
  answers. And only when all of these hold: ①d could cover this address (`plain`, no long query, exit address known, not
  an echo or an over-budget card); the turn is the person's own chat (§2); the person can choose; the team allows it;
  the person's flag is off.
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
  - With the team key off, the web and phone show no Browser tab, and the desktop shows today's page.
- **Text** (English first): the description names web pages the AI reads and files it saves from the web; the "Allow all
  websites" hint says it opens public websites without asking in your own chats, within a limit, that rooms, shared
  chats and scheduled tasks still ask, that long random-looking strings and long queries still ask but that catches
  obvious tokens only, plus the risk sentence.
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
3. Server: migration, `tools/web-allow-all.ts` (flag, epoch, budget, card count), `url-gate.ts` (`plainAddress` with the
   echo, ①d, the fourth answer, texts), `chat/tools.ts turnPerson` (`allSitesHere`, the notice), routes (PUT, `Me`,
   admin PATCH with the epoch, deactivation), summaries in web_fetch and save_url.
4. Web: Settings › Browser, the admin line, the notice and the toast, i18n in five languages, the mock server.
5. Desktop: follow the value when it turns off, the window text.
6. Tests, docs, `changes/allow-all-sites-card.md`, `bun run docs:api`.

## Risks

- **What it does not stop.** With the flag on, a hidden instruction in a document, page or message the AI reads in the
  person's own chat can make it send anything it can read to any site. The exceptions catch obvious tokens only:
  `opaqueParts` is a hint, not a rule. Lowercase-only data, or data cut into pieces shorter than 20 characters, passes;
  so do readable words in a path, a short name before the site or a short query. The ①d budget (60 / 300) limits how
  much goes out, not small secrets: a key fits in one address. This is the risk the sentence names; the team key is off
  by default, and an admin decides.
- Rooms, shared chats and chats that read rooms never use the flag (MUST 1).
- **Migration number.** Another open branch may take 339. Check it again before merge.
- **Languages and screens.** The server card, the web and the desktop window, in five languages. On a phone, the card
  shows four radio answers.
- **Old and new apps.** An old desktop app with the new server ignores the field; the web value still works. A new
  desktop app with an old server gets no field; nothing changes.
- **Coordination.** No edits to `projects.ts`, `shared.ts` or `chat/read-rooms.ts` (another session's branch);
  `readRooms` is only called.

## Tests

New `tests/unit/web-allow-all.test.ts`, with the same harness and DNS stub as `site-allow.test.ts`:
- **Flag off**: the card; the fourth answer only from the third card in a row, and only with the team key on.
- **Flag on**: no card, and no lookup before the decision, for an address the AI wrote, a learned link over the link
  budget, save_url, a browser tool's address.
- **Flag on, still a card**: a random-looking part; a long name before the site; a user name or password (browser
  tool); a query over 200 characters; an unknown exit address (web_fetch and save_url only: the browser tools never pass
  `egressKnown`); an IP address or an address with no site; a confidential chat. A private IP literal is refused before
  any card; a name that resolves into the office network is refused after the lookup.
- **Own chat only**: with the flag on, a room's AI session, a shared project chat, and the person's own chat after a room
  read still get a card, and the card has no fourth answer there.
- **Echo**: refused (a card) under ①b and under ①d.
- **Budget**: over 60 in one answer, a card appears.
- **Risk text**: the card's text holds `WEB_ALLOW_ALL_RISK` for its language, and the stored warning version is
  `WEB_ALLOW_ALL_WARNING_VERSION`.
- **Team key**: off → the fourth answer and the Settings switch are not offered (`Me.team.webAllowAll` false), PUT on is
  409, the gate ignores a row. Policy off → PUT → policy on leaves everyone off (epoch); the reset is audited.
- **Only the person**: the AI's own ask_user card answered `all_sites`, typed text, or another person's answer cannot set
  it; PATCH /api/me with `prefs.webAllowAll` leaves it off; a person who must change the password cannot PUT; a wrong
  warning version is 409.
- **Scheduled run** with the flag on: an address that did not appear is still refused; the run never sets the flag.
- **Implicit off**: a stale warning version reads as off and is audited once; deactivating an account is audited.
- **Card answer**: opens the address, sets the flag, audits `web.allow_all_on` via card with the turn id, sends the notice.

Elsewhere: the permission matrix and `security-route-coverage` (the new route), `a-admin.test.ts` (the new key is off by
default and admin-only), `web/test/unit/browser-settings.test.tsx` (the tab follows the team key, the confirm, the
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

None. The team key is off by default (decided in the review).

## Result

Filled in at the end.
