# Self-installed servers get Google sign-in through the hosting service by default

- Date (UTC): 2026-11-25 03:07
- Branch: `fix/google-apps-broker-default`
- Status: done
- Where: trina-ax `server/src/integrations/google-drive/` + `shared/src/cloud-protocol/drive-broker.ts` (MIT contract);
  trina-cloud `src/drive-broker/` in a separate PR. Why: the gate is split between the team server (opt-in variable)
  and the control plane (manual operator registration); both halves must change.
- Version impact: **minor**. A self-installed server with a public address now uses the hosting service's Google
  sign-in without `MYCEL_GOOGLE_DRIVE_BROKER_URL` (a changed default of a `MYCEL_*` variable, visible in Connectors) and
  serves one new public route.
- QA: TC-9070..9075.

## Goal

Owner, 2026-11-25 (screenshot of potenlab.trina.app Settings › Connectors, "나에게만 적용"): Gmail, Calendar, Docs,
Sheets and Drive all say "아직 설정 안 됨" and a member cannot connect them until an admin sets up a Google app.
"Does Google connection really need the team admin to allow it?"

It should not. A person on any Trina server with a public address connects their own Google with one click, like a
hosted team, with no admin and no operator step.

## Root cause

1. Team server: `driveBrokerFor` (google-drive/broker.ts) uses the hosting service's Google sign-in on a
   self-installed server only when `MYCEL_GOOGLE_DRIVE_BROKER_URL` is set (opt-in since 2026-11-06/11). Without it
   Drive is off and `google-apps/config.ts setupOf` gives mode `off` → `not_set_up` → "Your admin hasn't set up {name}
   yet."
2. Control plane: even with the variable, it serves a self-installed server only after an operator ran
   `cp.js drive-broker-server add --origin … --key …` (exact origin + relay public key). Hosted teams skip this
   because the CP recorded their relay key at enroll. potenlab.trina.app and jdr.trina.app have neither.

## Design

**Identity.** Every server already has its relay team key (`<data>/relay/team-key.pem`, made at start even with the
relay off). What the CP lacks is proof that this key belongs to the address the browser will be sent back to.

**Proof of address (like ACME http-01).** The team server publishes its public key at a fixed path on its own public
address; the CP fetches it there and compares. Only someone who can serve content at `https://<host>` and holds the
private key can register `<host>`.

Team server (this PR):
1. `GET /api/integrations/google-broker/key` (contract constant `GOOGLE_BROKER_KEY_PATH`): `{ v: 1, key }` (SPKI
   base64, public), `Cache-Control: no-store`. Answers only while this server signs in through the hosting service
   (404 otherwise). No session.
2. `driveBrokerFor`: on a **self-installed** server (run kind `selfhost` or `office`, not `dev`, not under
   `NODE_ENV=test`) with the variable **left out**, a public address (`publicHostOf`: `tunnel.host`) and no Google
   client of its own, the broker origin defaults to the edition's console (`HOSTED_BROKER_ORIGIN`), with
   `selfOrigin = https://<public host>`. Unchanged: the variable set wins; empty or `off` turns it off; an own client
   (file, env, or the company's own app) wins; no public address → off as before.
3. New broker op `register` `{ v: 1, origin }` (signed like the others). `checkBroker`: when `status` answers
   `not_hosted` and the broker has a `selfOrigin`, call `register` once, then `status` again. At most one register
   per 10 minutes; any refusal keeps today's state ("not set up", admin may set an own client).
4. Contract (MIT): `DRIVE_BROKER_PATHS.register`, `DriveBrokerRegister`, `parseDriveBrokerRegister`,
   `GOOGLE_BROKER_KEY_PATH`, error code `origin_unverified` (403). An older CP answers 404 for `/register`: the server
   stays off, as today.

Control plane (trina-cloud PR, separate):
1. `POST /api/drive-broker/v1/register`: verifySignedCall; the key must not be a tenant key; `serverOrigin` rules
   (https, DNS name, no IP, no path) plus **port 443 only**; not the console host; not a live hosted team address.
2. Existing row for this key: same origin and enabled → ok (idempotent); disabled → `not_hosted` (an operator's
   disable stands); other origin and row `added_by = 'self'` → proof, then update the origin (same id). An
   operator-added row is never changed by `register`.
3. Existing row for this origin with another key: operator-added → `conflict`; self-added → proof, then replace
   (delete + insert, **new id**: old sealed tokens never open for the new key).
4. Proof: resolve the host (all addresses); refuse loopback, private, link-local, CGNAT, ULA, multicast, unspecified;
   `GET https://<host>/api/integrations/google-broker/key`, no redirects, 5 s, ≤ 4 KB, JSON `{ v: 1, key }` equal to
   the signing key. Nothing from the answer is logged or returned.
5. Insert `added_by = 'self'`, display name = the host; event `system.drive_broker_server_self_registered` (server
   id, origin, key id).
6. Limits: register 12/hour per key, 30/hour per address, a daily cap on new self rows; `CP_DRIVE_BROKER_SELF_REGISTER` (default `0` until the owner opens it, plan review 11-25): `0` refuses
   new registrations **and** stops serving every `added_by = 'self'` row (status/start/redeem/refresh answer
   `not_hosted`; revoke still works). Operators still disable/remove per server (existing CLI/ops API).
7. The Slack broker keeps serving only operator-added servers (self-registered rows are Google sign-in only).

## Scope

In: the default, the key route, register op + retry on the team server, contract, docs (GOOGLE-DRIVE.md,
GOOGLE-APPS.md, CONNECTIONS.md), decision file, changes note, tests. CP PR as above.
Out: a UI switch for the default (env `off` and the per-app members switch already exist); Slack default; servers
without a public address (Google needs a return address); relay-registry lookup (proof of address covers relay
addresses too, since the relay forwards the path).

## Decisions

`docs/decisions/20261125-google-broker-self-install-default.md`. Changes
"Self-installed servers sign in to Google through the hosting service (2026-11-11)" and QA TC-2635 (no variable now
means on when the server has a public address).

## Risks

- **Google verification / CASA (owner decision, flagged):** the hosting service's Google app (GCP trina-ax-513907)
  is "In production" with data access still under review. Until it is verified, Google limits it to 100 new users
  for sensitive/restricted scopes, and that cap is shared with hosted teams. Self-installed servers receive Gmail /
  Drive access tokens and data on infrastructure we do not run; the verification submission and CASA scope describe
  the hosted service. The CP switch `CP_DRIVE_BROKER_SELF_REGISTER` lets the operator open this only after the owner
  is fine with that.
- **Phishing with our app:** anyone can run Trina and register its address; a hosted trial team can already do the
  same today, and the CP's start page names the server's host. Kill switch + per-server disable.
- **SSRF from the CP:** proof fetch restricted as above; DNS rebinding between check and fetch can only reveal a yes/no.
- No migration on the team server; no CP migration (`added_by` is free text).

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/c-drive-broker.test.ts`, `c-google-apps-signin.test.ts`.
CP: `tests/drive-broker.test.ts` (register cases), typecheck.

## Result

Built as planned on the team server: `selfInstalledDefault` + `selfOrigin`, the key route, `register` with back-off
(1, 2, 4, 8, 16, then 30 minutes; status checks slow to the same pace while refused), contract additions, docs,
decision `docs/decisions/20261125-google-broker-self-install-default.md`. Plan review (security) changes taken: the
console keeps self-registration OFF by default (`CP_DRIVE_BROKER_SELF_REGISTER=0`) until the owner opens it (Google
verification/CASA, shared 100-user cap); a replaced self row is kept disabled for revoke; self rows never take a slug; a
key that became a hosted tenant's lets the team win; Slack ignores self rows in all three places; daily cap on new self
rows; proof fetch with redirects refused, streamed 4 KB cap, one per host, 4 at once. The control plane side is a
separate trina-cloud PR (fix/broker-self-register). Not done: a separate Google client for self-installed servers
(owner's call) and a relay-registry shortcut for `<x>.trina.app` relay addresses (proof of address covers them).
