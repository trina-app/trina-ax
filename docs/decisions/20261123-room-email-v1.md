# Email into rooms: one pull path for every server, off by default, sender never verified

- Date: 2026-11-23
- Status: accepted
- Supersedes: the "Email in" design of plan 20261114-1522-room-apps-presets-email (push to `/in/mail` for hosted teams)
  for v1; the room apps plan's "Phase 2: the mailbox" is built here
- Branch: feat/room-email-v1 (plan [20261123-0421-room-email](../AGENTS/plan/20261123-0421-room-email.md); the product
  owner asked on 2026-11-23, the owner said build v1 with the plan's recommendations)

- **Ask:** each conversation gets its own email address; mail forwarded there shows as cards for the whole room; a
  leaked address is replaced in one click.
- **Rule:**
  - An Email app is a room app with kind `other` and preset `email` (older apps read it as an Other app). Its address
    is `<26 random lowercase base32 characters>@<mail domain>`; the random part is stored like a Webhook URL token
    (sealed in the vault, its sha256 for lookup) and is never a Webhook URL (`/in/<it>` answers 404).
  - **Every server pulls mail** from the hosting service's mailbox (`shared/src/cloud-protocol/mail-in.ts`): the mail
    gateway seals each mail to the team's X25519 key, the server long-polls, opens, posts and acknowledges. No team
    server runs SMTP. A server without `MYCEL_MAIL_IN_URL` and `MYCEL_MAIL_IN_DOMAIN` has no Email.
  - **Off by default** (`TeamSettings.roomEmail`). Off sends the mailbox an empty address set (mail is refused at
    SMTP) and posts nothing that was queued.
  - The server posts a mail only when its hash is the app's **current** address: "Get a new address" and Remove stop the
    old address here at once; the mailbox refuses it at SMTP once the next sync reaches it (seconds; retried with
    back-off). The plan's "fail the rotate when the mail service is down" was not taken: the old address must stop
    even then.
  - The card is plain text: the outer From (exactly one address, else "(no valid sender)") always "(unverified)", the
    subject, the first two lines, the attachments by name and size (not kept in v1), no link. HTML is turned into text
    on the server; remote content is never loaded. The whole text (≤ 20,000 characters) is the message body, which the
    AI reads as outside data (APP_DATA_NOTE names forwarded mail).
  - A provider's forwarding confirmation (Gmail; Outlook best effort) is not a card: its code goes to
    `RoomApp.mail.confirmation` for the people who manage the app (7 days) and the room gets one quiet line without it.
  - Out-of-office answers (Auto-Submitted and the usual headers) are skipped unless the app's switch is on.
  - One Email app per room. The apps' limits, day caps, Quiet, audit and permissions apply unchanged.
- **Why:** a sleeping trial team, a restart and an office server all need a queue once the gateway accepted a mail
  (SMTP 250 ends the sender's retries); one pull path covers them all. Forwarding breaks SPF, so no sender can be shown as
  verified.
- **Left out of v1:** keeping attachments as room files, "View original", reply by email, an "only accept mail from"
  list, a readable prefix, custom domains. Deploying the mailbox (domain, DNS, Cloudflare): the owner's runbook
  [room-email-mailbox](../runbooks/room-email-mailbox.md).
- **Tests:** `tests/unit/b-room-email.test.ts` (fake mailbox and the reference mailbox end to end),
  `tests/unit/mailbox-gateway.test.ts`, `tests/unit/mailbox-api.test.ts`, `web/test/unit/room-apps-email.test.tsx`, the
  room apps permission cases.
- Version impact: **minor** (a new feature behind a switch, add-only migration 445, optional API fields).

## Change 2026-11-23: the mail service runs on Amazon SES

Dion and the owner chose Amazon SES receiving on `in.trina.app` (account engine-trina, us-east-1) instead of Cloudflare
Email Routing, which takes a catch-all only on an apex domain. The contract and the team server are unchanged. One
difference for senders: SES accepts every address of the domain, so a mail to an unknown or replaced address, or over
10 MiB, is dropped without a bounce (no 550/552). Plan section "Change 2026-11-23"; code `mailbox-ses/`.
