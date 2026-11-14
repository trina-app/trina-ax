# Apps in rooms, part 2: more services, JANDI-shaped messages and email in

- Date (UTC): 2026-11-14
- Status: **revision 2** — two independent reviews (UX, security) checked against the code and written in; the owner's
  answers to revision 1's confirmations are in "Owner decisions" 5-8. See "Changes in revision 2" at the end.
- Branch: `plan/room-apps-presets` (this plan, no PR). Build branches per phase below.
- **P1 does not wait for the mail domain decision**: it touches no mail code, no cloud contract and no new domain.
  P2 and P3 start once the owner approves the domain spend (decision 8).
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
5. **Other app last (owner: yes)**, in a final "Any other way" block together with Email.
6. **"Only accept mail from" off by default, offered after the first real mail (owner: yes)**, never for system or
   confirmation senders, matching the outer header From (see "Sender list").
7. **No clickable links on email cards (owner: yes)**, with one exception: a provider's forwarding confirmation that
   passes DMARC for the provider's domain shows its code large with Copy and one link on an allowlisted host.
8. **A separate mail domain: pending the owner's spending OK.** The name must be visibly Trina's (e.g.
   `trina-mail.<tld>`). P2/P3 wait for it; P1 does not.

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

Groups are headings in one list, not tabs; no search box. Every row keeps its second line at 390 too (what the
service posts, and what it needs). Where a plan or role is needed the second line ends with it and the guide header
repeats it as a "Needs: …" line, so nobody finds out after setup.

```
 1440 dialog (480 wide)                              390 sheet
 ┌──────────────────────────────────────────┐       ┌──────────────────────────────────┐
 │ Add an app                             ✕ │       │ Add an app                    ✕  │
 │ Its messages appear in #sales for        │       │ Its messages appear in #sales    │
 │ everyone in the room.                    │       │ for everyone in the room.        │
 │ FORMS                                    │       │ FORMS                            │
 │ [logo] Google Forms   New responses   ›  │       │ [logo] Google Forms           ›  │
 │ [logo] Typeform       New responses   ›  │       │        New responses             │
 │ [logo] Tally          New responses   ›  │       │ [logo] Typeform               ›  │
 │ [logo] Jotform        New submissions ›  │       │        New responses             │
 │ PAYMENTS & ORDERS                        │       │ …                                │
 │ [logo] Stripe   Payments and refunds  ›  │       │ PAYMENTS & ORDERS                │
 │                 Needs: Admin or          │       │ [logo] Stripe                 ›  │
 │                 Developer role           │       │        Payments and refunds ·    │
 │ [logo] Shopify  Orders and refunds    ›  │       │        Needs: Admin or Developer │
 │ WORK                                     │       │ …                                │
 │ [logo] Notion   Database automations  ›  │       │ WORK                             │
 │                 Needs: a paid plan       │       │ [logo] Notion                 ›  │
 │ [logo] Zendesk  Tickets · Needs: Team+›  │       │        Database automations ·    │
 │ [logo] Jira     Work items       (P4) ›  │       │        Needs: a paid plan        │
 │ [logo] HubSpot  Deals, contacts  (P4) ›  │       │ …                                │
 │                 Needs: Data Hub Pro      │       │                                  │
 │ FOR DEVELOPERS                           │       │ FOR DEVELOPERS                   │
 │ [logo] GitHub                         ›  │       │ [logo] GitHub                 ›  │
 │ [logo] Sentry                         ›  │       │ [logo] Sentry                 ›  │
 │ Show more services ›            (P4)     │       │ Show more services ›             │
 │ ──────────────  ANY OTHER WAY            │       │ ───── ANY OTHER WAY              │
 │ [ ✉ ] Email     Forward notices here  ›  │  P2   │ [ ✉ ] Email                   ›  │
 │ [ ⋯ ] Other app Slack, Discord or     ›  │       │       Forward notices here       │
 │                 JANDI webhooks, Zapier,  │       │ [ ⋯ ] Other app               ›  │
 │                 Make, anything else      │       │       Slack, Discord or JANDI    │
 └──────────────────────────────────────────┘       └──────────────────────────────────┘
```

- **Groups:** FORMS (Google Forms, Typeform, Tally, Jotform) · PAYMENTS & ORDERS (Stripe, Shopify) · WORK (Notion,
  Zendesk; P4 Jira, HubSpot) · FOR DEVELOPERS (GitHub, Sentry) · "Show more services" (P4: Toss Payments, Channel
  Talk, PortOne; collapsed, the same list for everyone, no language or country logic) · a divider and **ANY OTHER
  WAY**: Email ("Forward notices here", P2) and Other app (owner decision 5).
- Needs lines: Notion "Needs: a paid Notion plan" (Send webhook is paid-only); Zendesk "Needs: Zendesk Team plan or
  higher, admin"; Stripe "Needs: Admin or Developer role in Stripe" (role names: live check); HubSpot "Needs: HubSpot
  Data Hub Professional"; the Zapier how-to "Needs: a paid Zapier plan" (Webhooks by Zapier); Shopify "Needs: store
  owner or staff with Settings access" (live check).
- Until P2 ships, the Email row is absent (no "coming soon" rows).
- A pick still creates nothing until the first Copy (part 1).

### Guide per preset (same layout as the UX fix's "How to connect")

```
 1440 (Stripe)                                       390
 ┌──────────────────────────────────────────┐       ┌──────────────────────────────────┐
 │ ‹  Connect Stripe                      ✕ │       │ ‹  Connect Stripe             ✕  │
 │ Needs: Admin or Developer role in Stripe │       │ Needs: Admin or Developer role   │
 │ Name  [ Stripe                      ]    │       │ Name [ Stripe                 ]  │
 │ Webhook URL                              │       │ Webhook URL                      │
 │ [ https://acme.trina.app/in/…  ] [Copy]  │       │ [ https://acme.trina.app/in/… ]  │
 │ Anyone with this URL can post here.      │       │ [            Copy            ]   │
 │ ① In Stripe, open Workbench › Webhooks   │       │ ① … [screenshot]                 │
 │   and choose "Create an event            │       │ ② …                              │
 │   destination".          [screenshot]    │       │ ③ …                              │
 │ ② Pick these events: [payment] [refund]  │       │ ▸ Signing secret (optional)      │
 │   [failed] [dispute] [sub. ended], then  │       │ What it posts: [card preview]    │
 │   "Webhook endpoint". Paste the URL into │       │ ○ Waiting for the first payment… │
 │   "Endpoint URL".                        │       │ [ Done ]                         │
 │ ③ Save.                                  │       └──────────────────────────────────┘
 │ ▸ Signing secret (optional)              │
 │   Paste the "Signing secret" from        │
 │   "Reveal secret": [ whsec_…  ] [Save]   │
 │ What it posts  [example card preview]    │
 │ ○ Waiting for the first payment…         │
 │                                 [ Done ] │
 └──────────────────────────────────────────┘
```

- The events to tick in the vendor are chips inside the step where they are ticked (the keys of Trina's switches that
  are on).
