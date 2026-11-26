# In-app "Report a problem": reports reach the operators as one message each in a team chat room

- Date (UTC): 2026-11-26 06:34
- Branch: `plan/problem-reports` (plan only; the build branch will be `feat/problem-reports`)
- Status: draft
- Where: core (`web/` report sheet and entry points, `server/` sender and outbox, `shared/src/cloud-protocol/` the
  wire format, MIT) plus the hosting service's private control plane (intake and delivery). Why: the sheet, the
  allow-list and the signed sender are generic and must be readable by anyone; the intake address, its posting
  credential and the receiving room belong to the hosting service's private setup (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new feature: a new sheet, a new team setting and a new outbound call, all off where the
  edition names no intake.

## Goal

The owner asked: "사용자가 불편 신고 하면 우리에게 이슈가 쌓이거나 하게 할 수 없나?", then decided: "신고하면 우리
potenlab trina ax로 채널 하나 파서 거기서 받게 하자" and "세팅 페이지에도 넣긴 해야할 듯".

A person who hits a problem writes a few words in the app and taps Send. The Trina team reads every report as one
message in a room of its own team ("📮 사용자 신고") and triages it there, the way it already reads alerts in
"🤖 Trina Alert". The person sees "받았어요" at once. Nothing from a team's content leaves the team's server unless the
person ticks it for this one report.

## What exists today (checked on dev 23b2e7bff, 2026-11-26)

- **No feedback path anywhere.** No thumbs, "report a problem", "send feedback" or `/bug` in `web/`, `desktop/`,
  `mobile/` or `server/`. The engines' own feedback is switched off (`server/src/engine/codex.ts`:
  `feedback.enabled=false`; `SendFeedback` is in the Claude Code tool deny list in `server/src/engine/claude.ts`).
  The only ways to reach us are the plan's `links.support` (mail or URL, Admin › System, hosted only) and
  `contact@` for source requests.
