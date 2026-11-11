# "Allow all websites" covers the AI's web reads, from Settings and from the address card

- Date (UTC): 2026-11-11 00:53
- Branch: `feat/allow-all-sites-card`
- Status: draft
- Where: Team AX core (`server/src/tools/url-gate.ts`, new `server/src/tools/web-allow-all.ts`, `server/src/routes/auth.ts`,
  `server/src/routes/admin.ts`, `shared/src/api/auth.ts`, `web/src/pages/BrowserSettings.tsx`,
  `desktop/src/main/app-window.ts`). Why: web access rules and permissions are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new per-person setting, a new answer on a card, a new `Me` field and route, a migration.
  Old apps keep working.

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

After this change there is one switch, "Allow all websites", on every client. When it is on, the AI opens ordinary
public addresses without the address card, in every conversation of that person. The person can turn it on from
Settings or from the card, and turn it off in Settings.

## Decisions

### 1. One switch, one value per person on the server

- **Where the value lives.** A new table `user_web_access`, migration `339_c_web_allow_all.sql` (the next free number in
  C's range 300–399 on dev today; check it again before merge). It is additive (reader 1), with these columns:
  `user_id` (PK, cascade), `allow_all`, `warning` (the version of the warning the person accepted,
  `WEB_ALLOW_ALL_WARNING_VERSION` in shared, as dev env Full internet does), `via` (`settings` | `card`), `turn_id`,
  `updated_at`.
  - Not `users.prefs`: PATCH /api/me writes prefs freely, with no warning and no audit. A security switch gets one route
    that writes it and one function that reads it, and the policy can reset it in bulk.
- **The effective value.** `webAllowAll(db, userId)` in `tools/web-allow-all.ts` is true only when all of these hold:
  - the row is on;
  - the row's warning version is the current one;
  - the team policy `browserAllowAll` is on;
  - the person's account is active.

  The gate reads it on every call, with no cache, so a policy change works at once.
- **The route.** `PUT /api/me/web-access` takes `{ on, acceptWarning? }` and returns `{ allowAll }`.
  - Turning on needs `acceptWarning === WEB_ALLOW_ALL_WARNING_VERSION` (else 409 `web_allow_all_warning`) and the team
    policy on (else 409 `browser_allow_all_off`).
  - Turning off always works.
  - `Me.user.webAllowAll?: boolean` carries the effective value. Absent (an older server) means off.
  - A change sends `notice web_access_changed` to that person's own windows.
- **The team policy** (`browserAllowAll`, the key stays the same). When an admin turns it off:
  - `webAllowAll` is false at once, because it is read on every call;
  - the card stops offering it;
  - PUT on is refused;
  - the same PATCH turns every row off and writes one audit row per person (`web.allow_all_off`, `via: 'policy'`, the
    admin as actor). The policy hint already promises this for the desktop: "anyone who had it on goes back to asking".

  Turning the policy back on turns nobody's switch on.
- **How it relates to the desktop app's own value.** The desktop rule stays: the team server can make the in-app browser
  stricter, never wider. DECISIONS says "팀 페이지·사이트·AI는 못 바꾼다", because that browser holds the person's
  signed-in sites.
  - **Turning it on inside the desktop app.** Choosing it in Settings › Browser sets both values with one decision. The
    app shows its own window (as today, with updated text). On yes, the page PUTs on. If the PUT fails, the page puts the
    browser back to asking.
  - **Turned on somewhere else** (the card, the web app, another computer). The server value is on, but this computer's
    browser keeps asking until the person confirms in the app's window. Settings › Browser in the desktop app shows one
    line under the switch: "The in-app browser on this computer still asks for each new site", with [Allow here too],
    which opens the app's window.
  - **Turning it off anywhere.** The desktop app follows, because that makes it stricter. `fetchTeamInfo` reads
    `me.user.webAllowAll` where it reads the team policy now. When it sees the value change from true to false (the last
    value is kept in `permissions.json`), it puts the browser back to asking. It never widens because of this value.
  - **A browser set to "all" before this release** (the server value was never on) stays as it is. Settings shows "The
    in-app browser on this computer allows all websites; web pages the AI reads still ask" until the person picks the
    switch. That takes the in-page confirm only, because the browser is already "all".
  - **⚙ in the browser panel** still changes this computer's browser only.
- **Why one switch.** Two switches would mean two names in two places, and the owner prefers a lean UI.
- **Why the desktop does not follow the server value both ways.** If it did, the team page or the server could widen the
  person's signed-in browser without the app's own window. That window is the desktop's guard against the server side.

### 2. What still asks when it is on (rule ①d in url-gate)

`gateUrl` checks ①d after addresses the person typed or allowed (①) and the site allowance (①b), and before the link
budget. An address opens without a card only when all of these hold:
- someone is watching the turn (`!unattended`);
- the address has a site (a registrable domain). An IP address, a single-label name or a bare public suffix still asks,
  as in ①b, where there is nothing to allow;
- it has no long random-looking part (`opaqueParts`);
- the name before the site is shorter than `MAX_SITE_SUBDOMAIN` characters;
- it has no user name or password;
- its query is no longer than `MAX_UNCONFIRMED_QUERY` characters;
- the server knows its exit address (while it does not, every address asks);
- the chat is not confidential. Confidential chats have no web tools anyway; the check stays, as in ①b;
- it is not an echo, that is, a learned link that carried what the AI had sent. An echo always asks. A redirect to an
  echo still asks too (`redirectGuard` is unchanged);
- the flag is on for **this turn's person** (`o.userId`).

What stays the same around it:
- There is no DNS lookup before the gate says yes.
- Private, local, metadata and the server's own addresses are refused: `precheckTarget` before the gate, and the checks
  after the lookup.
- The in-app browser's office-network card stays.
- Addresses opened this way spend no link budget.
- One helper (`plainAddress`) checks the address for both ①b and ①d, so the two rules cannot drift apart.

**Runs nobody watches: not covered.** Scheduled runs, calls outside a turn and company-profile drafts keep today's
rules: the addresses their card allowed, and 8 learned links. The reasons:
- Nobody sees the steps as they happen. That is why `LINK_BUDGET.unattended` is smaller.
- The person confirmed a schedule card that listed the task's addresses. The flag could be turned on after that card,
  which would widen a confirmed task without anyone noticing.
- A run that reads team files with nobody watching is where an injected instruction does the most harm.

The refusal in a run says that "Allow all websites" does not apply to scheduled tasks. Turns asked from Slack have a
person watching (their cards wait in the app), so the flag applies there.

**Rooms and shared chats: only the caller's flag.** `gateUrl` already takes `userId` from the turn (web_fetch
`t.user.id`, the browser tools `spec.userId`). A room's AI session is the asker's own chat row (`rooms/ai.ts`), as it is
for ①b today. Another member's flag never applies.

What we accept: in a room the AI also reads other members' messages, so a member could steer it to an address. That is
the same kind of risk as a web page or a team document steering the AI in a person's own chat. The exceptions above
still stop data hidden in random strings, long names and long queries.

This needs no edits to `projects.ts`, `shared.ts` or `chat/read-rooms.ts`.

**save_url and addresses from connections: covered, for the address check only.** They use the same gate and the same
channel (a GET request).
- These save_url checks stay: the large-file card, the redirect check, the file type check, the disk check, and the room
  and wider-audience save cards.
- These are not covered at all: connection writes, the room card from `carriesAddress`, MCP tools, and the dev
  environment's network (which has its own Full internet switch).

**What it does not stop** (to record in DECISIONS). The AI can still send readable words in a path, a short name before
the site or a short query, to any site, as often as it makes calls. No budget limits that. The warning says so ("can
send what it reads to those sites"), and the team can switch the feature off.

We considered a limit on path length and left it out, for two reasons: data can be split across many short requests,
and the limit would make ordinary long article addresses ask.

### 3. The card's fourth answer

- **The answers.** Open / Allow this site in this conversation / **Allow all websites (turn off in Settings)** (value
  `all_sites`) / Don't open.
  - The text is written in English first, in `url-gate.ts` `TEXT` (server cards use server text). Then ko "모든 사이트 허용
    (설정에서 끌 수 있어요)", id, ja and es.
  - One line goes under the question, like the site line: "If you allow all websites, the AI opens public websites
    without asking in every conversation, until you turn it off in Settings › Browser. Addresses with long hard-to-read
    strings or a long query still ask."
- **When the card offers it** (`offerAll`): only when all of these hold:
  - ①d could cover this address. These are the same conditions as `offerSite`, except that it is not limited to the
    person's own chat. It is never offered on the card of an address that looks like it carries data, an echo, a long
    query, or while the exit address is unknown;
  - the person can choose (`person.choose`);
  - the team policy is on;
  - the person's flag is off;
  - the chat is not confidential.
- **When the person picks it.** This address opens. The gate reads the policy again; if it is still on, the gate sets
  the flag (`via: 'card'`, `turn_id`, the current warning version), writes the audit row and sends the notice. If an
  admin turned the policy off while the card was open, the address opens and the flag stays off.
- **Only the person can answer it.**
  - The card is `origin: 'server'`.
  - The only way to answer it is `POST /api/turns/:id/answer`, and only by the turn's owner (`ownTurn`).
  - The answer must be one of the card's own options (`TurnExec.answer` returns `not_an_option` otherwise). Typed text
    never counts.
  - The AI has no session, and its ways onto the network refuse the team server: web_fetch blocks the server's exit
    address and private addresses, the in-app browser refuses the team address, and the dev environment refuses team
    hosts (`userSiteProblem`).
  - Outside AI apps hold remote-MCP tokens, and those are not sessions.
  - The gate never reads the AI's own ask_user cards.
  - Room messages are not answers.
  - Scheduled runs raise no card (`askConfirm` returns 'unattended'). What a schedule card approved (`allowed_urls`,
    `write_connections`) is stored data, not an answer.
  - No tool and no MCP tool writes to `user_web_access`.
- **No second confirm on the card.**
  - The card already takes two actions: four answers keep the radio buttons, then [답하기].
  - It shows the full address and the line above.
  - Only the person's session can answer it.
  - The desktop app's window guards against the team page asking by itself. A second dialog drawn by the same page would
    add a click and no protection.
  - "Allow this site" works the same way.

  Settings keeps its confirm, because there the person has not seen a card.
- **How the person sees it is on, and turns it off.**
  - After the card answer is accepted, the card's window shows a toast: "All websites are allowed. Turn it off in
    Settings › Browser.", with a link. Other windows refresh on the notice.
  - Settings › Browser shows the switch and the existing badge "Allowing all sites". The badge in the desktop browser's
    toolbar stays.
  - The audit line of each address opened this way ends with "(all websites allowed)".
  - To turn it off: Settings › Browser on any client. An admin's team switch turns it off for everyone.

### 4. Settings UI

- Settings › Browser shows on every client: web, phone and desktop. The tab id stays the same.
  - Its one choice, Ask / Allow all, is the server value.
  - The desktop app also shows what only it has: the line about this computer's browser (above) and the list of
    always-allowed sites.
- **Text** (English first):
  - desc: "Web pages the AI opens for you: when it reads a page, saves a file from the web, and in the desktop app's
    browser."
  - allHint: "The AI opens any public website without asking, in every conversation, and can send what it reads to those
    sites. Addresses with long hard-to-read strings or a long query, office-network addresses and scheduled tasks still
    ask or stay blocked. Password and card fields stay off limits."
- **Turning it on.** On the web and the phone, a `confirmDialog` with the warning. In the desktop app, the app's own
  window; its `allowAll.detail` text now names web reads too.
- **Admin.** The Admin › Team settings hint for `browserAllowAll` names web reads too.

### 5. Audit

- `web.allow_all_on` records `via` (`settings` | `card`), `warningVersion`, and `turnId` for the card.
- `web.allow_all_off` records `via` (`settings` | `policy`).
- The actor is the person, or the admin for `policy`. This follows `dev_env.full_on` and `room.ai_grant`.
- Each use goes into the existing tool audit line (the full URL plus "(all websites allowed)"), not into new rows.
- Labels `audit.act.web.*` in five languages.
- There is no admin list of who has it on, as for dev env Full internet. The audit log shows it.

## Steps

1. Write the failing tests (below). Then the migration, `tools/web-allow-all.ts` and the shared contract
   (`Me.user.webAllowAll`, `setMyWebAccess`, the warning version).
2. `url-gate.ts`:
   - `plainAddress`, shared by ①b and ①d, then ①d itself;
   - `offerAll` and the `TEXT` entries in five languages;
   - `GateResult 'all'`;
   - the note in the unattended refusal;
   - the audit summaries in web_fetch and save_url.
3. Routes: PUT /api/me/web-access, the `Me` field and the notice; in the admin PATCH, the reset when the policy goes off.
4. Web: Settings › Browser on every client, the texts, the confirm, the notice handler and the toast after the card; the
   mock server.
5. Desktop: follow the value when it turns off (true to false), the line about this computer, the dialog text.
6. Docs, the changelog fragment, `bun run docs:api`. An independent security review before the PR.

## Risks

- **Security.** This widens access on purpose. Four things limit it: the exceptions, the person's warning, the team
  switch, and turns someone is watching. An independent review checks the order inside `gateUrl`: the flag must never
  cover an address that ①b does not.
- **The policy means more than before.** Teams with `browserAllowAll` on (the default) now let members allow web reads
  too. The changelog and the admin docs say so. The medical edition's "off by default" (Outbound web channels) applies
  here too when that edition resumes.
- **Migration number.** Another open branch may take 339. Check it again before merge.
- **Languages and screens.** The new text is in the five app languages: the server card, the web and the desktop
  dialog. On a phone, the card shows four radio answers.
- **Old and new apps.** An old desktop app with the new server ignores the field, and the web value still works. A new
  desktop app with an old server gets no field, and nothing changes.
- **Coordination.** No edits to `projects.ts`, `shared.ts` or `chat/read-rooms.ts`; another session is changing those on
  its own branch.

## Tests

New `tests/unit/web-allow-all.test.ts`, with the same harness and DNS stub as `site-allow.test.ts`:
- **Flag off.** The card shows, with the fourth answer when the policy is on.
- **Flag on.** No card, and no lookup before the decision, for each of:
  - an address the AI wrote;
  - a learned link over the budget (no budget spent);
  - save_url;
  - a browser tool's address.
- **Flag on, but still a card.** For each of:
  - a random-looking part;
  - a long name before the site;
  - a user name or password (browser tool);
  - a query over 200 characters;
  - an unknown exit address;
  - an echo link (from the web and from a connection);
  - a redirect to an echo;
  - an IP address or an address with no site.

  Also: a private IP literal is refused before any card, a name that resolves into the office network is refused after
  the lookup, and a confidential chat does not use the flag.
- **Team policy off.**
  - The gate ignores the flag and the card does not offer the fourth answer.
  - `Me.webAllowAll` is false, and PUT on returns 409.
  - Every row is reset and audited.
  - Turning the policy on again leaves everyone off.
- **The AI cannot answer it.**
  - The AI's own ask_user card answered with `all_sites` leaves the flag off.
  - `all_sites` on a card that did not offer it returns 400; typed text returns 400.
  - Another person's answer returns 404.
  - A remote-MCP token on PUT returns 401.
  - A wrong warning version returns 409, and a row with an old version reads as off.
- **Rooms.** Alice (flag on) asks @트리나: no card. Bob (flag off) in the same room: a card. Alice's flag is never used
  for Bob's turn.
- **Scheduled run with the flag on.** An address that did not appear is still refused, and the refusal names the rule.
  Learned links stay at 8. The run never sets the flag.
- **Answering the card.** The address opens, the flag is set, `web.allow_all_on` is audited with `via: card` and the
  `turnId`, and the notice goes out. If the policy was turned off while the card waited, the address opens and the flag
  stays off.
- **Sub-agents.** A sub-agent of the answer uses the person's flag.

Changes to existing tests:
- `a-admin.test.ts`: the reset and the notice.
- The permission matrix and `security-route-coverage`: a case for the new route.
- `web/test/unit/browser-settings.test.tsx`: the tab on the web, the confirm, the desktop lines.
- `web/test/e2e/browser-settings.spec.ts` and `safety-cards.spec.ts`: picking the fourth answer, then Settings shows it
  on.
- `e-desktop-common.test.ts`: the desktop follows the value only when it turns off.
- `desktop/e2e/settings.spec.ts`: one app window, then the PUT; a failed PUT rolls the browser back.

Checks: `bun run typecheck`, `test:unit`, `check:i18n`, `check:docs`, `docs:api` with `tests/unit/docs-site.test.ts`,
`test:web`, and the specs above.

## Docs

- **DECISIONS.md:**
  - a new section, "Allow all websites covers the AI's web reads (feat/allow-all-sites-card)";
  - a note at the end of "Outbound web channels" on ①d and what it does not stop;
  - the "남은 것" line of "앱 안 브라우저 … 모든 웹사이트 허용" points to the new section.
- **User docs:**
  - `docs/security-and-permissions.md` and `.ko.md`: the paragraph about the web;
  - `docs/site/use/settings-and-search.md`: Browser in the table of sections;
  - `docs/site/agents/runtime.md`: the "Web addresses" bullet;
  - `docs/for-admins.md` and `.ko.md`: the team switch;
  - `desktop/README.md`;
  - the generated `docs/site/reference/http-api.md`.
- **Changelog:** `changes/allow-all-sites-card.md`.

## Owner questions

None needed. There is one decision the owner may want to overrule: picking "Allow all websites" on a card does not by
itself widen the desktop app's own browser on that computer. That browser asks once in the app's window, from
Settings › Browser.

## Result

Filled in at the end.