- **Copy body sits inside the step where it is pasted** (Zendesk step ③, Jira step ③, the Zapier/Make how-to's step),
  never as a second button at the top. Notion's step ③ says "Tick at least the title and Status".
- A switch for an event the guide marked optional that has never arrived reads **"Not set up in Shopify"** (or the
  vendor's name) under it, with a link back to that step, instead of looking on but silent.
- "Signing secret (optional)" is collapsed, and exists only on presets that can sign (table below).

### States (every guide and the app's settings)

| state | what shows |
|---|---|
| email address not yet registered at the gateway (P2) | the field reads "Setting up the address…" and **Copy is disabled** until `registered_at` is set (normally < 5 s; retried in the background) |
| gateway or mailbox down (P2/P3) | "Mail can't reach this room right now. It is delivered when the connection is back (up to 24 hours)." |
| secret saved but every request refused | per preset: Stripe "Stripe sent messages but the signing secret didn't match. Copy it again from Reveal secret."; Zendesk, Shopify, Tally, Typeform, Toss, PortOne the same with their own label; GitHub/Sentry as part 1 |
| Regenerate confirm, per vendor | names what the vendor does with the old URL: Typeform "Typeform turns the webhook off when the old URL stops working (404/410); paste the new one and turn it on again." Shopify "Shopify deletes the webhook after repeated failures; you may need to create it again." Notion "Notion pauses the automation; paste the new URL and resume it." Others: "Paste the new one into {app}." |
| Nothing arrived? (email) | ① Is forwarding confirmed (the confirmation mail shows in this room)? ② Does the filter match (open it and check its search)? ③ "Some senders' mail is refused when forwarded because their domain doesn't allow forwarding (DMARC). Forward with a filter on the original, or ask the sender to send to this address directly." |

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
 │ orders@shop.example   Shop Notices       │   outer From address, full weight; display name dimmed
 │ Email · Forwarded by mina@acme.example   │   kind line; tag "First mail from this sender" on a first
 │ [New order] #20261114-001 · 2 items      │   title: Subject
 │ Order date: 2026-11-14 09:14             │   details: first 3 meaningful lines
 │ Total: 45,000                            │
 │ 📎 invoice.pdf · 120 KB                  │   attachments: room files on this message
 └──────────────────────────────────────────┘
   Show the whole mail ›                         opens the plain text in the thread panel
```

- A display name that looks like an address, or is longer than 40 characters, is dropped.
- When a person forwards (the forwarder is the outer From), the original sender inside the body is shown only as a
  detail line **"Forwarded content claims: from orders@shop.example"**, never as the sender.

### Forwarding confirmation card (owner decision 7)

```
 ┌──────────────────────────────────────────────┐
 │ forwarding-noreply@google.com                │
 │ Gmail forwarding confirmation                │
 │ Confirmation code   123456789       [Copy]   │
 │ Or confirm: mail-settings.google.com ›       │   the only link an email card can carry
 └──────────────────────────────────────────────┘
```

- Only when **all** hold: the outer From is the provider's confirmation sender (Gmail, Outlook.com/Microsoft 365,
  Naver Mail; exact senders: live check), the Worker's own DMARC result is pass **for that provider's domain**, and
  the body matches the provider's template (the code pattern). Then the code shows large with Copy, and one link is
  clickable if its host is on the allowlist (`mail.google.com`, `mail-settings.google.com`; the Outlook and Naver
  hosts after the live check). Everything else in such a mail stays plain text. A mail that fails any check is an
  ordinary card with no link.
- It never counts as the "next real mail" for the sender-list offer.

### Email address row (P2)

```
 Integrations › Apps › Orders mail
 ┌──────────────────────────────────────────────┐
 │ Email address                                │
 │ [ orders-mail.r7k2…q4m@trina-mail.<tld> ] [Copy]
 │ Forward notices here and they appear in this │
 │ room. Anyone who knows it can send here.     │
 │ Attachments go to the room's files, visible  │
 │ to everyone in the room.                     │
 │ Regenerate                                   │
 │ Only accept mail from (optional)             │
 │ [ orders@shop.example ×] [+ Add]             │
 │ Matches the sender's From address.           │
 │ ✓ Last mail 09:15 · 12 today                 │
 └──────────────────────────────────────────────┘
```

- Address: a readable prefix from the app's name (`orders-mail`: ASCII slug ≤ 20, may be empty) + "." + 32 base32
  characters (160 random bits). Only the random part is the secret and the lookup key; the prefix is cosmetic.
- **Sender list (owner decision 6):** off by default; offered once on the **next real mail**, never on a provider's
  forwarding confirmation, a bounce, an auto-reply or a mail provider's system sender: "Only accept mail from
  orders@shop.example?". It matches the **outer header From** (the address on the card), never the envelope sender
  (forwarders rewrite it) and never "Forwarded content claims". When the Worker's own DKIM/SPF result is available
  (live check, "Sender authentication") the From's domain must also have an aligned pass; until then the row says
  "Checked by the From address only."
- **Guide, leading with a filter:** ① Copy the email address. ② In Gmail search for the notices (e.g.
  `from:orders@shop.example`) › **Create filter** › **Forward it to** › **Add forwarding address**. "Gmail sends a
  confirmation here first. It appears in this room within a minute, with its code." ③ Back in the filter, tick
  **Forward it to** and pick the address › **Create filter**. Behind "Forward every mail instead": the warning
  "Everyone in #{room} will see every mail you get." and the whole-inbox path (Settings › See all settings ›
  Forwarding and POP/IMAP), with "Gmail allows one address for forwarding all mail." Outlook/Microsoft 365: "Your
  admin may need to allow forwarding outside the company" (blocked by default). A shop or form that sends notices to
  any address: paste the address there directly.
- The guide says attachments go to the room's files, visible to everyone in the room (and people who join later).

### "Don't see your app?" (in the Other guide, P1)

Three lines at the top of the Other guide:
- "It emails you notices → use **Email**" (from P2; before P2 the line is hidden).
- "It has a field for a Slack, Discord or JANDI webhook URL → paste this Webhook URL there."
- "Neither → connect it with Zapier or Make" → the two how-tos (P1, text below in "Zapier and Make").

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
| `stripe` | Stripe-Signature `t=…,v1=…[,v1=…]` | HMAC-SHA256(secret, `t + "." + raw`) hex, any v1 matches, \|now − t\| ≤ 5 min; the secret is used as the literal `whsec_…` string (only Standard Webhooks base64-decodes) | Stripe |
| `zendesk` | X-Zendesk-Webhook-Signature `<b64>` + X-Zendesk-Webhook-Signature-Timestamp | HMAC-SHA256(secret, timestamp + raw) base64; the timestamp must parse as ISO-8601 or Unix seconds (anything else → 401) and be ≤ 5 min old | Zendesk |
| `toss` | tosspayments-webhook-signature `v1:<b64>[,v1:…]` + tosspayments-webhook-transmission-time | HMAC-SHA256(secret, raw + ":" + time) base64 | Toss Payments (regional) |
| `standard` | webhook-id, webhook-timestamp, webhook-signature `v1,<b64>` | Standard Webhooks: HMAC-SHA256(base64-decoded secret after `whsec_`, `id.timestamp.raw`) | PortOne V2 (regional) |
| `url-token` | `?token=` on the URL | the saved token equals the query value | Channel Talk (regional) |

Who makes the secret: **Trina makes it** where the vendor has a field to paste one in (Tally "Add a signing secret";
Typeform only if its UI has the field, live check), else **the person pastes the vendor's** (Stripe "Reveal secret",
Zendesk "Reveal secret", Shopify's key on the Webhooks page, Toss's key, PortOne's `whsec_`). Each pasted secret has
a shape check (`whsec_` + base64 for Stripe and PortOne; others: 16-200 printable characters) with a plain error
("That doesn't look like Stripe's signing secret."). Zendesk's documented **public test secret** (the one Zendesk
uses for "Test webhook" before a webhook exists; exact value from its docs at build time) is refused by `setSecret`.

Preset rules (security review):
- **`preset` is fixed at create** (`updateRoomApp` has no preset field); a different service is a new app. So a
  secret is never checked under another preset's scheme.
- `setRoomAppSecret` on a preset whose signing is `none` (Notion, Jotform, Jira, HubSpot, plain Other, Email) → 400
  `no_signing`.
- A row whose `preset` this build doesn't know (written by a newer build, then rolled back to an older newer-than-part-1
  build) is refused with 401 when it has a secret and 400 `invalid_payload` otherwise — never parsed as plain Other
  with a secret scheme guessed.
- Thread keys are always scoped per app (`room_app_threads` is keyed by `app_id` already; the keys below are within
  one app).

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
  (ko: "Slack, Discord, 잔디 웹훅 URL을 넣는 곳에 붙여 넣으세요.") Plus "Don't see your app?" and the Zapier/Make
  how-tos (both P1).
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
| guide (en) | Needs: a paid Notion plan. ① In Notion, open the database, choose ⚡ (Automations) › New automation. ② Pick a trigger, e.g. "Page added". ③ Add action › **Send webhook**; paste the URL; under properties **tick at least the title and Status**, then anything else the room should see. ④ Create. |
| guide (ko) | 필요: Notion 유료 요금제. ① Notion에서 데이터베이스를 열고 ⚡(자동화) › 새 자동화. ② 트리거 선택(예: "페이지 추가됨"). ③ 작업 추가 › **웹훅 보내기**; URL 붙여 넣기, **최소한 제목과 상태 속성을 선택**. ④ 만들기. (Korean labels: live check) |
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
- Dedupe `eventId` for **at least 7 days** (Tally retries up to a day later); thread `response:<responseId>`.
- Signature `b64-json`: Tally's sample computes base64 HMAC-SHA256 over `JSON.stringify(req.body)` (the parsed and
  re-serialised body), not the raw bytes. Trina tries the raw bytes first, then `JSON.stringify(JSON.parse(raw))`
  (Bun's and Node's `JSON.stringify` agree on key order and escapes). Tested with Tally's own sample in TC-1634.
  When signed, the card is built from **that same `JSON.parse` result** that was verified (never a second parse of
  the raw bytes, so duplicate keys can't make the shown content differ from the signed one), and a `createdAt` older
  than 2 days is refused (the signature has no timestamp; this bounds replay beyond the dedupe window).
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
| `subscription_ended` | `customer.subscription.deleted` | on |
| `subscription_new` | `customer.subscription.created` | off |

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
- Guide (Needs: Admin or Developer role in Stripe): ① Stripe › **Developers** › **Workbench** › **Webhooks** ›
  **Create an event destination**. ② Select the events shown as chips in this step, **Continue**, choose **Webhook
  endpoint**. ③ Paste the URL into **Endpoint URL**, **Create
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
  creation", Format "JSON", paste the URL, latest API version, **Save**. ③ **Optional:** repeat for "Order payment",
  "Order cancellation", "Refund create" (Shopify makes one webhook per event; the guide says so). Until one of these
  arrives, its switch reads "Not set up in Shopify" with a link back to this step. ④ Optional: copy the
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
- Dedupe on **sha256(raw)** within 10 min (a retry has the same body; the timestamp header is not part of the key,
  since it may change per retry) **plus** `id + status` within 10 min (the same change sent by two triggers posts
  once). Zendesk sends no delivery id.
- Robustness: placeholders are text inside quotes; if a title contains a quote and Zendesk does not escape it, the
  JSON breaks. The parser then tries a **tolerant read** of this preset's flat shape only (key-by-key between the known
  keys); if that fails too → 400, refusal "format", and the guide's "Nothing yet?" says "Use the body Trina gave you
  exactly". Live check decides whether the tolerant read is needed.
- Guide: ① Zendesk Admin Center › **Apps and integrations** › **Webhooks** › **Create webhook** › **Trigger or
  automation** › Next. ② Name "Trina", paste the URL into **Endpoint URL**, method **POST**, format **JSON**,
  **Create webhook**. ③ **Objects and rules** › **Triggers** › **Create trigger**: condition "Ticket is Created",
  action **Notify webhook** › Trina, and in the JSON body field paste the body — the **Copy body** button is in this
  step — Create. ④ Optional: a second trigger for "Ticket
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

### P1: Zapier and Make (how-tos under Other)

Not presets: two expanders in the Other guide ("Don't see your app?"), each with one worked example and its **Copy
body** inside the step where it is pasted. Shipped in P1 (text only; nothing changes on the server).
- Zapier (Needs: a paid Zapier plan): **Webhooks by Zapier** is a paid-plan app (Professional and up,
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
  not possible on Email Routing. **A separate apex domain only for mail in**, catch-all → the Email Worker (owner
  decision 8, pending the spending OK; the name visibly Trina's, e.g. `trina-mail.<tld>`). It also keeps the product
  domain's own mail, SPF and DMARC apart from mail anyone can send to. Written below as `trina-mail.<tld>`.
- Address: `<prefix>.<random>@trina-mail.<tld>`: `prefix` a readable ASCII slug of the app's name (≤ 20, may be
  empty, cosmetic), `random` 32 lowercase base32 characters (160 random bits; local parts are often lowercased by
  senders, so no mixed case). Only `random` is the secret and the lookup key. Separate from the Webhook URL token (it
  leaks differently, below).
- Stored like the token: `sha256(random)` for lookup, the full local part sealed in the vault for Copy again.
- **Regenerate** makes a new one; the old is removed from the gateway's table at once (the Worker's lookup is cached
  ≤ 60 s; the server also drops mail for an old local part, so nothing posts after Regenerate).
- **An email app has no Webhook URL.** It is created without an `/in/<token>` token that can post: `POST /in/<token>`
  on a row with `preset = 'email'` answers the same 404 as an unknown token (test in P2), so knowing an internal token
  never bypasses the mail path's checks.

### P2: hosted teams

```
 sender ──SMTP──▶ Cloudflare Email Routing (catch-all) ──▶ Email Worker (hosting repo)
                       │ DMARC p=reject/quarantine          1. local part shape; lookup sha256(random) → team
                       │ failures rejected by Cloudflare       (unknown → setReject: SMTP 550, no bounce from us)
                       │                                    2. rawSize ≤ 10 MiB else setReject
                                                            3. counters: per address, per team (count + bytes)
                                                            4. drop every incoming Authentication-Results and
                                                               ARC-* header; compute auth facts itself
                                                            5. seal raw message + facts to the team's key
                                                            6. store the sealed blob in R2 under the item id
                                                            7. POST to the team through the relay, signed
                                                               (on failure: queue only the pointer, retry ≤ 24 h)
 team server  POST /in/mail ◀─────────── relay ◀───────────┘
   verify gateway signature + audience, open, dedupe, store, answer; parse MIME in a job; post card + files
```

- Cloudflare checks DMARC before the Worker runs and rejects mail that fails a sender domain's **p=reject or
  p=quarantine** policy (domains with `p=none` or no DMARC are not rejected)
  (https://developers.cloudflare.com/email-routing/postmaster/,
  https://developers.cloudflare.com/email-routing/email-workers/).
- **Sender authentication (security review, blocker 1).** The Worker **removes every incoming
  `Authentication-Results` and `ARC-*` header** from what it seals and computes the facts itself into a separate
  sealed field `auth: {spf, dkim: [{domain, result}], dmarc, fromDomain}` — from Cloudflare's own verdict as exposed to
  the Worker. The team server reads authentication **only from that sealed field**, never from the message headers.
  **Live check (P2 first task):** whether an Email Worker actually sees Cloudflare's own result (the docs say
  Cloudflare prepends `Authentication-Results: mx.cloudflare.net`; a workerd issue (#6740) reports it may not reach
  Workers). If it does not, `auth` is `unknown`, the sender list matches the From address only and says so ("Checked
  by the From address only."), and DKIM/SPF are not used for anything until it does. The Worker never verifies DKIM
  itself (CPU and DNS cost; a later option).
- Card sender and the sender list use **only the outer header `From`** (exactly one From with exactly one address;
  0 or > 1 → the mail is posted as "(no valid sender)" and never matches a list). Forwarded originals are only
  "Forwarded content claims: …".
- Max inbound 25 MiB at Cloudflare; Trina's cap 10 MiB (setReject "Message too large for this address").
- Workers Free has 10 ms CPU, so the Worker **does not parse MIME** beyond the top-level headers it must remove: it
  checks size and the table, reads the raw stream, strips the auth headers, seals, stores, sends. Parsing happens on
  the team server (one parser for P2 and P3). Workers Paid ($5/month) for the CPU of sealing 10 MiB
  (https://developers.cloudflare.com/workers/platform/limits/,
  https://developers.cloudflare.com/workers/platform/pricing/).
- Registration: the team server registers each email app's `sha256(random)` (never the local part) with
  `POST /api/mail-in/v1/register` signed with its relay team key (as the Drive and Slack brokers); `unregister` on
  Regenerate/Remove; `status` lists what is registered (reconciled at start). Copy stays disabled until `register`
  answered ("Setting up the address…").
- Sealed item: `X25519-HKDF-SHA256-A256GCM` to the team's mail key (as the Slack token transfer); AAD = team id + item
  id + receive time + `sha256(random)`; plaintext = the raw RFC 822 bytes (auth headers removed) + `{envelopeFrom,
  auth, receivedAt, rawSize}`. The team's mail key: X25519, private key in the credentials vault (kind `mail_in_key`,
  key version, rekeyed with the rest), public key sent with `register`.
- **Storage of the sealed blob (security review, blocker 2):** Cloudflare Queues messages are capped at 128 KB, so the
  blob never goes on a queue. The Worker writes it to **R2 under the item id** (bucket private, lifecycle rule
  deletes objects after 24 h), then POSTs; on success it deletes the object. On failure it queues **only the pointer**
  (`{team, itemId, receivedAt}`), the consumer retries with back-off ≤ 24 h and deletes the object on success or at
  24 h, counting it as undelivered.
- Delivery: `POST https://<team address>/in/mail`, body = the sealed blob, `Authorization: TrinaMailIn
  <ed25519 signature>` over a signing string with **the audience** (`mail-in/v1`, the team id the gateway believes it
  is delivering to), item id, receive time and `sha256(body)`, by the **gateway key**, whose public keys are pinned in
  `shared/src/cloud-protocol/mail-in.ts` (two allowed for rotation, as the push gateway). The server refuses: a bad
  signature or another team's id (401); a receive time older than the dedupe retention (24 h) or more than 5 min in
  the future (401); a duplicate item id → 200, nothing posted (dedupe ≥ 24 h in `room_app_mail_items`).
- **Routing on the server (security review 7):** `/in/mail` is matched **before** `/in/:token` (a fixed path, never a
  token), with its own body cap (**12 MiB**: the 10 MiB mail + sealing overhead; the relay's WebSocket frames carry up
  to 16 MiB, `relay/src/relay.ts BUN_MAX_WS_MESSAGE`, so this fits) and its own limiter (per minute, after the
  signature). `http/middleware.ts isAppInbound` matches only the token form today; the country/IP exemption gets a
  second exact match for `POST /in/mail` (still only while the team has an email app).
- The `/in/mail` answer is sent once the item is stored (the opened item in a small job table); MIME parsing runs from
  that job, so a slow parse never holds the gateway.
- **Never log `message.to`** (the local part is the secret) in the Worker or the server; logs carry `sha256(random)`
  prefixes only.

### P3: self-installed servers (the mailbox)

As sketched in part 1 ("Phase 2: the mailbox"), now with mail as its first user:
- A self-installed server **with** the relay or its own public address gets P2's push (the gateway POSTs to its team
  address). A registered server **without** a public address pulls: `POST /api/mail-in/v1/poll` (signed long poll
  ≤ 25 s), `POST /api/mail-in/v1/ack` signed over **the ids and the time** (so an ack can't be replayed to delete
  other items); the mailbox deletes an acked item at once. At least once: the server dedupes item ids for ≥ 24 h.
- The items are the same R2 objects as P2 (sealed, 24 h lifecycle); the mailbox keeps the index (team → item ids).
- Keys in the vault (above); team id + item id + time in the AAD (no replay under another team, id or time).
- Retention ≤ 24 h, no backups; expired items counted → "{n} mails expired while this server was offline." on the
  app's status line.
- Abuse caps at the mailbox: held items per team ≤ 2,000 or 200 MB; a server that has not polled for 7 days stops
  receiving (the gateway rejects at SMTP: "This address is not receiving mail right now.") and the status line says so
  when it polls again.
- Servers not registered with the hosting service: no email in ("Email in needs this server to be connected to Trina's
  hosting service." on the picker row, as part 1's "no public address" state).

### What the cloud sees (docs/for-admins and Admin › Connection, stated plainly)

- The mail service sees each mail **in clear while receiving it** (SMTP has no end-to-end encryption to us): sender,
  recipients, subject, body and attachments, in the Worker's memory until it seals the item.
- **The Cloudflare dashboard's Email Routing activity log shows each mail's sender, recipient (the address) and
  subject** to whoever runs the hosting account; that is outside the sealing.
- At rest: the sealed blob in **R2 for ≤ 24 h** (deleted on delivery), the queue pointer, the mailbox index, the
  address hash, size, time, the sending server's IP and the auth facts for limits (logs 7 days).
- **For hosted teams sealing protects only the queue and R2:** the team server runs on the hosting service's own
  machines, so the operator who could read the store could also read the team. For self-installed servers sealing
  means the hosting service cannot read stored mail.
- The cloud could, while receiving, drop, delay or inject mail — no more than any sender can, because mail is never
  shown as verified.

### Parsing on the team server (`server/src/rooms/apps/mail/*`)

- **MIME:** `postal-mime` (MIT, no Node built-ins; runs in Bun) with a size check first and its limits
  (`maxPartCount` 200, `maxNestingDepth` 20, headers ≤ 256 KB); a library choice check in P2 (license in NOTICE).
  Its default charset handling (UTF-8, windows-1252 fallback) is replaced by our decoder:
- **Charsets** (`mail/charset.ts`): `TextDecoder` where the runtime supports the label (Bun: a test per label), else a
  vendored table decoder. Labels and aliases tested: UTF-8, **EUC-KR / CP949 / `ks_c_5601-1987`** (Outlook's Korean
  label = CP949), **ISO-2022-KR** (stateful: `ESC $ ) C` designator, SO/SI shifts; decoded by setting the high bit on
  shifted bytes and reading EUC-KR), ISO-2022-JP, Shift_JIS, EUC-JP, GB2312/GBK/GB18030, Big5, ISO-8859-1..15,
  windows-1250..1258, KOI8-R, UTF-16. **UTF-7 is never decoded** (shown as its ASCII; it is a known filter bypass).
  Unknown → UTF-8 with replacement characters, never a refusal.
- **Encodings:** RFC 2047 encoded words in headers (B and Q, adjacent words joined, split multibyte sequences across
  words handled per charset run), RFC 2231 file names (`filename*=UTF-8''…`, and the common broken raw-UTF-8/EUC-KR
  names), quoted-printable and base64 bodies, 7bit/8bit, `format=flowed`.
- **Address headers (Mailsploit class, security review 9):** the address part (`addr-spec`) is parsed **before** any
  decoding and RFC 2047 is **never** decoded inside it (only in the display name); NUL, C0/C1 controls, bidi and
  zero-width characters are stripped from every shown header; exactly one From with one mailbox, else "(no valid
  sender)"; an IDN domain is shown in punycode when it mixes scripts (e.g. Latin + Cyrillic), in Unicode otherwise.
- **Which body:** `text/plain` if it has real text, else `text/html` → plain text (scripts, styles, head and hidden
  elements removed; block elements to line breaks; table cells joined with " · " so an order table stays readable;
  entities decoded; a node budget). **HTML-only mail** (most shop notices) goes this way. Remote images and links are
  never fetched.
- **Forwarded mail:** a `message/rfc822` attachment (forward as attachment) or an inline forward ("---------- Forwarded
  message ---------", "Begin forwarded message:", "-----Original Message-----", "전달된 메시지", "원본 메시지",
  "転送されたメッセージ") is detected; its From/Subject/Date become detail lines "Forwarded content claims: from …"
  (never the sender), and the kind line reads "Email · Forwarded by {outer From address}".
- **Card:** the outer From **address first, full weight**, the display name dimmed (dropped when it looks like an
  address or is > 40 characters); a "First mail from this sender" tag when this app never saw that address; title =
  Subject (≤ 200; "(no subject)"); details = the first 3 meaningful lines (greetings, "This is an automated message",
  signature separators skipped by a small list); plain text ≤ 20,000 characters ("Show the whole mail" opens it).
  **No link on the card** and links in the text are shown as text (owner decision 7), except the forwarding
  confirmation card's one allowlisted link. Never a person, never "verified"; a From that matches a team member's
  address is **not** linked to that member.
- **Thread key:** the root of `References` / `In-Reply-To` (a reply chain stays in one thread), per app; else none.
  **Delivery key (security review 12):** `Message-ID` + sha256(body) (a resent mail with a reused Message-ID but
  another body still posts; an exact resend doesn't), 7 days in `room_app_deliveries`.
- **Forwarding confirmations** (Gmail https://support.google.com/mail/answer/10957, Outlook, Naver Mail): the special
  card in "UX" when the outer From is the provider's sender and the Worker's DMARC result passes for that domain.
- **Auto-replies:** `Auto-Submitted: auto-replied` or a vacation subject pattern → skipped (loops with forwarding
  rules); bulk/list mail is kept (shop notices are bulk).
- Switches: `mail` on, `attachments` on, `auto_replies` off.

### Attachments → room files

- Kept: ≤ 5 files per mail, each ≤ 10 MiB, types by **content sniffing**, not the name: PDF, PNG/JPEG/GIF/WebP/HEIC,
  Office Open XML (docx/xlsx/pptx), HWP/HWPX, CSV, TXT, ICS.
- **File names (security review 10):** NFC-normalised; bidi, control and zero-width characters and path separators
  (`/ \ :`) removed; leading dots removed; ≤ 120 characters keeping the extension; Windows reserved names (`CON`,
  `NUL`, `COM1`…) prefixed; **the extension is forced to the sniffed type** (`invoice.pdf.exe` sniffed as PDF →
  `invoice.pdf.pdf`; a PDF named `.docx` → `.pdf`).
- **Zip-based files (security review 11):** only the central directory is read, **never inflated**. OOXML with
  `vbaProject.bin`, an `embeddings/` folder or `externalLink` parts → dropped (macros, OLE objects, remote links).
  HWPX the same check. Plain archives (zip, 7z, rar, alz, egg) dropped.
- Dropped too: executables, scripts, HTML/SVG/XML, legacy OLE Office (`.doc/.xls/.ppt`), `winmail.dat` (TNEF),
  disk images, unknown types. Dropped files are named on the card ("2 attachments not kept: setup.exe, archive.zip").
- **HWP/HWPX from mail: download only, no preview** (the HWP preview renderer is not given mail-borne files).
  Encrypted PDFs are kept, never previewed.
- Inline images referenced by `cid:` are dropped (signatures, logos) unless also listed as attachments.
- Stored through `rooms/files.ts create` with `user_id` NULL, `message_id` = the card: the same `.system/rooms/` place,
  the room-membership check on every read (a person who left the room reads nothing, as for any room file), the
  sandbox CSP, the download-only list, the quarantine list by hash, the team storage check (a full team: files
  dropped, the card says so). One mail = one message for the caps.

### Spam and abuse caps

| limit | value | where |
|---|---|---|
| unknown local part | SMTP 550 at once; Trina never generates a bounce (no backscatter) | Worker |
| mail size | 10 MiB → SMTP reject | Worker |
| per address | 60 / hour, 300 / day accepted; over → accepted and dropped, counted (an Email Worker's reject is permanent) | Worker (Durable Object counter) |
| per team, all mail apps | 2,000 mails / day **and 200 MB / day** | Worker |
| per sending IP to unknown addresses | 30 / minute, then reject everything from it for 10 min | Worker |
| whole gateway | a spend alarm on Workers/R2/Durable Object usage (Cloudflare billing notification), owner paged | hosting account |
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

**Rollback note for 401 (security review).** Rolling the server back to a build before P1 keeps the column but
ignores it, so every preset row is read as plain `other`. Such a build checks a saved secret against
`Sentry-Hook-Signature` for every non-GitHub kind (`rooms/apps/inbound.ts`), so **Stripe, Shopify, Zendesk and Tally
apps with a saved secret answer 401** and their vendors retry and then disable or delete the webhook (Shopify after 8
failures, Stripe after 3 days). Unsigned preset apps keep posting as Other cards with a `format` refusal for most
bodies. It fails closed (nothing is posted wrongly), but the vendor setups may need redoing: say so in the release
notes of any rollback past P1, and prefer rolling forward.

**`402_b_room_app_mail.sql` (P2)**:

```sql
-- email in: an email app is kind 'other' + preset 'email'; it has no usable /in/<token> (refused as unknown).
CREATE TABLE room_app_mail (
  app_id TEXT PRIMARY KEY REFERENCES room_apps(id) ON DELETE CASCADE,
  local_hash TEXT NOT NULL UNIQUE,          -- sha256 of the random part (the gateway knows only this)
  local_enc TEXT NOT NULL,                  -- the full local part (prefix.random), vault kind 'room_app_mail_local', app id in the AAD
  key_version INTEGER NOT NULL,
  senders TEXT NOT NULL DEFAULT '[]',       -- "Only accept mail from": outer From addresses or @domains, ≤ 20
  offered_sender INTEGER NOT NULL DEFAULT 0 CHECK(offered_sender IN (0,1)), -- the one-time offer was shown
  registered_at TEXT,                       -- the gateway acknowledged it (NULL: pending; Copy disabled)
  undelivered INTEGER NOT NULL DEFAULT 0,   -- mails the gateway gave up on (status line), reset when seen
  last_mail_at TEXT
);
-- senders seen per app, for the "First mail from this sender" tag (sha256 of the lowercased address; 90 days)
CREATE TABLE room_app_mail_senders (app_id TEXT NOT NULL REFERENCES room_apps(id) ON DELETE CASCADE,
  sender_hash TEXT NOT NULL, first_at TEXT NOT NULL, PRIMARY KEY (app_id, sender_hash));
-- gateway/mailbox items received (at least once delivery) and their parse job: the opened item waits here until the
-- job posts it (state 'stored' → 'done' / 'failed'); the item is deleted after the job, the id kept ≥ 24 h, pruned at 7 days
CREATE TABLE room_app_mail_items (item_id TEXT PRIMARY KEY, app_id TEXT, at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'stored' CHECK(state IN ('stored','done','failed')), path TEXT);
CREATE INDEX room_app_mail_items_at ON room_app_mail_items(at);
-- the team's mail key (one row): X25519, private key sealed in the vault (kind 'mail_in_key'), rekeyed with the rest
CREATE TABLE mail_in_keys (id INTEGER PRIMARY KEY CHECK(id = 1), public_key TEXT NOT NULL, private_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL, created_at TEXT NOT NULL);
```

(`path`: the opened item is written to `<team>/.system/mail-in/<item id>` (0600) for the job, deleted once posted.)

**P3:** no migration expected (poll state is in memory; expired counts come from the mailbox's status). If one is
needed: `403_b_…`. An Activity notice for "stopped receiving" would need its own notice table (fixed CHECK lists):
`353_c_room_app_mail_notices.sql` (C's next free number) only if the owner wants a notice and not just the status line.

`credentials/rekey.ts`: `room_app_mail.local_enc` and `mail_in_keys.private_enc` join `rekeyRoomApps`.

## API

`shared/src/api/room-apps.ts`:
- `RoomAppPreset = z.enum(['notion','typeform','tally','jotform','stripe','shopify','zendesk','email','jira','hubspot',
  'toss_payments','channel_talk','portone'])` (P1 the first seven; P2 `email`; P4 the rest).
- `RoomApp.preset?`, `RoomAppRef.preset?` (optional: older clients ignore them and show "Other app" with the name).
- `CreateRoomAppBody` gains `preset?` (only with `kind: 'other'`; 400 otherwise). `UpdateRoomAppBody` has **no**
  preset: it is fixed at create.
- `ROOM_APP_PRESET_SWITCHES[preset]` beside `ROOM_APP_SWITCHES`; `ROOM_APP_PRESET_NAMES`; `ROOM_APP_PRESET_SIGNING`
  (`none` | `trina_makes` | `paste`, with the shape regex) and `ROOM_APP_PRESET_NEEDS` (the "Needs: …" key).
- `SetRoomAppSecretBody`: unchanged shape; the server checks the secret by the app's preset; 400 `no_signing` on a
  preset with signing `none`; Zendesk's public test secret refused.
- `RoomAppAddress` gains `email?: string` and `registered?: boolean` (email apps: the address instead of `address`;
  Copy disabled while `registered` is false).
- New `PUT /api/rooms/:id/apps/:appId/senders` `{ senders: string[] ≤ 20 }` (email apps only, 400 otherwise; WHO as
  the rest; audited without the addresses).
- New `GET /api/rooms/:id/apps/:appId/messages/:messageId/mail` — "Show the whole mail": the plain text (≤ 200,000
  characters), checked like a room message read (in the room now, may see the message).
- `roomAppZendeskBody()`, `roomAppJiraBody()`, `roomAppZapierBody()` beside `roomAppFormsScript()` (Copy body texts).
- Not under `/api`: `POST /in/<token>` (unchanged path, new presets; 404 for an email app), `POST /in/mail`
  (gateway-signed sealed item, matched first).
- `shared/src/cloud-protocol/mail-in.ts` (MIT, erasable TS, no imports): register/unregister/status/poll/ack bodies,
  the `TrinaMailIn` signing string (audience, team id, item id, receive time, body hash) and the `TrinaMailbox` one
  (polls; acks over ids + time), the sealed item layout and AAD, the gateway public keys, error codes, test vectors in
  `vectors/`.
- `docs/features.ts`, `bun run docs:api`, `tests/security/lib/room-apps-cases.ts` (below).

### Permission matrix additions (`tests/security/lib/room-apps-cases.ts`)

| action | team room: owner/admin in it | team room: member | 1:1 / group: member | not in the room / left |
|---|---|---|---|---|
| See or Copy an email app's address, Regenerate it | yes | 403 | yes | 404 |
| Set "Only accept mail from" | yes | 403 | yes | 404 |
| "Show the whole mail" of a mail card | yes | yes | yes | 404 (a leaver reads nothing after leaving) |
| Read a mail attachment (room file) | yes | yes | yes | 404, as every room file |
| `POST /in/<token>` on an email app's internal token | 404 for everyone (same body as unknown) | | | |
| `setRoomAppSecret` on a no-signing preset | 400 `no_signing` | 403 | 400 `no_signing` | 404 |
| `POST /in/mail` without, with a wrong, or another team's gateway signature; a replayed item id; a stale receive time | 401 / 401 / 401 / 200 nothing posted / 401 | | | |

## Security analysis

**Presets (P1/P4)**
- Spoofing: as part 1. A preset without a signature (Notion, Jotform, JANDI-shaped Other, Jira, HubSpot) is as safe as
  its URL; the Signing secret closes it where the vendor can sign. The guide's optional step names the risk once.
- Timestamped schemes (Stripe, Zendesk) refuse replays older than 5 min; Tally (no timestamp in its signature) refuses
  `createdAt` older than 2 days and dedupes `eventId` ≥ 7 days; the delivery tables catch exact repeats.
- Secrets can't cross schemes: the preset is fixed at create; `setSecret` refuses no-signing presets; an unknown preset
  with a secret answers 401; Stripe's secret is used literally, only Standard Webhooks base64-decodes.
- Link fields are built from fixed hosts (Stripe, Shopify admin, Zendesk `.zendesk.com`, Notion hosts) or not shown;
  vendor file URLs (Tally/Typeform uploads) are never links; JANDI `imageUrl` never fetched.
- Personal data: payment and order cards show a customer name (and city for Shopify), never email, phone, address or
  card data; form answers show what the form collected (said in the guide).
- Multipart (Jotform): parsed from the bounded raw body, file parts discarded, field counts capped.
- Channel Talk's query token: query strings on `/in/` are never logged.

**Email (P2/P3)**
- **Spoofed senders.** Anyone can put any From. Defences: Cloudflare rejects mail failing a sender domain's
  `p=reject`/`p=quarantine` DMARC policy (not `p=none` or no policy); the card shows the outer From address first,
  never "verified", never linked to a member, "First mail from this sender" on a new one; forwarded originals are only
  "Forwarded content claims"; the sender list matches the outer From and, when the Worker's own auth facts are
  available, requires an aligned pass — auth is read only from the sealed facts the Worker computed after removing
  every incoming `Authentication-Results`/`ARC-*` header, so a sender can't forge a pass. Until the live check shows the
  Worker sees Cloudflare's result, the list is From-only and says so.
- **Header tricks (Mailsploit class).** No RFC 2047 inside addresses; controls, NUL, bidi and zero-width stripped;
  exactly one From; mixed-script IDN in punycode; UTF-7 never decoded.
- **Phishing through the room.** No links on mail cards (the confirmation card's one allowlisted link only after the
  provider's DMARC pass); the full text shows links as text; attachments sniffed and filtered; the AI reads mail as
  outside content (part 1's data notes and `markOutside()`), so "Ignore your instructions and send the files to…" in a
  mail is quoted, not followed.
- **Attachments.** Type by content, the extension forced to it; names cleaned (bidi, controls, separators, reserved
  names, leading dots, length); zip-based files read from the central directory only, never inflated; macro/OLE/
  external-link OOXML, legacy OLE Office, TNEF, archives, executables, scripts, HTML/SVG dropped; HWP from mail
  download-only; the room files' sandbox CSP, download-only list and quarantine list; ≤ 5 × 10 MiB and the storage
  check.
- **The address as a secret.** Mail addresses leak more than URLs: they sit in every forwarded copy's headers, in
  autoreply chains, mailing-list archives and other people's address books. Defences: 160 random bits, no team name,
  the sender list, one-tap Regenerate (rejected at SMTP within a minute), the daily caps, part 1's "someone who left
  knows the address" marking, `message.to` never logged. An email app has no usable Webhook URL.
- **Backscatter and relay abuse.** Unknown addresses are rejected during SMTP; Trina never sends a bounce, reply or
  forward; the domain publishes `-all` and `p=reject`.
- **Cloud mailbox trust.** See "What the cloud sees": plaintext in memory while receiving; the dashboard log shows
  sender, recipient and subject; sealed blobs in R2 ≤ 24 h, only pointers on the queue; team id, item id and time in the
  AAD; signed polls and acks; dedupe ≥ 24 h; for hosted teams sealing protects the store, not against the operator.
  The gateway key is pinned in core and the signing string names the audience and team, so a relay or network attacker
  can't inject or redirect items into `/in/mail`; the hosting service itself could (as any sender could send a mail).
- **DoS and cost.** SMTP-time rejects; the Worker's counters (count and bytes per team) before reading the body; a
  spend alarm on the hosting account; the server's own `/in/mail` body cap (12 MiB) and limiter; MIME limits (parts,
  depth, header size), the 10 MiB cap, HTML-to-text with a node budget; parsing in a job, off the request path.

## Phases (each mergeable to dev alone)

**P1 — JANDI in Other + global presets (TC-1634).** `feat/room-apps-presets`. **Buildable now: no mail code, no
cloud contract, no domain.** Migration 401; `presets/*` (notion, typeform, tally, jotform, stripe, shopify, zendesk);
`signatures.ts` (hex-body, b64-body, b64-json, stripe, zendesk); preset fixed at create, `no_signing`, the Zendesk test
secret; multipart for Jotform; JANDI in `other()`; query string out of `/in/` logs; API fields; picker groups with
"Needs" lines, logos (each vendor's brand guidelines checked; letter tile fallback), guides with Copy body inside its
step, the states table, cards; "Don't see your app?" and the Zapier/Make how-tos; the Slack words (Webhook URL / Copy /
Regenerate, Integrations › Apps, APP) and the flipped i18n test; 5 languages; samples and tests per preset (incl. a
Tally duplicate-key body, a Zendesk non-date timestamp, a secret on a no-signing preset, an unknown preset with a
secret); `docs/features.ts`; `changes/room-apps-presets.md`; the 401 rollback note in DECISIONS. Live check per vendor
with screenshots before the copy is final. Checks: typecheck, area unit tests, `check:i18n`, `check:docs`, full web
e2e (shared room code).

**P2 — email in, hosted (TC-1635). Starts after the owner's domain OK.** `feat/room-apps-mail` (core) + the hosting
repo's Worker. First task: the workerd auth-result live check. The mail domain; migration 402; `mail/*` (MIME,
charsets, address parsing, HTML to text, forward detection, attachments and names, the confirmation card); `/in/mail`
matched first, its cap, limiter and signature; the job table; the key and registration; the email preset UX (address
row with prefix, Copy disabled until registered, sender list and its offer, filter-first guide, "Nothing arrived?");
`cloud-protocol/mail-in.ts` + vectors; Worker (catch-all, table, counters incl. bytes, auth-header removal, seal, R2,
push, pointer queue, spend alarm). Tests: a corpus of real-shaped mails (fake data) per charset and encoding (EUC-KR,
CP949 `ks_c_5601-1987`, ISO-2022-KR, ISO-2022-JP, Shift_JIS, GB2312, Big5, UTF-8 QP/base64, UTF-7 not decoded),
HTML-only, `message/rfc822`, inline forwards, Mailsploit-style From headers (encoded `@`, NUL, two Froms, bidi), a forged
`Authentication-Results` (ignored), a Gmail confirmation with and without DMARC pass, a 10 MiB attachment, a zip, an
exe renamed .pdf, an xlsx with `vbaProject.bin`, `winmail.dat`, a Windows reserved name; `/in/<token>` on an email
app → 404; the sealed item round trip with the vectors; `/in/mail` signature, audience, stale time and replay.

**P3 — email in, self-installed (TC-1635). After P2.** `feat/room-apps-mailbox`. The poller (`mail/mailbox.ts`, like
the Slack broker's), acks signed over ids + time, expiry counts, the "not connected" state, Admin › Connection wording,
docs/INSTALL-LINUX.md and docs/OFFICE.md. Hosting repo: the mailbox index over the R2 items, poll/ack, retention, the
7-day stop. QA on a registered server without a public address, and with the relay (push path).

**P4 — Jira, HubSpot and the regional group (TC-1634).** `feat/room-apps-presets-2`. Jira (Copy body), HubSpot
(paid-tier "Needs" line); then Toss Payments (`toss`), Channel Talk (`url-token`), PortOne (`standard`) under "Show
more services".

## Live checks (cannot be verified without an account)

| service | what |
|---|---|
| JANDI | the creation labels in JANDI itself (seen only in a third-party help page); that JANDI-compatible senders accept `200 ok` |
| Notion | the envelope (ids, attempt), property shapes, Korean labels, which plans show "Send webhook" |
| Typeform | a secret field in the UI; Connect › Webhooks labels; plan needed |
| Tally | the exact `data` keys; that the raw bytes or the re-stringified body verifies with a real signing secret |
| Jotform | content type; `formID`/`formTitle`/`pretty`; Korean labels |
| Stripe | the event names in the picker; the roles that can create destinations; Korean dashboard labels; the payments link |
| Shopify | which key signs admin-created webhooks and where it is shown; the staff permission needed; the admin order link; Korean labels |
| Zendesk | whether placeholders are JSON-escaped in a JSON body; `{{ticket.latest_public_comment}}`; the timestamp header format; the public test secret value; Korean labels |
| Jira | `.jsonEncode`, `{{triggerType}}`, the 2026 automation limits |
| HubSpot | the property list in "Customize request body"; the record link |
| Toss / Channel Talk / PortOne | which Toss events are signed; Channel Talk's Korean menu path and desk link; PortOne header names |
| Email gateway | **whether an Email Worker sees Cloudflare's own SPF/DKIM/DMARC result** (workerd issue #6740; decides whether the sender list can use auth); R2 lifecycle and Queues limits on the account; the dashboard log's fields |
| Email providers | Gmail's confirmation (link vs code) and its sender address; Outlook.com/Microsoft 365 and Naver Mail confirmation senders, templates and link hosts (for the allowlist); Daum/Kakao forwarding; Microsoft 365's admin switch wording; Bun's `TextDecoder` labels; whether common shop and form tools email the owner notices (nothing official found for several; a real admin screen is needed) |

## Effort

| phase | estimate |
|---|---|
| P1 presets + JANDI + words + Zapier/Make how-tos (incl. live checks and screenshots) | 7 days |
| P2 email in, hosted (core 3.5, Worker 2.5, domain + QA 1) | 7 days |
| P3 mailbox (core 1.5, hosting 2) | 3-4 days |
| P4 Jira, HubSpot | 1.5 days; regional group +2 days |
| total | about 20-22 days of one developer with agents, plus QA |

## Owner answers and what is still open

1. Other app last, after a divider, with Email in the same final block — **owner: yes** (decision 5).
2. "Only accept mail from" off by default, offered after the next real mail — **owner: yes** (decision 6), with the
   fixes: never for system or confirmation senders, matches the outer header From.
3. No links on email cards — **owner: yes** (decision 7), except a provider's forwarding confirmation that passes
   DMARC for the provider's domain: the code large with Copy and one link on an allowlisted host
   (`mail.google.com`, `mail-settings.google.com`; others after the live check).
4. **Still open — a separate mail domain** (decision 8): Cloudflare allows a catch-all only on an apex domain.
   Recommend: buy a short domain visibly tied to Trina (`trina-mail.<tld>`) and put the Worker on Workers Paid
   ($5/month) plus R2 (cents at this volume). Needs the owner's spending OK and the name. P1 does not wait for it.

## Changes in revision 2

- UX: forwarding-confirmation card (code + Copy, one allowlisted link, only on the provider's DMARC pass); the sender
  list never offered for system/confirmation senders, matches the outer From (said on the row); filter-first email
  guide, whole-inbox behind a warning, Gmail's one forward-all address; "Needs: …" on picker rows and guide headers;
  groups FORMS · PAYMENTS & ORDERS · WORK · FOR DEVELOPERS · "Show more services" · ANY OTHER WAY (Email, Other);
  "Don't see your app?" and the Zapier/Make how-tos moved to P1; a states table (address not registered, gateway down,
  secret refused per preset, per-vendor Regenerate warnings, DMARC in "Nothing arrived?"); email card with the address
  first, dimmed name, "First mail from this sender", "Forwarded by …"; Copy body inside its step; Notion "tick at least
  the title and Status"; Shopify's extra events optional with "Not set up in Shopify"; attachments visible to the room
  said in the guide; readable address prefix + 160-bit random part; Stripe `subscription.deleted` on, `created` off.
- Security: card sender and sender list from the outer From only; the Worker strips incoming
  `Authentication-Results`/`ARC-*` and computes auth itself, the server reads it only from the sealed facts, with a
  live check of the workerd issue; sealed blobs in R2 with only pointers on the queue (128 KB cap), added to "what the
  cloud sees"; Tally dedupe ≥ 7 days, `createdAt` ≤ 2 days, content from the verified parse; Zendesk timestamp
  parsing, dedupe on the body + id/status, the public test secret refused; preset fixed at create, `no_signing`,
  unknown preset + secret → 401, Stripe's secret literal; email apps refuse `/in/<token>`; `/in/mail` matched first
  with its own cap (12 MiB, under the relay's 16 MiB frames), limiter, audience and team in the signed string, stale
  times refused, acks signed over ids + time; a per-team byte cap and a spend alarm; Mailsploit defences; attachment
  name cleaning and extension forcing; zip central directory only, macro/OLE/external-link OOXML, legacy OLE, TNEF
  dropped, HWP download-only; delivery key Message-ID + body hash, thread keys per app; `message.to` never logged; the
  dashboard log and the hosted-team sealing limit stated; DMARC wording limited to `p=reject`/`p=quarantine`; the 401
  rollback note; permission matrix additions; the Stripe "mailbox time" line removed.
- P1 explicitly buildable without the domain decision; P2/P3 wait for it.

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