- **Error reports (no words, no consent):** `server/src/system/error-reports.ts`
  ([decision](../../decisions/20261119-hosted-error-reports.md)) sends crashes and failed or stalled answers to Sentry
  when the operator sets `MYCEL_ERROR_REPORT_URL`; hosted servers only, an allow-list of codes, never text. A problem
  report is the opposite case (the person's own words, by their choice) and must not reuse that channel's promise.
- **Signed calls to the hosting service:** every team server has an Ed25519 relay team key
  (`<data>/relay/team-key.pem`, present even when the relay is off). The push gateway accepts any key on first use
  with per-key limits and an operator block (`shared/src/cloud-protocol/push-gateway.ts`); the Drive sign-in broker on
  the console host accepts hosted teams' enrolled keys and self-registered servers
  (`shared/src/cloud-protocol/drive-broker.ts`). The same key and signing scheme serve a report.
- **Posting into a room from outside:** room apps of kind "Other" take `POST /in/<token>` with JSON
  `{ title, text, link, thread }` and an `Idempotency-Key` header (`server/src/rooms/apps/inbound.ts`, `parse.ts`
  `other()`): the token is the auth, at most 256 KiB, a burst then 1 a second, 5000 a day; one thread per `thread`
  value; a retry with the same key posts once. **No files**: an incoming app posts a card (title, three detail lines,
  the full text, one https link). The hosting service's Sentry bridge already posts to "🤖 Trina Alert" this way.
- **Clients:** the desktop and phone apps show the team's own web app, so one web sheet serves all three. Version and
  client helpers exist (`clientKind()`, `mobileApp()`, `desktop()`, Settings › About shows app and server versions in
  `web/src/pages/Settings.tsx` `About`). Answers have a turn id (`shared/src/api/chats.ts`). Answer actions live in
  `web/src/components/chat/Messages.tsx` (`answer-actions`); the account menu is `web/src/components/nav/AccountMenu.tsx`.

## How others do it (checked 2026-11-26 where linked; the rest from the products as we know them)

| Product | Entry | Sent by default | Opt-in / note |
|---|---|---|---|
| Claude apps | 👍/👎 under each answer, comment box | the whole rated conversation, kept up to 5 years, de-linked from the account ([privacy.claude.com](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data)) | team admins can turn rating off |
| Claude Code | `/bug`, `/feedback` | description + environment | transcript only after a yes; `DISABLE_BUG_COMMAND` turns it off |
| ChatGPT | 👎 under an answer, "Report" for policy | the rated conversation | — |
| Slack | Help › Send feedback, `/feedback` | text + app version, platform | — |
| Linear, Notion | Help menu › Contact / Send feedback | text + app version, page | attach a file by hand |
| Sentry User Feedback | widget | text, page URL, tags; optional screenshot, email, replay ([docs](https://docs.sentry.io/product/user-feedback/)) | included on every plan |

What we take: an answer-level button (Claude, ChatGPT) and a menu item (Slack, Linear) open one small sheet; versions
and ids by default (Slack); content only after an explicit tick for this report (Claude Code); an admin switch
(Claude's team setting). What we do not take: sending the conversation by default (Claude, ChatGPT), thumbs up.

## Scope

In:
1. One report sheet, three entry points (all open the same sheet):
   - **👎 on a finished AI answer**, in the existing answer actions row (hover on a computer like the other icons, the
     long-press sheet on a phone). It opens the sheet with that answer's turn attached. No 👍: it gives us nothing to
     act on and adds a button.
   - **"문제 신고" in the account menu** (above Settings), for anything that is not one answer.
   - **"문제 신고" row in Settings › About**, under the version lines (where people look when something is wrong, and
     on a phone the 나 tab reaches it).
   - Desktop app menu: none. The account menu is one click away inside the window; a new Help menu for one item is not
     lean. Phone: the same web sheet (bottom sheet at phone width).
2. **The sheet:** one text box (required, 10–4000 characters), and under "함께 보내기 (선택)" three ticks, all off:
   "이 답변과 질문" (only from 👎), "화면 사진" (pick or paste an image; the desktop app offers a capture of the window
   with a preview), "내 이름과 메일 (답장받기)". A line above Send says exactly who sees it:
   "트리나 팀이 읽어요. 체크한 것만 함께 가요. 대화·파일 내용은 체크하지 않으면 보내지 않아요." Send → toast "받았어요".
   Every tick shows a preview of what goes before Send. Five app languages.
3. **Sent by default** (no content): the text; the client (web / desktop / phone, its version, OS family, browser
   family, never the full user agent); the server version and how it runs (hosted, selfhost, office); the locale; the
   page kind (`chat`, `room`, `files`, `settings`… a route name, never an id or a file name); from 👎 also the turn id,
   engine, model and the answer's reason code and duration (the same codes error reports may send); a report id
   (UUIDv7, made on the server); the person as the stand-in `u_<HMAC>` of the error reports.
4. **Opt-in only, per report:** the turn's question and answer as text (capped at 20 000 characters, only from a chat
   the person can read; tool steps by name only, never file contents or tool output); one image (PNG, JPEG or WebP,
   at most 2 MiB); the person's display name and email. **No logs** in the first version: the default codes cover
   what the error reports already know, and server logs hold names.
5. **Admin switch:** Admin › Settings "팀원이 문제를 신고할 수 있어요", on by default. Off hides all three entry points
   and the server refuses. An operator can remove the feature with `MYCEL_PROBLEM_REPORTS=off` in the environment, and
   an edition that names no intake (the neutral core) has no entry points at all.
6. **Server side (core):** `POST /api/problem-reports` (signed-in, CSRF) checks the switch and limits (5 a person a
   day, 30 a team a day), builds the payload from the allow-list, saves it in an outbox table and answers at once.
   A sender signs it with the relay team key and posts it to the edition's intake; it retries with backoff for 7 days
   (same report id, so a retry posts once), then drops it. Offline: the person still sees "받았어요" ("보낼게요" while
   the outbox has not sent it is not worth a second state). A sent report keeps only its id, time and status; the text
   and attachments are deleted from the outbox once the intake took them.
7. **Wire format** `shared/src/cloud-protocol/problem-report.ts` (MIT, no imports, like push-gateway.ts): `POST
   /v1/problem-reports`, strict JSON body (≤ 64 KiB without the image), image as a second request
   `PUT /v1/problem-reports/<id>/image` (≤ 2 MiB), header `Authorization: MycelReport key=…, ts=…, sig=…` (Ed25519
   over ts + sha256 of the body, ±5 min). No query strings, no names or ids other than the report id in a path.
   Contract vectors next to the existing ones.

Out (later, only if asked):
- "고쳤어요 (0.x.y)": the operators mark a report fixed with a version; the team server asks the intake once a day for
  its open reports' status and, once it runs that version, puts one quiet inbox notice to the reporter. Planned as
  phase 2 below, not built now.
- Logs, screen recordings, a report from a desktop or phone app that cannot reach its team server, thumbs up.

## The receiving side (hosting service, private control plane; summarized here, built there)

- **Intake:** on the control plane's console host (it already verifies team keys for the Drive broker, has a DB,
  rate limits and sealed storage). Not the update feed host: it serves static files only.
  - Who: a hosted team's enrolled key is known by team; any other key is accepted on first use (like the push
    gateway) and labeled "직접 설치 · <first 8 of key id>", with the self-registered address when the broker knows it.
    The operators can block a key.
  - Limits: per key 10 a minute, 60 a day (hosted) or 20 a day (unknown key); per client IP 100 a day; total 1000 a
    day; body and image caps above; refusals are 429/413 with no body echo. Same report id = 200, nothing posted.
  - Stores: the report record (id, key id, team, time, fingerprint, delivery state) 90 days; the text only until the
    room took it; the image sealed with the control plane's data key, 30 days, then deleted.
- **Delivery to the room:** one "Other" room app in the operators' own team, in the room **"📮 사용자 신고"**. Its
  `/in/<token>` address is a credential of the control plane (a systemd credential file like its other keys), never in
  either repository. One report = one card:
  - title: `[호스팅 · <team>] <first line of the text>` or `[직접 설치 · <key id>] …`
  - details: `서버 0.19.0 (hosted) · 데스크톱 0.19.0 macOS · Claude Code / <model>`; `답변 <turn id> · 이유 stalled ·
    42초` (from 👎); `보낸 사람: <name, mail>` only when ticked, else `보낸 사람: u_3f2a…`
  - text: the person's words, then the ticked question and answer under a "함께 보낸 대화" line
  - link: the report's page on the operators' console (operator login) when an image came; the image is never put in
    the room (an incoming app takes no files, and it keeps customer screenshots out of a team server's files, backups
    and AI reads)
  - thread: `fp-<8 hex>`, a hash of (server version, reason code, page kind, engine) when the report has a reason code,
    so repeats of one failure stack as replies in one thread ("같은 문제 3번째"); a free-text report without a code
    gets its own card. `Idempotency-Key` = the report id.
- **Triage in the room:** read, reply in the thread, ✅ when handled. A real bug gets an issue in the **private**
  core repository with the report id and a description written by the person triaging, never the customer's text or
  image. Nothing goes to the public repository.
- Cost: none. The control plane VM, its DB and the room exist; no Sentry or other paid service is added.

## Steps

1. Wire format and vectors: `shared/src/cloud-protocol/problem-report.ts` + tests.
2. Server: migration for the outbox (take the next free number in the server's series on dev at build time), the
   route, the allow-list builder, the signed sender with retry, the team switch, the operator env, the per-person and
   per-team limits. Strings from i18n only.
3. Web: the shared sheet (`components/report/ProblemReportSheet.tsx`), 👎 in the answer actions, the account menu
   item, the Settings › About row, Admin › Settings switch, the desktop capture through the existing preload bridge.
   Five languages.
4. Docs: a decision file `docs/decisions/<date>-problem-reports.md` (the allow-list, who sees it, no logs, the switch);
   a `docs/ASKS.md` entry if the reviewer counts the sheet's ticks as an ask (it is a form the person opens, not an
   ask the app raises: say so there); a user doc page; `changes/problem-reports.md`.
5. Control plane (separate PR in its repository): the intake, its limits and storage, the room-app delivery, the
   console page for a report with an image, the edition's intake address in the service hosts.
6. **Owner step (not done by any agent without the owner's OK):** in the operators' own team, create the room
   "📮 사용자 신고", add its members, add the "Other" room app and hand its address to the control plane's
   credentials. Then a test report from the QA server end to end.
7. Phase 2 (later): fixed-in status and the reporter's notice.

## Decisions

New: `docs/decisions/<YYYYMMDD>-problem-reports.md` written with the build PR. Related:
[hosted error reports](../../decisions/20261119-hosted-error-reports.md) (unchanged: reports never travel on that
channel). Owner decisions already taken (2026-11-26): reports land in a room of the operators' own team; entry points
include Settings.

Open, for the owner (each with a recommendation):
1. **Images:** keep them on the operators' console behind a link (recommended: no core change, customer screenshots
   stay out of a team server's files and AI) or post them into the room as files (needs a new "file with an incoming
   app" feature in the core).
2. **Self-installed servers:** send to us by default when the edition is Trina, with the admin switch to turn it off
   (recommended: they are the teams we hear least from; the person still decides each report) or hosted teams only
   at first.
3. **Who is in "📮 사용자 신고":** the owner and the developers who fix and QA (recommended; a private room, not the
   whole team, because it holds customers' words) or the whole team.

## Risks

- Privacy: customer words reach the operators' team server and its AI can read that room. The sheet says "트리나 팀이
  읽어요"; the hosting service's privacy policy needs one sentence (its wording, not in this repository).
- Self-installed servers: some admins will not expect any outbound call. The call happens only when a person presses
  Send, the admin switch is visible in Admin › Settings, and Admin › System says where reports go while it is on.
- Abuse: first-use keys can be made freely; per-IP and total caps plus the key block cover spam; the room app's own
  day cap is the last stop.
- Migration number collisions (check `server/migrations/` on dev before adding). The public repository: no intake
  token, room address or customer content in code, tests or plans.
- Phone width, dark mode, five languages, the Korean literal rule (no Korean in server code).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`; unit tests for the
allow-list (canaries: names, file names, message text never in a body unless ticked), the signer against vectors,
limits, the switch and the env, the outbox retry and the delete after send; web unit tests for the sheet and the three
entry points; a web e2e that sends a report to a mock intake at 1440 and 390 px; the control plane's own tests for
intake limits and the room card.

## Result

Filled in at the end.
