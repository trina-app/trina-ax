# Runbook: put the room email mailbox into service

- For: the owner or the operator of the hosting service.
- Plan: [docs/AGENTS/plan/20261123-0421-room-email.md](../AGENTS/plan/20261123-0421-room-email.md), section "Change
  2026-11-23" (Amazon SES on `in.trina.app`, not Cloudflare Email Routing). Contract:
  [shared/src/cloud-protocol/mail-in.ts](../../shared/src/cloud-protocol/mail-in.ts). Code:
  [mailbox-ses/](../../mailbox-ses/README.md) (AWS) on top of [mailbox/](../../mailbox/README.md) (gateway, API, store).
- The hosting service's side: trina-cloud `POST https://cp.trina.app/internal/mail-in/team` and its runbook
  `docs/runbooks/room-email-lookup.md`.
- Status (2026-11-23): steps 1 to 3 done in account engine-trina (896568317806), us-east-1. Steps 4 to 6: see the PR.

Do the steps in this order. Each step says how to check it. Stop if a check fails.

## What runs where

| part | where | name |
|---|---|---|
| MX of the mail domain | Cloudflare zone `trina.app` | `MX in.trina.app → 10 inbound-smtp.us-east-1.amazonaws.com` |
| receiving | SES us-east-1 | active rule set `room-email`, rule `room-email-in` (recipient `in.trina.app`) |
| raw mail (in clear, minutes only) | S3 | `room-email-raw-<account>-us-east-1/raw/` |
| gateway | Lambda | `room-email-gateway` |
| queue (sealed only) | DynamoDB | `room-email-mailbox` |
| team server API | Lambda function URL | `room-email-api` (`MYCEL_MAIL_IN_URL` = its https origin) |
| team lookup | control plane | `POST https://cp.trina.app/internal/mail-in/team` (bearer token in SSM `/room-email/cp-lookup-token` and CP credential `mail_in_lookup_token`) |

Never change the MX records of `trina.app` itself: its mail goes to Daum.

## 1. Deploy the AWS parts

1. Make the lookup token and put it in SSM: [mailbox-ses/README.md](../../mailbox-ses/README.md) "First deploy" steps
   1 and 2. Keep `token.txt` (0600) for step 4.
2. `AWS_PROFILE=engine-trina mailbox-ses/deploy.sh`. It refuses another account, a missing SSM parameter, and another
   active receipt rule set (one per region: add the rule to that set by hand, or decide first).

Check: `curl -s -X POST https://<api host>/api/mail-in/v1/status -d '{"v":1}'` answers 401 `unauthorized`.

## 2. Verify the domain in SES

1. `aws sesv2 create-email-identity --email-identity in.trina.app --tags Key=purpose,Value=room-email` (Easy DKIM).
   SES receiving needs a verified domain. The domain never sends.
2. Add the three DKIM CNAMEs it gives (`<token>._domainkey.in.trina.app → <token>.dkim.amazonses.com`, not proxied).

Check: `aws sesv2 get-email-identity --email-identity in.trina.app` shows `DkimAttributes.Status` `SUCCESS`.

## 3. DNS records of the mail domain

With the hosting service's Cloudflare DNS token, on the CP host, from a 0600 curl config file (never in an argument):

- `MX in.trina.app` → `inbound-smtp.us-east-1.amazonaws.com`, priority 10.
- `TXT in.trina.app` → `"v=spf1 -all"` (nothing sends mail from this domain).
- `TXT _dmarc.in.trina.app` → `"v=DMARC1; p=reject"`.

`*.trina.app` has a wildcard record for team addresses. A team cannot be named `in` (shorter than 3 characters), so
the explicit records for `in.trina.app` hide nothing.

Check: `dig +short MX in.trina.app` shows only the SES host; `dig +short MX trina.app` still shows Daum.

## 4. The control plane's team lookup

trina-cloud `docs/runbooks/room-email-lookup.md`: the credential `mail_in_lookup_token` (the same value as SSM), the
unit's `LoadCredential=` line, a CP deploy (back up the database first).

Check: a signed `status` call with the relay team key of a served team answers 200 (not `not_hosted`).

## 5. Point a team server at the mailbox

