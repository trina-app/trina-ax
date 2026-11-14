# Apps in rooms, part 2: more services, JANDI-shaped messages and email in

- Date (UTC): 2026-11-14
- Branch: `plan/room-apps-presets` (this plan, no PR). Build branches per phase below.
- Builds on: "Apps posting in rooms" on dev (#826 server, #835 web; plan
  [20261114-0900-room-apps.md](20261114-0900-room-apps.md)) and the open UI fix `fix/room-apps-settings-logos`
  (real logos, a naming step, plain wording, picker order Google Forms → Other → GitHub → Sentry, an example preview in
  the dialog, one waiting pattern, "How to connect" for every kind, unsigned actor names no longer marked on cards). This
  plan assumes that fix is merged first and changes nothing it decided.
- QA: **TC-1634** (Other reads JANDI + new presets, phases 1 and 4), **TC-1635** (email in, phases 2 and 3).
- 넣을 곳: Team AX core (`server/src/rooms/apps/*`, `server/src/routes/room-apps.ts`, `server/migrations/40x_b_*.sql`,
  `shared/src/api/room-apps.ts`, `shared/src/cloud-protocol/mail-in.ts` new (MIT), `web/src/components/rooms/apps/*`,
  `web/public/icons/room-apps/*`, `web/src/i18n/*`, `docs/features.ts`, `tests/*`). The mail gateway (Cloudflare Email
  Worker, the sealed queue and the mailbox) lives in the private hosting repository, as the Slack broker does.
  이유: the inbound endpoint, rooms and the cards are core (docs/REPOSITORY-RULES.md); the shared mail contract is
  MIT like the other cloud-protocol files.
- Version impact: **minor** each phase (new presets, optional API fields, add-only migrations).

## Owner decisions this plan follows (2026-11-14)

1. **Audience: office teams worldwide, English first.** No service is chosen for one country's market. Korean stays a
   shipped language (the guides have Korean steps), not the reason a service is in or out.
2. **Order:** P1 = "Other app" also reads Slack, Discord and **JANDI** messages + global presets with logos (Notion
   automations, the forms group Typeform/Tally/Jotform, Stripe, Shopify, Zendesk). P2 = email in for hosted teams.
   P3 = email in for self-installed servers through the encrypted cloud mailbox. P4 = Jira automation template,
   HubSpot (paid tier), guided Zapier/Make templates, then a **regional group** (Toss Payments, Channel Talk,
   PortOne) at lower priority. Calendly and Intercom are skipped (API or developer app only; see "Skipped").
3. **Words: Slack's own terms in English.** "Add an app"; the room's details have an **Integrations** tab with
   **Apps**; the **APP** badge on messages; **Webhook URL** with **Copy** and **Regenerate**. Korean is secondary
   ("앱 추가", 연동 › 앱, "앱" badge, "웹훅 URL", "복사", "다시 만들기"). This replaces part 1's "Address / Copy address /
   Get a new address" and its "never say webhook" rule: the i18n test that banned "webhook" is changed to require the
   Slack terms instead (phase 1 does it, see "Words").
4. **Signatures are optional for every service.** A service that can sign gets an optional "Signing secret" field
   (or a secret Trina makes); once one is saved, unsigned or wrong requests are refused. Unsigned actor names are not
   marked on cards (the UX fix). The token in the Webhook URL is the baseline.

## Goals

1. A non-developer adds Notion, Typeform, Tally, Jotform, Stripe, Shopify or Zendesk to a room in about two minutes:
   Room ⋯ → **Add an app** → pick the service → **Copy** the Webhook URL → follow 3-5 numbered steps written with the
   service's own screen labels → the first card appears.
2. Any tool that can post to a **Slack, Discord or JANDI** incoming webhook can post to Trina by pasting the Trina
   Webhook URL there instead. The Other guide says so in one line.
