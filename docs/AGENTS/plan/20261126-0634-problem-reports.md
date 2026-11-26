# In-app "Report a problem": reports reach the operators as one message each in a team chat room

- Date (UTC): 2026-11-26 06:34
- Branch: `feat/problem-reports` (plan first drafted on `plan/problem-reports`)
- Status: done
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

## Review changes (2026-11-26, before the build)

An independent review of the draft and the owner's framing ("a webhook bot channel in potenlab, like 🤖 Trina Alert")
changed the plan. The owner then took both open decisions as recommended: self-installed servers send by default (the
admin switch turns it off), and the room is private (owner, developers, QA). What changed:

- Two entry points, not three: no account-menu item. No 👍.
- The sheet has one box and one tick (from 👎 only). No screenshot, no name and mail tick in v1.
- Tool steps go as tool ids only, never step labels (labels name files and items). A canary test keeps names out.
- The sender signs exactly like the Drive broker (method, path, ts, nonce, body sha256; `TrinaDriveBroker` header),
  not a new `MycelReport` header. A 404 from the intake is final (an older control plane, or the flag off there).
- The intake splits its limits: known keys (hosted, registered) a normal budget, unknown keys one small shared budget.
  Past a budget it answers 200 and only counts, so a team server never retries spam.
- Customer text is neutralised on the card (`<`, `>` and link syntax); the only link on a card is one the control
  plane builds. The text is deleted from the intake once the room took it.
- No special rule about the AI or the room: the existing guards for chats that read rooms apply.

## Scope

In:
1. **Entry points** (both open the same sheet):
   - **"문제 신고" row in Settings › About**, under the version line.
   - **👎 on a finished AI answer**, in the existing answer actions row. It opens the sheet with that answer's turn.
   - Nothing in the account menu, no desktop menu item, no 👍.
2. **The sheet:** one box "무엇이 불편했나요?" (required, up to 4000 characters); one line on who reads it:
   "Trina AX 개발팀(포텐랩)이 읽어요" (on a self-installed server also: the report leaves this server and goes to the
   Trina AX team). From 👎 only, one tick "이 답변과 질문 함께 보내기" (off) with a preview of exactly what goes: the
   person's own question and the answer, each capped. In a shared, project or side chat the tick is not offered in v1.
   Send → "받았어요". Six app languages, en.ts the source, plain 해요체 in Korean.
3. **Sent by default:** the text; the client kind, its version and OS family; the server version and run kind; the
   engine kind and version; the locale; the screen kind (a fixed word, never an id or file name); from 👎 the turn id,
   the failure code and the ids of the tools the answer used. Never names, mail, team, room or file names.
4. **Admin switch:** Admin › Settings "팀원이 문제를 신고할 수 있어요", on by default; off hides both entry points and
   the server refuses. `MYCEL_PROBLEM_REPORTS=off` removes the feature; an edition without a hosted service (no
   console host) has none.
5. **Server (core):** `POST /api/problem-reports` (signed in, CSRF) checks the switch and limits (5 a person a day, 30
   a team a day), builds the body from the allow-list (`shared/src/cloud-protocol/problem-report.ts`
   `parseProblemReport` checks it before it is stored), saves it in an outbox table and answers at once. A sender signs
   it with the relay team key (`registration.ts` `loadOrCreateKey`) and posts it to the console host's intake; backoff
   for up to 7 days, a 404 or other refusal is final; a sent report keeps only its id, time and status.
6. **Wire format** `shared/src/cloud-protocol/problem-report.ts` (MIT, imports only drive-broker.ts):
   `POST /api/problem-reports/v1/report`, strict body ≤ 32 KiB, answer `{ ok: true }` (also for a known id).

Out (later, only if asked): screenshots, attaching more of the conversation than the 👎 tick, the person's name and
mail, "고쳤어요" notices, logs.

## The receiving side (trina-cloud, built in its own PR)

- **Intake** `src/problem-reports/` on the console host, behind a cp.env flag (off = the route answers 404).
  Verifies the signature broker-style, refuses a reused nonce. Limits: hosted keys and registered servers a normal
  budget each; all unknown keys share a small one (about 50 a day); past a budget, reports fold into one counted
  thread instead of a card each. Operators can block a key.
- **Delivery:** one "Other" card per report to the potenlab `/in/<token>` URL of the room "📮 사용자 신고". The URL is
  a systemd credential (a new `LoadCredential` line), never in a repository. Customer text has `<`, `>` and link
  syntax neutralised; the only link on a card is one the control plane builds, if any. `thread` = a fingerprint of
  (server version, failure code, screen, engine), so repeats stack. `Idempotency-Key` = the report id.
- **Storage:** the report record (id, key, team, time, fingerprint, state); the text is deleted once posted.
- A migration with trina-cloud's next number; `problem-report.ts` vendored into `src/vendor/public/cloud-protocol/`
  with the contract sync.

## Steps

1. This plan update (first commit).
2. Wire format + tests.
3. Server: migration (next free number on dev), the route, the allow-list builder, the outbox and sender, the switch,
   the env, the limits.
4. Web: the sheet, 👎, the Settings › About row, the Admin switch, six languages.
5. Docs: decision file, `changes/problem-reports.md`, user doc line.
6. trina-cloud PR: intake, limits, delivery, migration, vendoring, flag.
7. Owner steps (the owner does them): the potenlab room "📮 사용자 신고" (owner, dev, QA), its "Other" room app, the
   `/in/` URL as a new `LoadCredential` line on trina-cp (Slack lines kept), the cp.env flag, a privacy-policy
   sentence. Order: CP intake live with the flag on → room → QA-server end-to-end test → core release.

## Decisions

New: `docs/decisions/20261126-problem-reports.md`. Related:
[hosted error reports](../../decisions/20261119-hosted-error-reports.md) (unchanged: reports never travel on that
channel). Owner decisions (2026-11-26): reports land in a private room of the operators' own team; entry points include
Settings; self-installed servers send by default with the admin switch.

## Risks

- Privacy: customer words reach the operators' team; the sheet says who reads it; the privacy policy gets a sentence.
- Self-installed servers: an outbound call only when a person presses Send; the admin switch is visible.
- Abuse: unknown keys share one small budget; overflow is only counted; key block.
- Migration numbers in both repositories; no intake URL, token or customer text in either repository.

## Tests

Signing, nonce replay, limits, neutralised text, the payload allow-list canary, outbox retry and 404, the admin switch,
web e2e at 1440 and 390; `bun run typecheck`, `bun run check:prepush`, related unit and security tests on Bun 1.3.12.

## Result

Built as planned in the review changes above: the sheet (Settings › About button and 👎 under an answer, six
languages), the allow-list builder and outbox sender (`server/src/system/problem-reports.ts`, migration 703), the admin
switch, `MYCEL_PROBLEM_REPORTS` / `MYCEL_PROBLEM_REPORT_URL`, the wire format (`shared/src/cloud-protocol/
problem-report.ts`) and, in trina-cloud, the intake behind `CP_PROBLEM_REPORTS` with English cards. Tests:
`tests/unit/problem-reports.test.ts`, `web/test/e2e/problem-reports.spec.ts` (1440 and 390), the permission matrix case,
and the control plane's own `tests/problem-reports.test.ts`. The room, its app, the credential and the privacy-policy
sentence are owner steps (listed in the PRs).