1. On the team server (a hosted tenant: its `/etc/default/mycel`, the server unit's environment file) set
   `MYCEL_MAIL_IN_URL=https://<api host>` (an https origin, no path) and `MYCEL_MAIL_IN_DOMAIN=in.trina.app`. Then
   restart the server. The server needs a release with email into rooms (trina-ax #436).
2. The variables are per server: a team without them has no Email, whatever the mailbox does.
3. The feature stays **off** until an owner or admin turns on **Let rooms get email** in Admin › Team settings.

Check: turn the switch on, add **Email** in a room, and see the address with **Copy** enabled.

## 6. Smoke test with real mail

Use a test team and a test room only.

1. Copy the room's address.
2. In Gmail: **Settings › See all settings › Forwarding and POP/IMAP › Add a forwarding address**, paste the address.
   Gmail sends a confirmation mail to it.
3. Check: the room's Email app settings show the Gmail confirmation with its code, for the room's managers only.
4. Confirm the forwarding in Gmail with the code. Make a filter with **Forward it to** the address.
5. Send a test mail that matches the filter. Check: a card in the room (sender unverified, subject, text, names of
   attachments). In the API log, the item's `auth` comes from SES (`Authentication-Results: amazonses.com`).
6. Press **Get a new address**. Send to the old address. Check: **no card**, the sender gets **no bounce**, and the
   gateway log has `mail_refused` with reason `unknown`.
7. Send a mail larger than 10 MiB (SES takes up to 40 MB). Check: no card, no bounce, `mail_refused` reason `too_big`.
8. Check the S3 bucket's `raw/` prefix is empty a minute later.

Logs: `aws logs tail /aws/lambda/room-email-gateway --since 1h` (event names, a hash prefix and a reason only; never
an address or a mail).

## 7. Monitoring and cost

1. AWS Budgets: an alert on the `purpose=room-email` tag (activate it as a cost allocation tag first), sent to the owner.
2. Cost per month (us-east-1, 2026-11 prices, no free tier): a team server that is awake holds one API call open all
   the time: about 104,000 calls × 25 s × 0.25 GB ≈ 650,000 GB-s ≈ USD 8.70 per awake team per month (arm64). A
   sleeping team costs nothing. DynamoDB reads of the held poll ≈ USD 0.50 per team. SES receiving USD 0.10 per 1,000
   mails plus USD 0.09 per 1,000 incoming 256 KB chunks. S3, logs, SSM: cents. With many teams, move the API onto a
   long-running host (the control plane) and keep SES, S3 and the gateway.
3. Raw mail is in clear in S3 only between SES and the gateway (seconds). Keep access to the bucket small.

## Unknown and replaced addresses

SES accepts every address of `in.trina.app` before any code runs, so the gateway cannot refuse at SMTP time (no 550
or 552). It drops the mail and logs the reason. It sends no bounce: a bounce goes to the envelope sender, which spam
forges (backscatter). A sender to a replaced address sees nothing; the room gets nothing. This is the same for a
removed address, a full queue (452 in the reference) and a limit (451 in the reference).

## Roll back

Each step can be done alone. Fastest first.

1. **Stop mail at once:** `aws ses set-active-receipt-rule-set --region us-east-1` (no name = no active set). SES then
   refuses every recipient of `in.trina.app` at SMTP time (550). To start again:
   `aws ses set-active-receipt-rule-set --rule-set-name room-email --region us-east-1`.
2. **Turn a team off:** remove `MYCEL_MAIL_IN_URL` and `MYCEL_MAIL_IN_DOMAIN` from its `/etc/default/mycel` and restart
   it. Its Email apps show "not available" and nothing is posted.
3. **Stop the team API:** make the CP credential `mail_in_lookup_token` empty and restart the CP. Every API call then
   answers `not_hosted`.
4. **Remove everything:** step 1, then `aws cloudformation delete-stack --stack-name room-email` (the S3 bucket must be
   empty first: `aws s3 rm s3://room-email-raw-<account>-us-east-1 --recursive`). Delete
   `room-email-artifacts-<account>-us-east-1`, the SSM parameter, and the SES identity `in.trina.app`. Delete the six
   DNS records of `in.trina.app` (comment `purpose=room-email`). Sealed items in DynamoDB go with the table.
5. Nothing here touches `trina.app`'s own MX, the relays or team data. A rollback of the CP release is the usual
   `releases/<previous>` switch; the route has no migration.