3. **Email in:** each email app has its own address; anything forwarded there (shop orders, form notices, monitoring
   mails, a supplier's invoices) becomes a card with subject, sender and the first lines, attachments in the room's
   files. Works for hosted teams (P2) and self-installed servers, with or without a public address (P3).
4. Nothing new in what a room can be made to do: every new source is still a card from an app, never a person; no
   mentions, no buttons that act elsewhere, no outbound requests, the same caps and switches.

## Not in this plan

- OAuth/marketplace installs (a "Trina" app in Stripe's, Shopify's or Notion's directory). Every preset here works by
  pasting a Webhook URL or forwarding mail.
- Replying by email from a room, or Trina sending any mail. The mail domain only receives.
- Reading a mailbox (IMAP, Gmail API). People forward; Trina never logs in to their mail.
- Calendly and Intercom (see "Skipped").

## Words

| thing | English (source) | Korean |
|---|---|---|
| room menu item | Add an app | 앱 추가 |
| room details tab / section | Integrations › Apps | 연동 › 앱 |
| badge after the sender name | APP | 앱 |
| the secret URL | Webhook URL · Copy · Regenerate | 웹훅 URL · 복사 · 다시 만들기 |
| the email app's address | Email address · Copy · Regenerate | 이메일 주소 · 복사 · 다시 만들기 |
| optional signing | Signing secret (optional) | 서명 시크릿 (선택) |
| the catch-all | Other app | 기타 앱 |

- `web/src/i18n/en.ts` is the source; ko, id, ja, es follow. Vendor screen labels stay in `roomApps.vendorLabel.*`
  per locale, spelled as the vendor shows them in that language (English where the vendor has no translation).
- `tests/unit/*room-apps*i18n*`: the "no webhook" check flips to "the room-apps strings use Webhook URL / Copy /
  Regenerate"; everything else in the app still avoids "webhook" (the rule stays outside this sheet).
- Regenerate replaces part 1's "Get a new address" (same API `rotateRoomApp`; the confirm keeps its words: "The old
  URL stops working at once. Paste the new one into {app}.").

## UX

Shared components only (memory: shared UI components first): the picker row, the guide layout, the card and the
status line are part 1's, with the logo tile from the UX fix. 1440 dialog, 390 sheet, 44 px targets. Every vendor
step is checked against the live service with screenshots before its copy is final (TC-1634).

### Picker with groups

Groups are headings in one list, not tabs; no search box (19 rows at most). The order keeps the UX fix's
"Google Forms → Other → GitHub → Sentry" and slots the new services in by what office teams use most.

```
 1440 dialog (480 wide)                              390 sheet
 ┌──────────────────────────────────────────┐       ┌──────────────────────────────────┐
 │ Add an app                             ✕ │       │ Add an app                    ✕  │
 │ Its messages appear in #sales for        │       │ Its messages appear in #sales    │
 │ everyone in the room.                    │       │ for everyone in the room.        │
 │ FORMS                                    │       │ FORMS                            │
 │ [logo] Google Forms                   ›  │       │ [logo] Google Forms           ›  │
 │ [logo] Typeform                       ›  │       │ [logo] Typeform               ›  │
 │ [logo] Tally                          ›  │       │ [logo] Tally                  ›  │
 │ [logo] Jotform                        ›  │       │ [logo] Jotform                ›  │
 │ WORK                                     │       │ WORK                             │
 │ [logo] Notion   Database automations  ›  │       │ [logo] Notion                 ›  │
 │ [logo] Zendesk  New and updated tickets› │       │ [logo] Zendesk                ›  │
 │ [ ✉ ] Email     Forward mail here     ›  │  P2   │ [ ✉ ] Email                   ›  │
 │ SALES                                    │       │ SALES                            │
 │ [logo] Stripe   Payments and refunds  ›  │       │ [logo] Stripe                 ›  │
 │ [logo] Shopify  Orders                ›  │       │ [logo] Shopify                ›  │
 │ FOR DEVELOPERS                           │       │ FOR DEVELOPERS                   │
 │ [logo] GitHub                         ›  │       │ [logo] GitHub                 ›  │
 │ [logo] Sentry                         ›  │       │ [logo] Sentry                 ›  │
 │ ──────────────                           │       │ ──────────────                   │
 │ [ ⋯ ] Other app                       ›  │       │ [ ⋯ ] Other app               ›  │
 │       Slack, Discord or JANDI webhooks,  │       │       Slack, Discord or JANDI    │
 │       Zapier, Make, anything else        │       │       webhooks, Zapier, Make     │
 └──────────────────────────────────────────┘       └──────────────────────────────────┘
```

- **Other app moves to the end, after a divider**, as Slack's "browse all" sits last: once there are named services,
  the catch-all is the way out, not the second choice. (Changes the UX fix's order for one row; owner confirmation 1.)
- P4 adds Jira and HubSpot under WORK; the regional group (Toss Payments, Channel Talk, PortOne) shows under
  "MORE SERVICES", collapsed behind one "Show more services" row before Other, so the default list stays short. No
  language or country logic: everyone sees the same list.
- A pick still creates nothing until the first Copy (part 1).

### Guide per preset (same layout as the UX fix's "How to connect")

```
 1440 (Stripe)                                       390
 ┌──────────────────────────────────────────┐       ┌──────────────────────────────────┐
 │ ‹  Connect Stripe                      ✕ │       │ ‹  Connect Stripe             ✕  │
 │ Name  [ Stripe                      ]    │       │ Name [ Stripe                 ]  │
 │ Webhook URL                              │       │ Webhook URL                      │
 │ [ https://acme.trina.app/in/…  ] [Copy]  │       │ [ https://acme.trina.app/in/… ]  │
 │ Anyone with this URL can post here.      │       │ [            Copy            ]   │
 │ ① In Stripe, open Workbench › Webhooks   │       │ ① … [screenshot]                 │
 │   and choose "Create an event            │       │ ② …                              │
 │   destination".          [screenshot]    │       │ ③ …                              │
 │ ② Pick the events below, then "Webhook   │       │ ▸ Signing secret (optional)      │
 │   endpoint". Paste the URL into          │       │ What it posts: [card preview]    │
 │   "Endpoint URL".                        │       │ ○ Waiting for the first payment… │
 │ ③ Save.                                  │       │ [ Done ]                         │
 │ ▸ Signing secret (optional)              │       └──────────────────────────────────┘
 │   Paste the "Signing secret" from        │
 │   "Reveal secret": [ whsec_…  ] [Save]   │
 │ What it posts  [example card preview]    │
 │ ○ Waiting for the first payment…         │
 │                                 [ Done ] │
 └──────────────────────────────────────────┘
```

- The events to tick in the vendor are listed as chips under step ② (the same keys as Trina's switches that are on).
- **Template presets** (Zendesk, Jira, Notion's property pick, Zapier/Make): the guide has a second copy button,
  **Copy body**, with a ready JSON body that already has the vendor's placeholders, so nobody writes JSON.
- "Signing secret (optional)" is collapsed; it opens on the services that can sign (table below).

### Cards per preset (short form; full field map in "Presets")

```
 [Stripe logo] Stripe  APP  10:42
 ┌──────────────────────────────────────────┐
 │ Payment received · Test mode             │   kind line (Test mode only when livemode=false)
 │ $49.00 from Jamie Rivera                 │   title
 │ Pro plan (monthly)                       │   details (≤ 3)
 │ Status: Succeeded · dashboard.stripe.com │   status line + link host
 └──────────────────────────────────────────┘
   2 replies · Refunded $49.00                  thread (refund joins its payment)
```

```
 [ ✉ ] Orders mail  APP  09:15                     (P2: email app)
 ┌──────────────────────────────────────────┐
 │ Email · from orders@shop.example         │   kind line: the real From address, always shown
 │ [New order] #20261114-001 · 2 items      │   title: Subject
 │ Order date: 2026-11-14 09:14             │   details: first 3 meaningful lines
 │ Total: 45,000                            │
 │ 📎 invoice.pdf · 120 KB                  │   attachments: room files on this message
 └──────────────────────────────────────────┘
   Show the whole mail ›                         opens the plain text in the thread panel
```

### Email address row (P2)

```
 Integrations › Apps › Orders mail
 ┌──────────────────────────────────────────┐
 │ Email address                            │
 │ [ r7k2…q4m@mail.<domain>      ] [Copy]   │
 │ Forward mail here and it appears in this │
 │ room. Anyone who knows it can send here. │
 │ Regenerate                               │
 │ Only accept mail from (optional)         │
 │ [ orders@shop.example ×] [+ Add]         │
 │ ✓ Last mail 09:15 · 12 today             │
 └──────────────────────────────────────────┘
```

- The first time a mail arrives the row offers one tap: "Only accept mail from orders@shop.example?" (off by default,
  owner confirmation 3). A sender on the list must also pass DMARC for its domain (below), so a forged From is not
  enough.
- Guide (3 steps): ① Copy the email address. ② In Gmail: Settings › See all settings › Forwarding and POP/IMAP › Add
  a forwarding address (or a filter's "Forward it to") — "Gmail sends a confirmation mail here; it appears in this room
  in a minute. Open its link." ③ Done. Outlook/Microsoft 365: "Your admin may need to allow forwarding outside the
  company" (Microsoft blocks it by default). A shop or form that can send its notices to any address: paste the email
  address there directly.

## Presets

One file per preset under `server/src/rooms/apps/presets/<preset>.ts`, each exporting
`{ preset, types, bodyMax, switches, signature?, parse(arrival), samples }`. `parse.ts` keeps the four part-1 kinds
and dispatches `kind='other' + preset` to these. Each preset ships its vendor sample payloads under
`tests/fixtures/room-apps/<preset>/*.json` (copied from the vendor docs, names and amounts replaced with fake ones)
and a test per sample: card fields, thread key, delivery key, switch, a signature good/bad/missing, a body with
unknown extra fields, a body with each used field missing or of the wrong type (→ skip or 400, never a crash).

Signature schemes (all optional; a saved secret makes them required; constant-time; over the **raw bytes** unless
the vendor says otherwise). `server/src/rooms/apps/signatures.ts` replaces `inbound.ts signatureOk`:

| scheme | header | computed | used by |
|---|---|---|---|
| `hex-body` | X-Hub-Signature-256 `sha256=<hex>` / Sentry-Hook-Signature `<hex>` | HMAC-SHA256(secret, raw) hex | GitHub, Sentry (part 1) |
| `b64-body` | Typeform-Signature `sha256=<b64>`; X-Shopify-Hmac-SHA256 `<b64>` | HMAC-SHA256(secret, raw) base64 | Typeform, Shopify |
| `b64-json` | Tally-Signature `<b64>` | HMAC-SHA256(secret, `JSON.stringify(JSON.parse(raw))`) base64; raw bytes tried first | Tally |
| `stripe` | Stripe-Signature `t=…,v1=…[,v1=…]` | HMAC-SHA256(secret, `t + "." + raw`) hex, any v1 matches, \|now − t\| ≤ 5 min (now = the receive time, the mailbox's time in P3) | Stripe |
| `zendesk` | X-Zendesk-Webhook-Signature `<b64>` + X-Zendesk-Webhook-Signature-Timestamp | HMAC-SHA256(secret, timestamp + raw) base64, timestamp ≤ 5 min old | Zendesk |
| `toss` | tosspayments-webhook-signature `v1:<b64>[,v1:…]` + tosspayments-webhook-transmission-time | HMAC-SHA256(secret, raw + ":" + time) base64 | Toss Payments (regional) |
| `standard` | webhook-id, webhook-timestamp, webhook-signature `v1,<b64>` | Standard Webhooks: HMAC-SHA256(base64-decoded secret after `whsec_`, `id.timestamp.raw`) | PortOne V2 (regional) |
| `url-token` | `?token=` on the URL | the saved token equals the query value | Channel Talk (regional) |

Who makes the secret: **Trina makes it** where the vendor has a field to paste one in (Tally "Add a signing secret";
Typeform only if its UI has the field, live check), else **the person pastes the vendor's** (Stripe "Reveal secret",
Zendesk "Reveal secret", Shopify's key on the Webhooks page, Toss's key, PortOne's `whsec_`). Each pasted secret has
a shape check (`whsec_` + base64 for Stripe and PortOne; others: 16-200 printable characters) with a plain error
("That doesn't look like Stripe's signing secret.").

`/in/` change for `url-token`: `loggablePath` already strips the token path; it must also drop the **query string**
on `/in/` before logging (Channel Talk puts its token there). Phase 1 does it for every `/in/` request.

### P1: Other app reads JANDI too

JANDI's incoming webhook body: `body` (required, `[text](url)` links), `connectColor` (hex), `connectInfo`
[{`title`, `description`, `imageUrl`}]; sent with `Accept: application/vnd.tosslab.jandi-v2+json` and
`Content-Type: application/json`; JANDI's own limit 256 KB, shows up to 5,000 characters
(https://support.jandi.com/en/articles/connect-incoming-webhook-21bc249f).

- `other()` in `parse.ts`: when `text` and `content` are absent and `body` is a string → JANDI. `[label](https://…)`
  becomes text + the first https link (the same "a label that looks like another address shows the real address" rule
  as Slack's `<url|label>`). `connectInfo` (≤ 10 read): each item → a detail line "title: description" (first 3 on
  the card, all in the plain text). `imageUrl` is **never fetched** and not shown (no SSRF, no tracking pixel).
  `connectColor` ignored.
- The `Accept` header is ignored; any `Accept` is fine. Answer stays `200 ok`.
- Order of reading in `other()`: `text` (Slack) → `content` (Discord) → `body` (JANDI) → Block Kit/attachments text →
  plain text. One body with several of these: the first wins.
- Other guide, one line under the URL: **"Paste this where an app asks for a Slack, Discord or JANDI webhook URL."**
  (ko: "Slack, Discord, 잔디 웹훅 URL을 넣는 곳에 붙여 넣으세요.") Plus the "Use with Zapier or Make" how-to (P4).
- Samples: JANDI's documented example; one with three `connectInfo`; one with a markdown link whose label is a
  different host; a 300 KB body (413).

### P1: Notion (database automations "Send webhook")

Facts (https://www.notion.com/help/webhook-actions): paid Notion plans only; a database automation's action **Send
webhook**; POST only; up to 5 webhook actions per automation; the person **selects which properties** to send (page
properties only, never page content); optional custom headers; **no signature**; failures pause the automation until
someone resumes it. The envelope (page id, automation id, attempt) is documented only by third parties: live check.

| item | value |
|---|---|
| switches | `page_added` on, `page_changed` on (Notion's triggers "Page added" / "Property edited"; the body can't say which, so one switch `entry` unless the live check finds a field) |
| card | kind "Notion · {database name if sent}"; title = the title property's text; details = up to 3 selected properties "Name: value" (select/status names, dates as local date, people as names, numbers as is, checkboxes ✓/–, relations as count); status line = a property named Status/상태 when present; link = the page URL when sent (`notion.so` / `notion.site` hosts only) |
| thread key | `page:<page id>` (a later automation run on the same page goes to its thread and edits the status line) |
| dedupe | the envelope's id + attempt when present, else sha256(raw) within 10 minutes |
| signature | none (Notion doesn't sign); token only |
| robustness | property values come in Notion's typed shapes: each type read by a small table, unknown types → their plain text or skipped; ≤ 25 properties read |
| content types | application/json |
| guide (en) | ① In Notion, open the database, choose ⚡ (Automations) › New automation. ② Pick a trigger, e.g. "Page added". ③ Add action › **Send webhook**; paste the URL; under properties tick what the room should see. ④ Create. |
| guide (ko) | ① Notion에서 데이터베이스를 열고 ⚡(자동화) › 새 자동화. ② 트리거 선택(예: "페이지 추가됨"). ③ 작업 추가 › **웹훅 보내기**; URL 붙여 넣기, 방에 보일 속성 선택. ④ 만들기. (Korean labels: live check) |
| live check | the envelope and property shapes (send to webhook.site first), the Korean labels, which plans show the action, whether a "Test" button exists |

### P1: Forms group — Typeform, Tally, Jotform

All three: one switch `response` (on); card kind "New response · {form}", title = the first answer "Question:
answer", details = next 2 + "+{n} more", the full answers in the plain text (≤ 50 answers, ≤ 1,000 characters each,
as Google Forms); thread key `response:<id>` (an edited response, where the vendor sends one, joins it); answers of
type email are shown (everyone in the room sees them; the guide says so, as for Google Forms); file-upload answers
show the file name only, the vendor's file URL is **not** made a link (it can be a public bucket URL).

**Typeform** (https://www.typeform.com/developers/webhooks/example-payload/,
https://www.typeform.com/developers/webhooks/secure-your-webhooks/, https://www.typeform.com/developers/webhooks/):
- Body: `event_id`, `event_type` (`form_response`), `form_response.{form_id, token, submitted_at, definition.{title,
  fields[]}, answers[]}`; each answer has `type`, a value under the type's key, and `field.{id, type, ref}`. Match
  answers to `definition.fields` by **`field.id`** (refs are unstable unless set). Skipped questions are absent.
- Dedupe `event_id`; thread `response:<token>`; link none (results live behind sign-in; a built
  `admin.typeform.com/form/<form_id>/results` link is a live-check option).
- Signature `b64-body` with `sha256=` prefix, header `Typeform-Signature`. The docs show the secret set through the
  API; whether the Connect › Webhooks screen has a secret field is a live check. Without it, Typeform is token-only.
- Retries: 10 hours for 408/423/429/503, back-off up to 4 h otherwise; a 404 or 410 **disables the webhook at once**
  → Trina must never answer 404 to a live token on Typeform's path (it doesn't: 404 is only for unknown tokens; after
  Regenerate the old URL answering 404 disabling Typeform's webhook is the wanted outcome).
- Guide: ① In Typeform open the form › **Connect** › **Webhooks** › **Add a webhook**. ② Paste the URL, Save. ③ Turn
  the webhook on. (ko: Typeform has no Korean UI → English labels in quotes.) Live check: labels, plan needed.

**Tally** (https://tally.so/help/webhooks):
- Body: `eventId`, `eventType` `FORM_RESPONSE`, `createdAt`, `data` with the response/submission and form ids, the
  form name, `fields[{key, label, type, value, options?}]`. Exact key names under `data` are a live check
  (expected `responseId`, `submissionId`, `formId`, `formName`). Choice values are option ids → mapped to `options`
  text. Free on every Tally plan.
- Dedupe `eventId`; thread `response:<responseId>`.
- Signature `b64-json`: Tally's sample computes base64 HMAC-SHA256 over `JSON.stringify(req.body)` (the parsed and
  re-serialised body), not the raw bytes. Trina tries the raw bytes first, then `JSON.stringify(JSON.parse(raw))`
  (Bun's and Node's `JSON.stringify` agree on key order and escapes). Tested with Tally's own sample in TC-1634.
- Retries after 5 min, 30 min, 1 h, 6 h, 1 day; answer within 10 s.
- Guide: ① In Tally open the form › **Integrations** › **Webhooks** › **Connect**. ② Paste the URL into **Endpoint
  URL**. ③ Optional: **Add a signing secret** and paste the one Trina shows. ④ Connect.

**Jotform** (https://www.jotform.com/help/245-how-to-setup-webhook-integration/,
https://www.jotform.com/help/248-webhook-samples):
- Posted as a form (the docs' samples read `$_REQUEST`; multipart/form-data per user reports): `submissionID`,
  `rawRequest` (a JSON string of answers keyed like `q3_fullName`), and (third-party, live check) `formID`,
  `formTitle`, `pretty` ("Label:Value, …").
- New content type: **multipart/form-data** for this preset only, read with `Response.formData()` over the bounded
  raw body; file parts are ignored (never stored), ≤ 100 fields, each ≤ 64 KB. `application/x-www-form-urlencoded`
  too.
- Labels: from `pretty` when present, else the `rawRequest` key without `qN_` and split on camel case. Dedupe
  `submissionID`; thread `submission:<id>`. No signature (Jotform documents none).
- Guide: ① In Jotform open the form › **Settings** › **Integrations**, search **WebHooks**. ② Paste the URL into
  the field, **Complete Integration**, **Finish**. Live check: Korean UI (Jotform has one) labels, the content type.

### P1: Stripe

Facts (https://docs.stripe.com/webhooks): Workbench › **Webhooks** › **Create an event destination** → pick events →
destination type **Webhook endpoint** → **Endpoint URL**; secret under **Reveal secret** (`whsec_…`);
`Stripe-Signature: t=…,v1=…` = HMAC-SHA256 of `"{t}.{raw}"`; ignore `v0`; retries up to 3 days (live mode); up to
16 destinations. Event names below from Stripe's event catalog (live check that each is in the picker).

| switch | events | default |
|---|---|---|
| `payment` | `checkout.session.completed`, `payment_intent.succeeded` (one card per payment: the session's `payment_intent` and the intent's id are the same thread key, the second arrival only edits the status) | on |
| `refund` | `charge.refunded` | on |
| `failed` | `invoice.payment_failed`, `payment_intent.payment_failed` | on |
| `dispute` | `charge.dispute.created` | on |
| `subscription` | `customer.subscription.created`, `customer.subscription.deleted` | off |

- Card: kind "Payment received" / "Refunded" / "Payment failed" / "Dispute opened" (+ " · Test mode" when
  `livemode` is false); title "{amount} from {customer name}" (amount from the smallest unit by currency exponent:
  zero-decimal currencies such as JPY and KRW not divided; formatted with `Intl.NumberFormat` in the team locale);
  details: description or the first line item name, the failure message for failed ones; status line "Status:
  Succeeded/Refunded/Failed"; link `https://dashboard.stripe.com[/test]/payments/<pi>` (a fixed host, built, never
  taken from the body).
- Customer email: not shown (a name is enough to find it; Stripe has the rest). Card holder data: never read.
- Thread `pi:<payment_intent>`; a refund (`charge.refunded` → `payment_intent`) and a dispute join it (`back` for the
  dispute: also shown in the room). Dedupe the event `id`.
- Body max 256 KiB (events are small; a `checkout.session` with many items stays far under).
- Guide: ① Stripe › **Developers** › **Workbench** › **Webhooks** › **Create an event destination**. ② Select the
  events listed below, **Continue**, choose **Webhook endpoint**. ③ Paste the URL into **Endpoint URL**, **Create
  destination**. ④ Optional: **Reveal secret**, paste it here. (Stripe's dashboard is in English and some other
  languages; Korean labels: live check.)

### P1: Shopify

Facts: a store admin creates one under **Settings › Notifications › Webhooks › Create webhook** (event, format JSON,
URL, API version), https://help.shopify.com/en/manual/fulfillment/setup/notifications/webhooks ; signed
`X-Shopify-Hmac-SHA256` = base64 HMAC-SHA256 of the raw body; dedupe on `X-Shopify-Event-Id` (the same across
subscriptions) / `X-Shopify-Webhook-Id`; 5 s total timeout; 8 retries over 4 h, repeated failures delete the
subscription (https://shopify.dev/docs/apps/build/webhooks/subscribe/https). Which key signs **admin-created**
webhooks (the help page: "signed with an ID … unique to your store") is a live check; the guide reads "copy the key
shown on the Webhooks page" only if it is there.

| switch | Shopify event (topic) | default |
|---|---|---|
| `order` | Order creation (`orders/create`) | on |
| `paid` | Order payment (`orders/paid`): edits the order card's status | on |
| `cancelled` | Order cancellation (`orders/cancelled`) | on |
| `refund` | Refund create (`refunds/create`) | on |
| `fulfilled` | Order fulfillment (`orders/fulfilled`) | off |

- Card: kind "New order #{order_number}"; title "{total_price} {currency} · {n} items"; details: the first two line
  items "2 × T-shirt", the customer's first name and city (no street, email or phone); status "Paid/Pending/
  Refunded/Cancelled"; link `https://admin.shopify.com/store/<handle>/orders/<id>` where `<handle>` comes from
  `X-Shopify-Shop-Domain` (`<handle>.myshopify.com` only; live check that the link opens).
- Thread `order:<id>`; dedupe `X-Shopify-Event-Id`, else `X-Shopify-Webhook-Id`. Body max 1 MiB (orders with many
  lines are large). Answer within Shopify's 5 s: the path is fast already (no I/O).
- Guide: ① Shopify admin › **Settings** › **Notifications** › **Webhooks** › **Create webhook**. ② Event "Order
  creation", Format "JSON", paste the URL, latest API version, **Save**. ③ Repeat for "Order payment", "Order
  cancellation", "Refund create" (Shopify makes one webhook per event; the guide says so). ④ Optional: copy the
  signing key shown on that page here. Korean labels: Shopify admin has Korean (설정 › 알림 › 웹훅), live check.

### P1: Zendesk (triggers → webhook, template preset)

Facts (https://support.zendesk.com/hc/en-us/articles/4408839108378,
https://developer.zendesk.com/documentation/webhooks/verifying/): Admin Center › **Apps and integrations** ›
**Webhooks** › **Create webhook** › **Trigger or automation**; method, format JSON, up to 5 headers; then a trigger
action **Notify webhook** with a typed payload (≤ 16,000 characters, placeholders allowed); signed
`X-Zendesk-Webhook-Signature` = base64 HMAC-SHA256(timestamp + body) with `X-Zendesk-Webhook-Signature-Timestamp`,
secret under **Reveal secret**; Suite Team and up, Support Team and up; best-effort, up to 3 retries. Doable by an
admin in the UI: yes, so Zendesk is in P1.

- **Copy body** gives the trigger's JSON payload (the placeholders are Zendesk's; whether Zendesk JSON-escapes
  placeholder values inside a JSON body is a live check, see robustness):

```json
{"trina":"zendesk","id":"{{ticket.id}}","title":"{{ticket.title}}","status":"{{ticket.status}}",
 "priority":"{{ticket.priority}}","requester":"{{ticket.requester.name}}","assignee":"{{ticket.assignee.name}}",
 "url":"{{ticket.url}}","update":"{{ticket.latest_public_comment}}"}
```

| switch | trigger condition the guide sets | default |
|---|---|---|
| `new_ticket` | "Ticket is Created" | on |
| `updated` | "Ticket is Updated" and status changed (second trigger, optional step) | on |

- Card: kind "New ticket #{id} · {priority}"; title = ticket title; details "From {requester}", "Assigned to
  {assignee}"; status "Status: {status}"; link = `url` when its host ends in `.zendesk.com` (Zendesk's
  `{{ticket.url}}` has no scheme: `https://` is added). Updates go to the thread `ticket:<id>` and edit the status
  line; "solved" → status Solved; a reopened ticket (`back`) also shows in the room.
- Dedupe sha256(raw + timestamp header) within 10 min (Zendesk sends no delivery id).
- Robustness: placeholders are text inside quotes; if a title contains a quote and Zendesk does not escape it, the
  JSON breaks. The parser then tries a **tolerant read** of this preset's flat shape only (key-by-key between the known
  keys); if that fails too → 400, refusal "format", and the guide's "Nothing yet?" says "Use the body Trina gave you
  exactly". Live check decides whether the tolerant read is needed.
- Guide: ① Zendesk Admin Center › **Apps and integrations** › **Webhooks** › **Create webhook** › **Trigger or
  automation** › Next. ② Name "Trina", paste the URL into **Endpoint URL**, method **POST**, format **JSON**,
  **Create webhook**. ③ **Objects and rules** › **Triggers** › **Create trigger**: condition "Ticket is Created",
  action **Notify webhook** › Trina, paste the body (**Copy body**), Create. ④ Optional: a second trigger for "Ticket
  is Updated". ⑤ Optional: **Reveal secret** on the webhook page and paste it here. Zendesk has Korean; labels live
  check.

### P4: Jira (automation template)

Facts (https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/,
https://support.atlassian.com/cloud-automation/docs/jira-smart-values-issues/): rule action **Send web request** with
a **Custom data** body and smart values (`{{issue.key}}`, `{{issue.summary}}`, `{{issue.url}}`). Runs count against
the site's automation limits (the numbers changed in 2026, live check). No signature (token only; Jira can add a
hidden header, unused).

- Copy body (`.jsonEncode` keeps quotes safe; live check that the function exists on Cloud):
  `{"trina":"jira","key":"{{issue.key}}","title":{{issue.summary.jsonEncode}},"status":"{{issue.status.name}}",
  "assignee":{{issue.assignee.displayName.jsonEncode}},"url":"{{issue.url}}","event":"{{triggerType}}"}` (the last
  field: live check, else one rule per trigger with a fixed `"event"`).
- Switches `created` on, `transitioned` on, `commented` off. Thread `issue:<key>`; status line follows `status`.
- Guide: ① Jira › Project settings › **Automation** › **Create rule**. ② Trigger "Work item created" (and a second
  rule for "Work item transitioned"). ③ Action **Send web request**: paste the URL, method POST, body **Custom
  data**, paste the body. ④ Turn it on.

### P4: HubSpot (paid tier)

Facts (https://knowledge.hubspot.com/workflows/how-do-i-use-webhooks-with-hubspot-workflows): workflow action **Data
ops › Send a webhook**, **Data Hub Professional or Enterprise only** (formerly Operations Hub); POST with "Include all
properties" or a customised key/value body (not free JSON); signature only through an app secret (a UI-only admin
has none) → token only; retries up to 3 days.

- The preset reads HubSpot's object body: `hs_object_id`, and for deals `dealname`, `amount`, `dealstage`; contacts
  `firstname`, `lastname`, `company`, `lifecyclestage`; tickets `subject`, `hs_pipeline_stage`. The guide picks
  "Customize request body" with these properties (a list shown in the guide).
- Card "Deal moved · {stage}" / "New contact"; thread `deal:<id>`; link `https://app.hubspot.com/` + the record path
  only when the portal id is sent (live check).
- The picker row says "Needs HubSpot Data Hub Professional" in its second line (no surprise after setup).

### P4: Zapier and Make (how-tos under Other)

Not presets: two expanders in the Other guide, each with one worked example and a **Copy body**.
- Zapier: **Webhooks by Zapier** is a paid-plan app (Professional and up,
  https://help.zapier.com/hc/en-us/articles/8496288690317). Example "New Google Calendar event → Trina": trigger
  Google Calendar **New Event**; action Webhooks by Zapier **POST**, URL = Trina's, Payload Type **json**, Data
  `title` = Summary, `text` = Start time + Location, `link` = HTML link, `thread` = Event ID.
- Make: **HTTP › Make a request**, Body content type `application/JSON`, input method "Data structure"
  (https://apps.make.com/http). Example "Watch Events" (Google Calendar, https://apps.make.com/google-calendar) → the
  same fields.
- Other already reads `title`, `text`, `link`, `thread`, so nothing changes on the server.

### P4: regional group (lower priority, research kept)

Shown under "More services" (see the picker). Each is a preset like the ones above; built after the rest of P4.

**Toss Payments** (https://docs.tosspayments.com/guides/v2/webhook,
https://docs.tosspayments.com/reference/using-api/webhook-events): 개발자센터 › **웹훅** › **웹훅 등록하기** (name,
URL, events) › **등록하기**, per MID. Events used: `PAYMENT_STATUS_CHANGED` (status DONE → "Payment done", CANCELED /
PARTIAL_CANCELED → "Cancelled"), `DEPOSIT_CALLBACK` (virtual-account deposit; its body has `secret`, `status`,
`transactionKey`, `orderId`, no `eventType`), `CANCEL_STATUS_CHANGED`. Headers `tosspayments-webhook-transmission-time`,
`-retried-count`, `-transmission-id` (new on every send: not a dedupe key), `tosspayments-webhook-signature`
(`toss` scheme; which events are signed is a live check). Dedupe sha256(eventType + orderId + status + createdAt).
Both PAYMENT_STATUS_CHANGED and DEPOSIT_CALLBACK registered → a deposit arrives twice: same thread key `order:<orderId>`
and the same state → the second only counts as skipped. 200 within 10 s; 7 retries over ~3 days 19 h. The
DEPOSIT_CALLBACK `secret` is checked against the approval response, which Trina never sees: ignored, and the card
says nothing about verification.

**Channel Talk** (https://developers.channel.io/en/articles/Getting-started-f2a30b58,
https://developers.channel.io/en/articles/Webhook-events-7bd9b8e2): Settings › **Webhook** › **Create new webhook**
(name, URL, notification types); Channel Talk calls `URL?token=<its token>`; no HMAC. Body `event`, `type`
(Message/UserChat/User), `entity`, `refers`. Switches `new_chat` on (UserChat), `customer_message` on (Message from
a user, not from a manager or bot), `manager_message` off. Card "New chat · {customer name}", title = the message's
plain text (first 200 characters), thread `chat:<userChatId>`; link none (desk URL needs the channel id: live check).
Optional `url-token`: paste Channel Talk's token. 100 failures in a row block the webhook (one-click unblock).
Korean menu labels: live check.

**PortOne** (https://developers.portone.io/opi/ko/integration/webhook/readme-v2?v=v2): V2 only (V1 has no signature
and only ids). 결제알림(Webhook) 관리; Standard Webhooks (`standard` scheme, secret from the console, two per
environment); body `type` (`Transaction.Paid`, `.Cancelled`, `.PartialCancelled`, `.VirtualAccountIssued`,
`.Failed`), `timestamp`, `data.{storeId, paymentId, transactionId}`. **The body has no amount or name**: the card is
"Payment {state} · {paymentId}" with no amount (Trina never calls PortOne's API). Dedupe `webhook-id`; thread
`payment:<paymentId>`; 5 retries.

### Skipped (no no-code path found)

- **Calendly:** webhooks only through its API with a personal access token or OAuth app
  (https://calendly.com/help/webhooks-overview). Reachable through Zapier/Make instead.
- **Intercom:** developer webhooks need a Developer Hub app (https://developers.intercom.com/docs/webhooks). A
  "Series" webhook block exists (https://www.intercom.com/help/en/articles/5222039-sending-webhooks-with-series) but
  it is plan-limited and possibly legacy; revisit only if teams ask. Through Zapier/Make meanwhile.

## Email in (P2 hosted, P3 self-installed)

### The address and the mail domain

- **Cloudflare Email Routing allows a catch-all only on an apex domain**, not on a subdomain
  (https://developers.cloudflare.com/email-routing/setup/subdomains/,
  https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/), and a domain holds at most 200
  routing rules (https://developers.cloudflare.com/email-routing/limits/). So `<token>@in.trina.app` as a catch-all is
  not possible on Email Routing. **Recommendation: a separate apex domain only for mail in** (owner confirmation 2:
  the name and buying it), catch-all → the Email Worker. It also keeps the product domain's own mail, SPF and DMARC
  apart from mail anyone can send to. Written below as `mail.<domain>`.
- Address: `<local>@<mail domain>`, `local` = 32 lowercase base32 characters (160 random bits; local parts are often
  lowercased by senders, so no mixed case). Separate from the Webhook URL token (it leaks differently, below).
- Stored like the token: `sha256(local)` for lookup, the local part sealed in the vault for "Copy" again.
- **Regenerate** makes a new one; the old is removed from the gateway's table at once (the Worker's lookup table is
  read with a short cache, ≤ 60 s; the server also drops mail for an old local part, so nothing posts after
  Regenerate).

### P2: hosted teams

```
 sender ──SMTP──▶ Cloudflare Email Routing (catch-all) ──▶ Email Worker (hosting repo)
                       │ SPF/DKIM/DMARC checked,            1. local part shape, lookup sha256(local) → team
                       │ DMARC-failing mail rejected           (unknown → setReject: SMTP 550, no bounce from us)
                       │                                    2. rawSize ≤ 10 MiB else setReject
                                                            3. per-address / per-team counters (Durable Object)
                                                            4. seal the raw message + facts to the team's key
                                                            5. POST to the team through the relay, signed
                                                               (on failure: a queue retries ≤ 24 h, sealed)
 team server  POST /in/mail ◀─────────── relay ◀───────────┘
   verify gateway signature, open, dedupe, parse MIME, post card + files
```

- Cloudflare checks DMARC before the Worker runs, rejects mail that fails the sender domain's DMARC policy, and
  prepends `Authentication-Results: mx.cloudflare.net; spf=…; dkim=…; dmarc=…`
  (https://developers.cloudflare.com/email-routing/email-workers/,
  https://developers.cloudflare.com/email-routing/postmaster/). Trina trusts **only the first such header with that
  identifier**; everything else in the headers is the sender's.
- Max inbound 25 MiB at Cloudflare; Trina's cap 10 MiB (setReject "Message too large for this address").
- Workers Free has 10 ms CPU, so the Worker **does not parse MIME**: it checks size and the table, reads the raw
  stream, seals, sends. Parsing happens on the team server (one parser for P2 and P3). Workers Paid ($5/month) for the
  CPU of sealing 10 MiB (https://developers.cloudflare.com/workers/platform/limits/,
  https://developers.cloudflare.com/workers/platform/pricing/).
- Registration: the team server registers each email app's `sha256(local)` (never the local part) with
  `POST /api/mail-in/v1/register` signed with its relay team key (as the Drive and Slack brokers); `unregister` on
  Regenerate/Remove; `status` lists what is registered (reconciled at start).
- Sealed item: `X25519-HKDF-SHA256-A256GCM` to the team's mail key (as the Slack token transfer and part 1's mailbox
  sketch); AAD = item id + receive time + `sha256(local)`; plaintext = the raw RFC 822 bytes + `{envelopeFrom,
  authResults, receivedAt, rawSize}`. The team's mail key: X25519, private key in the credentials vault (kind
  `mail_in_key`, key version, rekeyed with the rest), public key sent with `register`.
- Delivery: `POST https://<team address>/in/mail` with `Authorization: TrinaMailIn <ed25519 signature>` over
  `item id, receive time, sha256(sealed)` by the **gateway key**, whose public key is pinned in
  `shared/src/cloud-protocol/mail-in.ts` (two keys allowed for rotation, as the push gateway). Outside `/api`, no
  session; refused without a valid signature (401), duplicate item id → 200 (dedupe ≥ 24 h in `room_app_mail_items`).
- Retry: if the POST fails the Worker puts the sealed item on a queue that retries for ≤ 24 h, then drops it and
  counts it; the team's next `status` call returns "{n} mails could not be delivered" → the app's status line.

### P3: self-installed servers (the mailbox)

As sketched in part 1 ("Phase 2: the mailbox"), now with mail as its first user:
- A self-installed server **with** the relay or its own public address gets P2's push (the gateway POSTs to its team
  address). A registered server **without** a public address pulls:
  `POST /api/mail-in/v1/poll` (signed long poll ≤ 25 s), `POST /api/mail-in/v1/ack {ids}`; the mailbox deletes an
  acked item at once. At least once: the server dedupes item ids for ≥ 24 h.
- Keys in the vault (above); item id + time in the AAD (no replay under another id or time).
- Retention ≤ 24 h, no backups of the queue; expired items counted → "{n} mails expired while this server was offline."
  on the app's status line.
- Abuse caps at the mailbox: held items per team ≤ 2,000 or 200 MB; a server that has not polled for 7 days stops
  receiving (the gateway rejects at SMTP: "This address is not receiving mail right now.") and the owner gets one
  Activity notice when it polls again.
- **What the cloud sees, stated plainly in docs/for-admins and on Admin › Connection:** the mail service sees each mail
  in clear while it receives it (SMTP has no end-to-end encryption to us): sender, recipients, subject, body and
  attachments, in memory until it seals the item. It stores only the sealed item (≤ 24 h), plus the address hash,
  size, time, the sending server's IP and the auth results for limits (logs 7 days). It cannot read stored items; it
  could, while receiving, drop or delay mail, and anyone who can send mail can send to the address — the cloud adds no
  power beyond that, because mail is never "verified" anyway.
- Servers not registered with the hosting service: no email in ("Email in needs this server to be connected to Trina's
  hosting service." on the picker row, as part 1's "no public address" state).

### Parsing on the team server (`server/src/rooms/apps/mail/*`)

- **MIME:** `postal-mime` (MIT, no Node built-ins; runs in Bun) with a size check first and its limits
  (`maxPartCount` 200, `maxNestingDepth` 20, headers ≤ 256 KB); a library choice check in phase 2 (license file in
  NOTICE). Its default charset handling (UTF-8, windows-1252 fallback) is replaced by our decoder:
- **Charsets** (`mail/charset.ts`): `TextDecoder` where the runtime supports the label (Bun: checked by a test per
  label), else a vendored table decoder. Labels and aliases tested: UTF-8, **EUC-KR / CP949 / `ks_c_5601-1987`**
  (Outlook's Korean label = CP949), **ISO-2022-KR** (stateful: `ESC $ ) C` designator, SO/SI shifts; decoded by
  setting the high bit on shifted bytes and reading EUC-KR), ISO-2022-JP, Shift_JIS, EUC-JP, GB2312/GBK/GB18030, Big5,
  ISO-8859-1..15, windows-1250..1258, KOI8-R, UTF-16. Unknown → UTF-8 with replacement characters, never a refusal.
- **Encodings:** RFC 2047 encoded words in headers (B and Q, adjacent words joined, split multibyte sequences across
  words handled by decoding per charset run), RFC 2231 file names (`filename*=UTF-8''…`, and the common broken
  raw-UTF-8/EUC-KR names), quoted-printable and base64 bodies, 7bit/8bit, `format=flowed`.
- **Which body:** `text/plain` if it has real text, else `text/html` → plain text (scripts, styles, head and hidden
  elements removed; block elements to line breaks; table cells joined with " · " so an order table stays readable;
  entities decoded). **HTML-only mail** (most shop notices) goes this way. Remote images and links are never fetched.
- **Forwarded mail:** a `message/rfc822` attachment (forward as attachment) is read as the mail; an inline forward
  ("---------- Forwarded message ---------", "Begin forwarded message:", "-----Original Message-----", "전달된 메시지",
  "원본 메시지", "Pesan yang diteruskan", "転送されたメッセージ") is detected and its From/Subject/Date shown as the
  original, with "Forwarded by {address}" as a detail line.
- **Card:** kind "Email · from {original or From address}" (the **address** always, the display name only next to it,
  so "CEO Kim" <x@evil.example> shows the evil address); title = Subject (≤ 200; "(no subject)"); details = the first
  3 meaningful lines (greetings, "This is an automated message", signature separators skipped by a small list);
  plain text = the body text ≤ 20,000 characters (more: "Show the whole mail" opens it, cut with a line). **No link on
  the card** from the mail and links in its text are shown as text (owner confirmation 4). Never a person, never
  "verified", even when DMARC passed; a From that matches a team member's address is **not** linked to that member.
- **Thread key:** the root of `References` / `In-Reply-To` (a reply chain stays in one thread); else none. **Dedupe:**
  `Message-ID` (+ sha256(raw) when missing) for 7 days in `room_app_deliveries`.
- **Gmail's forwarding confirmation** (from Google, with a confirmation link) is shown like any mail: it is how the
  person confirms forwarding (https://support.google.com/mail/answer/10957). The guide points at it.
- **Auto-replies:** mail with `Auto-Submitted: auto-replied` or a vacation subject pattern is skipped (loops with
  forwarding rules); bulk/list mail is kept (shop notices are bulk).
- Switches: `mail` on, `attachments` on, `auto_replies` off.

### Attachments → room files

- Kept: ≤ 5 files per mail, each ≤ 10 MiB (the mail is ≤ 10 MiB anyway), types by **content sniffing**, not the
  name: PDF, PNG/JPEG/GIF/WebP/HEIC, Office (docx/xlsx/pptx, by their zip structure), HWP/HWPX, CSV, TXT, ICS.
- Dropped with a line on the card ("2 attachments not kept: setup.exe, archive.zip"): executables, scripts,
  HTML/SVG/XML, archives (zip, 7z, rar, alz/egg), macro-enabled Office (docm/xlsm/pptm), disk images, unknown types,
  encrypted PDFs are kept (they are common for invoices) but never previewed.
- Inline images referenced by `cid:` in the HTML are dropped (signatures, logos) unless also listed as attachments.
- Stored through `rooms/files.ts create` with `user_id` NULL, `message_id` = the card: the same `.system/rooms/` place,
  the room-membership check on every read, the sandbox CSP, the quarantine list by hash, the team storage check (a
  full team: files dropped, the card says so). Counted in the app's day like messages (one mail = one message).

### Spam and abuse caps

| limit | value | where |
|---|---|---|
| unknown local part | SMTP 550 at once; no bounce is ever generated by Trina (no backscatter) | Worker |
| mail size | 10 MiB → SMTP reject | Worker |
| per address | 60 / hour, 300 / day accepted; over → dropped and counted (Email Workers' reject is permanent, so over-limit mail is accepted and dropped, not rejected) | Worker (Durable Object counter) |
| per team, all mail apps | 2,000 / day | Worker |
| per sending IP to unknown addresses | 30 / minute then reject everything from it for 10 min | Worker |
| shown per app per day | part 1's 500 cap and pause | server |
| "Only accept mail from" set | others dropped silently (counted "skipped") | server |
| attachments | ≤ 5 × 10 MiB, type list | server |

The mail domain publishes an MX to Cloudflare, `v=spf1 -all` and DMARC `p=reject` (it never sends), so nobody can
send **as** it.

## Data and migrations

Component B, range 200-299 full; the fallback B range 400-499 has `400_b_chat_files.sql`. Checked 2026-11-14 on
`origin/dev` and every remote and local branch: nothing in 401-499 or in C's 353-399. Re-check right before merging.

**`401_b_room_app_presets.sql` (P1)**, `min_compatible_reader: 1`:

```sql
-- presets: a named service set up through "Other" (room_apps.kind CHECK is fixed and tables are never rebuilt).
--   kind stays 'other' for every preset, so an older build (and an older phone app parsing RoomAppKind strictly)
--   still reads the row and its messages as an Other app; preset names which reader, switches, signature scheme and
--   logo the newer build uses. No CHECK: the preset list grows in code (shared/src/api/room-apps.ts RoomAppPreset).
ALTER TABLE room_apps ADD COLUMN preset TEXT;
```

`secret_enc` (part 1) holds every preset's secret; the scheme is the preset's, not stored.

**`402_b_room_app_mail.sql` (P2)**:

```sql
-- email in: an email app is kind 'other' + preset 'email'.
CREATE TABLE room_app_mail (
  app_id TEXT PRIMARY KEY REFERENCES room_apps(id) ON DELETE CASCADE,
  local_hash TEXT NOT NULL UNIQUE,          -- sha256 of the address's local part (the gateway knows only this)
  local_enc TEXT NOT NULL,                  -- the local part, vault kind 'room_app_mail_local', app id in the AAD
  key_version INTEGER NOT NULL,
  senders TEXT NOT NULL DEFAULT '[]',       -- "Only accept mail from": addresses or @domains, ≤ 20
  registered_at TEXT,                       -- the gateway acknowledged it (NULL: pending, retried)
  undelivered INTEGER NOT NULL DEFAULT 0,   -- mails the gateway gave up on (status line), reset when seen
  last_mail_at TEXT
);
-- gateway/mailbox items already handled (at least once delivery): kept ≥ 24 h, pruned after 7 days
CREATE TABLE room_app_mail_items (item_id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE INDEX room_app_mail_items_at ON room_app_mail_items(at);
-- the team's mail key (one row): X25519, private key sealed in the vault (kind 'mail_in_key'), rekeyed with the rest
CREATE TABLE mail_in_keys (id INTEGER PRIMARY KEY CHECK(id = 1), public_key TEXT NOT NULL, private_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL, created_at TEXT NOT NULL);
```

**P3:** no migration expected (poll state is in memory; expired counts come from the mailbox's status). If one is
needed: `403_b_…`. An Activity notice for "stopped receiving" would need its own notice table (fixed CHECK lists):
`353_c_room_app_mail_notices.sql` (C's next free number) only if the owner wants a notice and not just the status line.

`credentials/rekey.ts`: `room_app_mail.local_enc` and `mail_in_keys.private_enc` join `rekeyRoomApps`.

## API

`shared/src/api/room-apps.ts`:
- `RoomAppPreset = z.enum(['notion','typeform','tally','jotform','stripe','shopify','zendesk','email', 'jira','hubspot',
  'toss_payments','channel_talk','portone'])` (P1 adds the first eight minus `email`; P2 `email`; P4 the rest).
- `RoomApp.preset?`, `RoomAppRef.preset?` (optional: older clients ignore them and show "Other app" with the name).
- `CreateRoomAppBody` gains `preset?` (only with `kind: 'other'`; 400 otherwise).
- `ROOM_APP_PRESET_SWITCHES[preset]` beside `ROOM_APP_SWITCHES`; `ROOM_APP_PRESET_NAMES`; `ROOM_APP_PRESET_SIGNING`
  (`none` | `trina_makes` | `paste` and the shape regex).
- `SetRoomAppSecretBody`: unchanged shape; the server checks the secret by the app's preset.
- `RoomAppAddress` gains `email?: string` (email apps: the address instead of `address`).
- New `PUT /api/rooms/:id/apps/:appId/senders` `{ senders: string[] ≤ 20 }` (email apps; WHO as the rest; audited).
- `roomAppZendeskBody()`, `roomAppJiraBody()` beside `roomAppFormsScript()` (the Copy body texts).
- Not under `/api`: `POST /in/<token>` (unchanged path, new presets), `POST /in/mail` (gateway-signed sealed item).
- `shared/src/cloud-protocol/mail-in.ts` (MIT, erasable TS, no imports): register/unregister/status/poll/ack bodies,
  `TrinaMailIn` and `TrinaMailbox` signing strings, the sealed item layout, the gateway public keys, error codes, test
  vectors in `vectors/`.
- `docs/features.ts`, `bun run docs:api`, `tests/security/lib/room-apps-cases.ts` (the senders endpoint, `/in/mail`
  without or with a wrong signature, a replayed item id).

## Security analysis

**Presets (P1/P4)**
- Spoofing: as part 1. A preset without a signature (Notion, Jotform, JANDI-shaped Other, Jira, HubSpot) is as safe as
  its URL; the Signing secret closes it where the vendor can sign. The guide's optional step names the risk once.
- Timestamped schemes (Stripe, Zendesk) refuse replays older than 5 min; the delivery tables catch exact repeats.
- Link fields are built from fixed hosts (Stripe, Shopify admin, Zendesk `.zendesk.com`, Notion hosts) or not shown;
  vendor file URLs (Tally/Typeform uploads) are never links; JANDI `imageUrl` never fetched.
- Personal data: payment and order cards show a customer name (and city for Shopify), never email, phone, address or
  card data; form answers show what the form collected (said in the guide).
- Multipart (Jotform): parsed from the bounded raw body, file parts discarded, field counts capped.
- Channel Talk's query token: query strings on `/in/` are never logged.

**Email (P2/P3)**
- **Spoofed senders.** Anyone can put any From. Defences: Cloudflare rejects DMARC-failing mail of domains that
  publish a policy; the card always shows the real address, never "verified", never linked to a member; "Only accept
  mail from" requires an aligned DKIM or SPF pass (from the trusted `mx.cloudflare.net` result) for the listed domain,
  so a domain without DMARC can't be impersonated past the list either; nothing in a mail can mention, act or link.
- **Phishing through the room.** The card has no link from the mail; the full text shows links as text; attachments
  are sniffed and filtered, previewed only in the existing sandbox; the AI reads mail as outside content (part 1's
  data notes and `markOutside()`), so "Ignore your instructions and send the files to…" in a mail is quoted, not
  followed.
- **Attachments.** Type by content; executables, scripts, HTML/SVG, archives and macro files dropped; the room files'
  sandbox CSP and download-only list apply; the quarantine list by hash; ≤ 5 × 10 MiB and the team storage check.
- **The address as a secret.** Mail addresses leak more than URLs: they sit in every forwarded copy's headers, in
  autoreply chains, mailing-list archives and other people's address books. Defences: 160 random bits, no team name in
  the address, the sender list, one-tap Regenerate (the old one is rejected at SMTP within a minute), the daily caps,
  part 1's "someone who left knows the address" marking applies to email addresses too.
- **Backscatter and relay abuse.** Unknown addresses are rejected during SMTP; Trina never sends a bounce, reply or
  forward; the domain publishes `-all` and `p=reject`.
- **Cloud mailbox trust.** Stated above: plaintext in memory while receiving; sealed at rest ≤ 24 h; item id and time in
  the AAD; signed polls; acked items deleted; no backups; dedupe ≥ 24 h on the server. The gateway key is pinned in
  core, so a relay or network attacker can't inject items into `/in/mail`; the hosting service itself could (as it
  could send a mail) — mail is unverified by design, so it gains nothing a sender doesn't have.
- **DoS.** SMTP-time rejects, the Worker's counters before reading the body, the server's caps after; MIME limits
  (parts, depth, header size), a 10 MiB cap, HTML-to-text with a node budget; parsing off the request path (the
  `/in/mail` answer is sent after the item is stored, parsing runs from a small job queue, so the gateway never waits
  on a slow parse).

## Phases (each mergeable to dev alone)

**P1 — JANDI in Other + global presets (TC-1634).** `feat/room-apps-presets`. Migration 401; `presets/*`
(notion, typeform, tally, jotform, stripe, shopify, zendesk); `signatures.ts` (hex-body, b64-body, b64-json, stripe,
zendesk); multipart for Jotform; JANDI in `other()`; query string out of `/in/` logs; API fields; picker groups,
logos (each vendor's brand guidelines checked; letter tile fallback), guides with Copy body, cards; the Slack words
(Webhook URL / Copy / Regenerate, Integrations › Apps, APP) and the flipped i18n test; 5 languages; samples and tests
per preset; `docs/features.ts`; `changes/room-apps-presets.md`. Live check per vendor with screenshots before the copy
is final (list below). Checks: typecheck, area unit tests, `check:i18n`, `check:docs`, full web e2e (shared room code).

**P2 — email in, hosted (TC-1635).** `feat/room-apps-mail` (core) + the hosting repo's Worker. The mail domain;
migration 402; `mail/*` (MIME, charsets, HTML to text, forward detection, attachments); `/in/mail`; the key and
registration; the email preset UX (address row, sender list, guide); `cloud-protocol/mail-in.ts` + vectors; Worker
(catch-all, table, counters, seal, push, retry queue). Tests: a corpus of real-shaped mails (fake data) per charset
and encoding (EUC-KR, CP949 `ks_c_5601-1987`, ISO-2022-KR, ISO-2022-JP, Shift_JIS, GB2312, Big5, UTF-8 QP/base64,
HTML-only, `message/rfc822`, inline forwards in 5 languages, broken encoded words, a 10 MiB attachment, a zip, an
exe renamed .pdf), the sealed item round trip with the vectors, signature and replay of `/in/mail`.

**P3 — email in, self-installed (TC-1635).** `feat/room-apps-mailbox`. The poller (`mail/mailbox.ts`, like the Slack
broker's), ack, expiry counts, the "not connected" state, Admin › Connection wording, docs/INSTALL-LINUX.md and
docs/OFFICE.md. Hosting repo: the mailbox store, poll/ack, retention, the 7-day stop. QA on a registered server
without a public address, and with the relay (push path).

**P4 — templates and the regional group (TC-1634).** `feat/room-apps-presets-2`. Jira (Copy body), HubSpot (paid-tier
note), Zapier/Make how-tos under Other; then Toss Payments (`toss`), Channel Talk (`url-token`), PortOne (`standard`)
under "More services".

## Live checks (cannot be verified without an account)

| service | what |
|---|---|
| JANDI | the creation labels in JANDI itself (seen only in a third-party help page); that JANDI-compatible senders accept `200 ok` |
| Notion | the envelope (ids, attempt), property shapes, Korean labels, which plans show "Send webhook" |
| Typeform | a secret field in the UI; Connect › Webhooks labels; plan needed |
| Tally | the exact `data` keys; that the raw bytes or the re-stringified body verifies with a real signing secret |
| Jotform | content type; `formID`/`formTitle`/`pretty`; Korean labels |
| Stripe | the event names in the picker; Korean dashboard labels; the payments link |
| Shopify | which key signs admin-created webhooks and where it is shown; the admin order link from the shop domain; Korean labels |
| Zendesk | whether placeholders are JSON-escaped in a JSON body; `{{ticket.latest_public_comment}}`; Korean labels |
| Jira | `.jsonEncode`, `{{triggerType}}`, the 2026 automation limits |
| HubSpot | the property list in "Customize request body"; the record link |
| Toss / Channel Talk / PortOne | which Toss events are signed; Channel Talk's Korean menu path and desk link; PortOne header names |
| Email | Gmail's confirmation (link vs code) and sender; Naver Mail and Daum/Kakao forwarding confirmation; Microsoft 365's admin switch wording; Bun's `TextDecoder` labels; that Cafe24, Imweb and Naver Form can send owner notices by email (nothing official found; a real admin screen is needed) |

## Effort

| phase | estimate |
|---|---|
| P1 presets + JANDI + words (incl. live checks and screenshots) | 6-7 days |
| P2 email in, hosted (core 3, Worker 2, domain + QA 1) | 6 days |
| P3 mailbox (core 1.5, hosting 2) | 3-4 days |
| P4 Jira, HubSpot, Zapier/Make how-tos | 2 days; regional group +2 days |
| total | about 19-21 days of one developer with agents, plus QA |

## Owner confirmations (each with a recommendation)

1. **Other app last, after a divider** (the UX fix put it second). Recommend: last; with 11+ named services the
   catch-all is the fallback.
2. **A separate apex domain for mail in** (Cloudflare allows a catch-all only on an apex domain; a subdomain would
   need one rule per address, max 200). Recommend: buy a short dedicated domain and put it on Workers Paid ($5/month);
   needs the owner's spending OK and the name.
3. **"Only accept mail from" off by default, offered after the first mail.** Recommend: yes (on by default would
   drop Gmail's confirmation mail and most first setups).
4. **No links on email cards** (links in the mail text shown as text, not clickable). Recommend: yes; shop and form
   notices are read, not clicked, and a clickable link from an unverified sender is the main phishing risk.

## Vendor sources (checked 2026-11-14)

JANDI https://support.jandi.com/en/articles/connect-incoming-webhook-21bc249f ; Notion
https://www.notion.com/help/webhook-actions , https://developers.notion.com/reference/webhooks (integration webhooks
differ: `X-Notion-Signature`, not used here) ; Typeform https://www.typeform.com/developers/webhooks/ ,
https://www.typeform.com/developers/webhooks/example-payload/ , https://www.typeform.com/developers/webhooks/secure-your-webhooks/ ;
Tally https://tally.so/help/webhooks ; Jotform https://www.jotform.com/help/245-how-to-setup-webhook-integration/ ,
https://www.jotform.com/help/248-webhook-samples ; Stripe https://docs.stripe.com/webhooks ; Shopify
https://shopify.dev/docs/apps/build/webhooks/subscribe/https , https://help.shopify.com/en/manual/fulfillment/setup/notifications/webhooks ;
Zendesk https://support.zendesk.com/hc/en-us/articles/4408839108378-Creating-webhooks-to-interact-with-third-party-systems ,
https://developer.zendesk.com/documentation/webhooks/verifying/ ; Jira
https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/ ,
https://support.atlassian.com/cloud-automation/docs/jira-smart-values-issues/ ,
https://support.atlassian.com/cloud-automation/docs/automation-service-limits/ ; HubSpot
https://knowledge.hubspot.com/workflows/how-do-i-use-webhooks-with-hubspot-workflows ; Zapier
https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zaps-from-webhooks , https://zapier.com/apps/google-calendar/integrations ;
Make https://apps.make.com/http , https://apps.make.com/google-calendar ; Toss Payments
https://docs.tosspayments.com/guides/v2/webhook , https://docs.tosspayments.com/reference/using-api/webhook-events ;
Channel Talk https://developers.channel.io/en/articles/Getting-started-f2a30b58 ,
https://developers.channel.io/en/articles/Webhook-events-7bd9b8e2 ; PortOne
https://developers.portone.io/opi/ko/integration/webhook/readme-v2?v=v2 ,
https://developers.portone.io/opi/ko/integration/webhook/readme-v1?v=v1 ; Calendly https://calendly.com/help/webhooks-overview ;
Intercom https://developers.intercom.com/docs/webhooks ,
https://www.intercom.com/help/en/articles/5222039-sending-webhooks-with-series ; Cloudflare
https://developers.cloudflare.com/email-routing/setup/subdomains/ ,
https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/ ,
https://developers.cloudflare.com/email-routing/limits/ ,
https://developers.cloudflare.com/email-routing/email-workers/ ,
https://developers.cloudflare.com/email-routing/email-workers/runtime-api/ ,
https://developers.cloudflare.com/email-routing/postmaster/ , https://developers.cloudflare.com/workers/platform/limits/ ,
https://developers.cloudflare.com/workers/platform/pricing/ ; postal-mime https://github.com/postalsys/postal-mime ;
Gmail https://support.google.com/mail/answer/10957 ; Microsoft 365
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding .
