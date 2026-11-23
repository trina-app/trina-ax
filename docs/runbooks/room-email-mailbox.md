# Runbook: put the room email mailbox into service

- For: the owner or the operator of the hosting service.
- Status: **not done**. The code in `mailbox/` and the team server support are built and tested locally only. Nobody
  has changed Cloudflare, DNS, MX records or a production service for this feature.
- Plan: [docs/AGENTS/plan/20261123-0421-room-email.md](../AGENTS/plan/20261123-0421-room-email.md). Contract:
  [shared/src/cloud-protocol/mail-in.ts](../../shared/src/cloud-protocol/mail-in.ts). Code: [mailbox/](../../mailbox/README.md).

Do the steps in this order. Each step says how to check it. Stop if a check fails.

## 1. Choose the mail domain

1. Decide which domain the room addresses use (`<random>@<mail domain>`).
2. **Check this first:** an earlier plan found that Cloudflare Email Routing allows a catch-all rule only on an
   apex domain, not on a subdomain, and allows at most 200 routing rules per domain. If that is still true, the plan's
   `in.trina.app` cannot work, and you need a **separate apex domain** only for mail in (for example
   `trina-mail.<tld>`). Read the current Cloudflare Email Routing documentation (subdomains, catch-all, limits) and
   decide.
3. Keep the product domain's own mail as it is. Do not change the MX records of `trina.app`: its mail goes to another
   provider today.
4. If you buy a new domain, add it to the hosting service's Cloudflare account.

Check: the domain is in the Cloudflare account and has no other mail use.

## 2. Turn on Email Routing for the mail domain

1. In the Cloudflare dashboard, open the mail domain, then **Email › Email Routing**, and turn it on.
2. Cloudflare adds its MX records. Keep them as Cloudflare gives them.
3. Add or set these DNS records on the mail domain:
   - SPF: `TXT @ "v=spf1 -all"` (nothing sends mail from this domain).
   - DMARC: `TXT _dmarc "v=DMARC1; p=reject"` (nobody can send mail as this domain).
   - No DKIM key: the domain never sends.

Check: `dig +short MX <mail domain>` shows Cloudflare's MX hosts; the SPF and DMARC records are as above.

## 3. Deploy the Worker and the Durable Object

1. Make sure the account has the **Workers Paid** plan (CPU time for sealing mail of up to 10 MiB, and Durable
   Objects).
2. Copy `mailbox/` into the hosting service's repository, with `mailbox/wrangler.example.toml` as its `wrangler.toml`.
   Fill in every placeholder: the Worker name, the compatibility date, `MAIL_DOMAIN`, the `TEAMS` service binding.
3. Build the `TEAMS` binding in the hosting service: `POST /internal/mail-in/team {"key": "<base64 SPKI Ed25519>"}`
   answers `{"teamId": "<id>"}` for the relay team key of a hosted team or an enabled registered server, else 404.
   This is the same identity the Slack and Drive brokers use.
4. Keep the `Mailbox` Durable Object binding and its `new_sqlite_classes` migration.
5. Give the API a route on a host of the hosting service, path `/api/mail-in/v1/*`.
6. Before the first deploy, run a test with the Workers test runner that seals with WebCrypto (`webMailCrypto`) and
   opens with `node:crypto` (`nodeOpenSealed`): the repository tests cannot do this, because Bun has no X25519 in
   WebCrypto.
7. Deploy.

Check: `POST https://<api host>/api/mail-in/v1/status` without a signature answers 401 `unauthorized`.

## 4. Connect Email Routing to the Worker

1. In **Email Routing › Routing rules**, set the **catch-all** rule to **Send to a Worker** and pick the mailbox
   Worker.
2. Do not add per-address rules. Addresses are made by team servers at any time; the Worker checks them.

Check: send a mail from any account to `test@<mail domain>`. It bounces with `550 5.1.1 No such address`.

## 5. Point team servers at the mailbox

1. Set `MYCEL_MAIL_IN_URL=https://<api host>` (an https origin, no path) and `MYCEL_MAIL_IN_DOMAIN=<mail domain>` (the
   domain of the addresses, the same as the mailbox's) on hosted team servers, through the same place as the other
   hosting service variables (the control plane's environment for team servers). A team server needs both, else Email
   says "Email needs this server to be connected to the Trina service."
2. Restart or update the team servers so they read it.
3. The feature stays **off** for every team until an owner or admin turns on **Let rooms get email** in
   Admin › Team settings.

Check: on a test team, turn the switch on, add **Email** in a room, and see the address shown with **Copy** enabled
(the state goes from "Setting up the address" to ready).

## 6. Smoke test with real mail

Use a test team and a test room only.

1. Copy the room's address.
2. In a Gmail account: **Settings › See all settings › Forwarding and POP/IMAP › Add a forwarding address**, paste
   the address. Gmail sends a confirmation mail to it.
3. Check: the room's Email app settings show the Gmail confirmation with its code, for the room's managers only. The
   code is not in the room's timeline.
4. Confirm the forwarding in Gmail with the code. Make a filter (for example `from:<a test sender>`) with **Forward
   it to** the address.
5. Send a test mail that matches the filter. Check: a card shows in the room with the sender marked unverified, the
   subject, the text and the names of attachments (not kept in v1).
6. Repeat with Outlook.com, Microsoft 365 (an IT admin may need to allow forwarding to outside addresses), Naver and
   Daum. Send a Korean and a Japanese mail to check the character sets.
7. Press **Get a new address**. Send to the old address. Check: it bounces with 550.
8. Send a mail larger than 10 MiB. Check: it bounces with 552.
9. Record the results in the plan's phase 0 section: what the sender sees when the Worker fails, and whether the
   Worker sees Cloudflare's `Authentication-Results` header.

## 7. Monitoring and cost

1. Set a Cloudflare billing notification for Workers and Durable Objects usage, sent to the owner.
2. Watch the Worker's logs: they have event names (`mail_queued`, `mail_refused`, `mail_sync`), a hash prefix and a
   reason only. They never have an address or a mail. Do not turn on logging of `message.to` anywhere.
3. Note: the Cloudflare dashboard's Email Routing activity log shows each mail's sender, recipient and subject to the
   people who can open the account. Keep that account's access small.

## Roll back

1. In **Email Routing › Routing rules**, set the catch-all rule to **Drop** or turn it off. Mail to every room
   address then stops at Cloudflare.
2. Unset `MYCEL_MAIL_IN_URL` and `MYCEL_MAIL_IN_DOMAIN` on team servers. The Email apps show "not available" and nothing is posted.
3. Sealed items in the Durable Object expire within 24 hours. To delete them at once, delete the Durable Object's
   data.
4. The DNS records can stay; remove the MX records only if the domain gets another use.
