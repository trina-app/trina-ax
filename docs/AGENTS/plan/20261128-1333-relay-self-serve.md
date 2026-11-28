# A self-installed server gets its https address from the official relay without a code from us

- Date (UTC): 2026-11-28 13:33
- Branch: `feat/relay-self-serve`
- Status: draft (plan only; owner decisions below before building)
- Where: `server/src/relay-client/`, `server/src/system/connection.ts`, `server/src/routes/system.ts`,
  `shared/src/cloud-protocol/` (new contract, MIT), `web/src/pages/admin/System.tsx`, the installers
  (`scripts/install-linux.sh`, `scripts/windows/install-wsl-server.ps1`, `scripts/office/`, `docker/`), docs; and in
  the private trina-cloud repo (control plane, CP) a twin PR. The relay (`relay/`) needs no change for v1. Why: the
  team server owns the connection screen, the CP owns accounts and who may hold a `*.trina.app` name
  (docs/REPOSITORY-RULES.md).
- Version impact: **minor**. A new feature in Admin › System and the installers, and one new public contract
  (`relay-link`); nothing that worked stops working.
- Draft decision: [docs/decisions/20261128-relay-self-serve.md](../../decisions/20261128-relay-self-serve.md)

## Goal

Colleagues and phones need an https address to reach a self-installed server (Linux, Docker, office Mac,
Windows/WSL). Today there are two ways to get one, and a non-developer can use neither:

- **Official relay** (Admin › System › Change connection › Official relay). It only connects out, so nothing on the
  router has to change. But the production relay has open registration off (`RELAY_OPEN_REGISTRATION=0`), so the
  server needs a **claim code**. The only working way to issue one is an operator running
  `node relay/src/main.ts claim <name> --ref …` on the relay host and sending the code by hand. The console's add-on
  (`trina-cloud src/addon/addon.ts`, spec §3.13, D32 ₩15,000/month) always answers `coming_soon`: its price was billed
  by Toss, which was removed (trina-cloud #148), and it has no Polar product.
  The docs say this: "Needs an issued connection code" (INSTALL-DOCKER.md, INSTALL-LINUX.en.md, INSTALL.md §3).
- **Their own tunnel** (Cloudflare Tunnel token, `--public-host`, a reverse proxy). This needs a domain, a
  Cloudflare login and a token file: too hard for the people we sell to.

After this change an admin clicks **Get address** in Admin › System (or says yes at the end of the Windows
installer), signs in to their Trina account in the browser, confirms one screen, and within a minute the team
works at `https://<name>.trina.app` from any phone or computer. Nobody at Trina is involved.

## How it works today (research, 2026-11-28)

- **Server** (`server/src/relay-client/registration.ts`): every server has an Ed25519 team key
  (`<data>/relay/team-key.pem`, 0600). It gets its relay address one of three ways: `registration.json` written by
  the CP (hosted teams only), a claim code (`claim.json`, saved by Admin › System), or public registration with
  proof of work (closed on production). The code is spent by `POST /teams {name, publicKey, ts, sig, claimCode}`;
  the relay answers a team id and a recovery code, written once to `<data>/relay/recovery-code.txt`. The mode lives in
  `config/server.json` (`relay.url`) and applies after a restart. `relay.officialAvailable` already defaults to true.
  Office mode (`availableModes`) offers only `direct-only`: the office supervisor rewrites server.json at every start
  and uses its own Cloudflare tunnel (docs/OFFICE.md §9).
- **Relay** (`relay/src/registry.ts`): claim codes are 100 random bits, stored as a hash, used once, bound to one
  name, at most 7 days; a live code holds the name. Teams have an `origin` (`self`, `cloud`, `addon`), an
  `externalRef` (the CP's id) and can be suspended (`billing`, `canceled`, `abuse`, `security`, `operator`), renamed
  (308 for 90 days) or released (name held one year). The operator API (`/ops/v1/*`, private Tailscale listener,
  signed operator keys) already has `POST /ops/v1/claims`, team lists by origin, suspend and release.
- **Relay hosts** (memory, 2026-11-24): `relay.trina.app` (Seoul) and `relay-us.trina.app` (Virginia), both
  t3a.micro (913 MiB, about 510 free), behind Cloudflare. Seoul: 41 registered, 4 online. Team addresses are
  `<name>.trina.app`, the same namespace as hosted teams and `account.trina.app`. Every byte a visitor reads goes
  out of AWS once (relay → Cloudflare), billed as internet egress. The relay counts bytes only in its log and in
  `/metrics` without a team label: there is no per-team quota.
- **CP** (`trina-cloud`): accounts at account.trina.app sign in by mail code, Google or GitHub. The add-on code
  already does most of what we need: slug check (`checkSlug`, own-brand names refused), look-alike names flagged to
  ops (`flagTeamNames`), per-network and per-block limits (`addon-net`, `addon-block`), claim creation through the
  relay operator API, linking the relay team by `externalRef` and a 10-minute online/version refresh
  (`refreshAllAddons`), suspension through the team lifecycle.
- **Google broker self-registration** (docs/decisions/20261125-google-broker-self-install-default.md, trina-cloud
  `src/drive-broker/self-register.ts`): the server signs `register {origin}` with its relay team key and the CP
  fetches the key back from `https://<origin>/…` (proof of address, like ACME http-01), with daily caps (200 new a
  day, 5 per registrable domain) and a kill switch flag. This proves "the key holder controls this address". It
  cannot be used here: a server asking for a relay address has no public address yet. What we reuse is the shape: the
  relay team key signs every call, the CP keeps the public key, limits and a kill switch, a generic refusal.

## Scope

In:
- One-button self-serve address for every self-installed install type, approved by a signed-in Trina account.
- The claim code is issued and delivered machine to machine: the person never sees, copies or pastes it.
- Account console: the address listed under the account, with Remove; ops console: list, suspend, release.
- Linking servers that already hold a manually issued address to an account (no cut-off).
- Docs: INSTALL.md §3, INSTALL-LINUX(.en).md, INSTALL-DOCKER.md, INSTALL-WINDOWS.md, OFFICE.md, CONNECTIONS.md
  (a connection mode surface changes, so it is updated in the build PR).

Out (later):
- Per-team bandwidth counters and caps in the relay (phase 2, before ~50 self-serve addresses, see Cost).
- The US relay and a region choice (v1: the CP's default relay, Seoul, as the add-on uses; a US region needs the
  same per-team routing hosted US teams have and is a follow-up).
- Custom domains on the official relay; paid tiers (D32 stays parked until there is a Polar product).
- Hosted teams (unchanged: the CP registers them at enroll).

## User flow per install type (plain words)

Common part (Admin › System › Connection, on a computer; a phone shows "Do this on a computer" as today):

1. The card says: "Colleagues and phones need an internet address for this server. Get a free one:
   **name**.trina.app". The name is filled in from the team name and checked as you type (taken, reserved, too short).
2. **Get address** opens account.trina.app in a new tab (the desktop app: the system browser, with "Copy link").
   The admin signs in or makes an account (mail code, Google or GitHub, as today).
3. The page shows the name, the server's short code (four groups of four, also shown on the Admin page, like a TV
   sign-in code) and one checkbox for the acceptable-use rules. **Confirm**.
4. Back on the Admin page the card turns to "Connecting…" and then "Connected: https://acme.trina.app", with
   Copy, QR code and "Print the recovery code" (the existing recovery file, shown once, then deleted on request).
   No restart: the relay client starts in-process (if the build step finds that unsafe, it uses the existing
   "restart when idle" with a notice that says so).
5. Members get the new address on their next visit: invite links, the install pictures and `GET /api/me
   team.address` already use the relay address once it is connected (`teamAddressOf`).

Per install type:

- **Linux** (`install-linux.sh`): the last lines print the setup page and "To let colleagues in from anywhere: Admin ›
  System › Get address". For an admin on SSH only: `sudo ./install-linux.sh relay-link [--name acme]` prints the
  sign-in link and the short code; it can be opened on any phone or computer; the command waits up to 15 minutes and
  prints the address.
- **Docker**: the same button. Headless: `docker compose exec trina-ax mycel-ctl relay-link [--name acme]` does what
  the Linux command does. INSTALL-DOCKER.md "Access for the team" option 1 loses "Needs an issued connection code".
- **Windows/WSL** (`install-wsl-server.ps1`): step 8/8, after the health check, asks
  "Get a free https address so colleagues and phones can reach this PC? [Y/n]". Yes runs the same `relay-link`
  inside the distro, opens the sign-in page in the default browser and waits; the final message prints the
  address instead of "see Reach it from other computers". `-WhatIf` says it would ask and changes nothing;
  `-NoRelayAddress` skips the question (for scripted installs).
- **Office Mac** (office mode): today it offers only the office network plus an optional Cloudflare tunnel
  (`teamax public-address set`). Add `teamax public-address relay [--name acme]` (same link flow, printed and opened
  in the Mac's browser) and let Admin › System offer the official relay in office mode. The office supervisor keeps
  `relay.url` when the office chose it (today it rewrites it away at every start). Desks on the office network keep
  their direct LAN connection; the relay is for everyone outside. The first-run setup stays office-network only.
- **Servers with their own tunnel or relay**: nothing changes; the card shows "This server has its own address"
  and no button.

## Trust and abuse model

A free https name under our domain that forwards to any machine is a phishing and abuse tool if anyone can take one
anonymously (the reason ngrok moved free tunnels to ngrok-free.app). The rules:

- **Who may get one:** a signed-in account.trina.app account (mail code, Google or GitHub, so an address that
  receives mail or a real provider account) that confirms in the browser. Not anonymous key-only registration:
  public registration with proof of work stays closed on production.
- **Binding:** the server signs `start` with its relay team key; the CP returns the claim code only to the same key
  (signed `poll`), and only after the account confirmed the link whose short code the admin saw on their own server
  page. A stolen link without the key gets nothing; a stolen key without the account gets nothing.
- **Limits:** one live self-serve address per account (an account may also have its hosted team), at most 3 new or
  renamed ones per account per 30 days; the add-on's per-network and per-block daily counters; `start` at most 10 an
  hour per IP (IPv6 /64) and 3 an hour per key; links expire in 15 minutes; a global cap of new self-serve addresses a
  day (default 50) and in total (default 200, raised by CP config when capacity allows). Every refusal over a limit
  answers one generic `rate_limited`.
- **Names:** the CP's `checkSlug` (reserved, own-brand refused), relay `checkTeamName` (2-40, a-z 0-9 inner hyphens),
  look-alike brand names made but flagged to ops (`flagTeamNames`), as for hosted teams. A released name is held one
  year (relay default).
- **Is it really Trina?** The relay cannot prove what software answers (the protocol is open source). The CP checks
  after linking and then daily that `https://<name>.trina.app/api/health` answers as a Trina server; a server that
  does not is flagged to ops (not suspended automatically). This is a deterrent, not a proof.
- **Revoke:** the account console has Remove (relay release, name held); Admin › System has "Stop using this address"
  (signed `release`); ops can suspend with reason `abuse` or `security` (existing relay pages, visitors see the
  plain suspended page; the server keeps working on the office network); a kill switch `CP_RELAY_SELF_SERVE=0`
  stops new links at once without touching linked teams. Abuse reports: the relay's own pages and the terms name
  `abuse@trina.app` (to be created; owner-side mailbox).

## Changes

**Contract** (`shared/src/cloud-protocol/relay-link.ts`, MIT, vendored by the CP; docs/CONTRACT-SYNC.md pin):
`start {v, name, publicKey, ts, sig, install, serverVersion}` → `{linkId, userCode, verifyUrl, expiresAt,
pollAfterSec}`; `poll {linkId, ts, sig}` → `{state: waiting|approved|refused|expired, claimCode?, relayUrl?, name?}`;
`release {teamId, ts, sig}`; `status` (public: `{open}` so a server hides the button while the CP says no). Signing
strings with a domain prefix (`mycel-relay-link-v1\n…`), test vectors like the other cloud-protocol files.

**Server** (team server, this repo):
- `server/src/relay-client/self-link.ts` (new): start, poll with back-off (3 s while the admin page is open, then
  slower, stop at expiry), on `approved` save the claim (`saveClaimCodeFor`) and the official relay mode
  (`saveConnectionMode`) and start the relay client.
- `server/src/routes/system.ts` + `shared/src/api/system.ts`: `POST/GET/DELETE /api/system/connection/relay-link`
  (owner/admin with reauth, as Change connection), `ConnectionStatus.selfServe {open, state, userCode, verifyUrl}`.
- `server/src/system/connection.ts`: `availableModes` offers `relay` in office mode; office supervisor keeps it.
- `mycel-ctl relay-link`, `install-linux.sh relay-link`, Windows step 8 question, `teamax public-address relay`.
- `web/src/pages/admin/System.tsx`: the card (one field, one button, the code, the states); the old manual claim
  code field stays under "Change connection › Official relay › I have a code" for codes already handed out.
- i18n in every app language file (en first; ko, id, ja, es, zh). Plain words: "address", not "relay" or "claim".
- No server DB migration expected (state in `<data>/relay/`); if one is needed, take the next free number in
  `server/migrations/` on dev at build time.

**CP** (trina-cloud, twin PR):
- Migration (next free number at build time; 115/116 are taken): `relay_links` (id, public key, name, user code
  hash, account, state, claim code sealed until picked up, expires, ip hash) and a plan row `relay_free` (₩0, no
  trial, no billing). The address is a team row of kind `relay_addon` on plan `relay_free`, so the add-on's pages,
  `refreshAllAddons`, link by `externalRef` and suspension are reused; `assertNoLiveTeam` and the trial/billing
  lifecycle skip `relay_free`.
- Public signed endpoints `/api/relay-link/v1/{status,start,poll,release}`; console page `/link/:id`; account
  console list with Remove; ops console filter + suspend; the daily health probe; kill switch and caps in cp.env.
- Claim TTL 15 minutes for self-serve (the relay allows up to 7 days); the code is deleted from the CP once the
  server has picked it up.

**Relay:** none for v1 (claims, origin `addon`, `externalRef`, suspend, release exist). Phase 2: per-team monthly
byte counters in the registry, `bytesThisMonth` and `publicKey` in `OperatorTeamInfo` (additive), so the CP can send
a notice at a soft cap and suspend at a hard cap. A relay deploy follows the known traps (unique build version,
`RELAY_SELF_NAMES=relay-us` on the US host, MemAvailable check).

## Migration of teams with a manually issued code

- Their relay registration does not change: they keep working, nothing is revoked.
- Admin › System on such a server (official relay, connected, no CP link) shows "Link this address to your Trina
  account" (same browser flow, `start {mode: 'existing', relayTeamId}`). The CP proves the key without a relay
  change: the server also sends a fresh signed relay `GET /teams/:id` authorization, which the CP replays once to the
  relay (a 200 means the key holds that team); with phase 2 the CP compares `publicKey` from the operator API
  instead. Then the CP adds the team row with `relay_team_id` and the relay team's `externalRef` is set through the
  operator API.
- Ops lists the relay teams of origin `addon`/`self` that have no CP row (count read at build time through the
  operator API) and mails their known owners once. They are never cut off for not linking.

## Steps

1. Owner decisions (below). Then the contract file + vectors (this repo), merged first so the CP can vendor it.
2. CP twin PR behind `CP_RELAY_SELF_SERVE=0`; deploy (flag off, nothing visible).
3. Server + web + installers + docs PR (button hidden while `status.open` is false).
4. QA with test data only: a Docker server and a Linux VM on the office Mac network, a Windows PC (Windows QA PC),
   the office Mac in office mode; one QA-Acme test account; the production relay, names `qa-self-*`. Then release
   (minor) through the normal train.
5. Owner flips `CP_RELAY_SELF_SERVE=1`. Watch: links started/approved/refused a day, online addresses, relay RSS and
   egress, flagged names.
6. Phase 2 relay byte caps before 50 self-serve addresses; resize the relays (t3a.small) when online teams pass ~50
   or RSS passes 60 % (owner OK, it is spend).

## Cost and capacity

- Fixed: none new. The two relays already run (2 × t3a.micro). Resizing to t3a.small later is about +$7/month each
  and needs an owner OK.
- Variable: AWS egress, about $0.09/GB (Virginia) to $0.126/GB (Seoul). Estimate: 50 active teams × 10 GB a month =
  500 GB ≈ $45-65/month. Without caps the worst case is unbounded, so the total cap (200) and the phase-2 per-team
  soft cap (e.g. 50 GB: notice) and hard cap (e.g. 200 GB: suspended until next month or a paid plan) bound it.
  The AWS credit covers this for now; the caps are what keep it from depending on that.
- Mail: one sign-in code per new account (existing SES volume).

## Decisions

- New: [docs/decisions/20261128-relay-self-serve.md](../../decisions/20261128-relay-self-serve.md) (proposed until
  the owner answers the three questions below).
- Changes: trina-cloud spec §3.13 / D32 (paid add-on with a code shown once) for self-serve addresses; INSTALL docs
  "Needs an issued connection code".

### For the owner (one recommendation each)

1. **Who may get an address?** (a) a signed-in Trina account confirms in the browser (mail code, Google or GitHub);
   (b) anyone, the server only proves its key (open registration with proof of work); (c) an e-mail check without an
   account. **Recommendation: (a).** It is one extra screen for the admin, gives us a person to contact and one
   address per account to revoke, and reuses the console's sign-in. (b) makes `*.trina.app` a free anonymous
   phishing host.
2. **Price and limits?** (a) free: one address per account, 200 in total at first, bandwidth caps in phase 2;
   (b) the paid add-on of D32 (₩15,000/month), which cannot be sold today (no billing product since Toss was
   removed). **Recommendation: (a)**, and revisit a paid tier when a Polar product exists and heavy users appear.
3. **Which domain?** (a) `<name>.trina.app`, the same as hosted teams; (b) a separate domain only for self-installed
   addresses (as ngrok did with ngrok-free.app), so abuse on one of them can never get trina.app blocked by
   filters. **Recommendation: (a) for launch** (one brand, no new zone or certificate, the account gate and caps
   keep abuse small), with the relay's multi-domain support (`RELAY_DOMAIN=a,b`) kept as the way out if a blocklist
   or abuse wave appears.

## Risks

- Phishing under trina.app (decision 3): account gate, caps, look-alike flags, health probe, fast suspend.
- Relay memory on t3a.micro: about 80-120 MiB per extra process during a/b deploys; watch RSS as teams grow.
- Egress cost without per-team counters until phase 2: the total cap holds it.
- Office mode change touches the supervisor that rewrites server.json at every start: test a restart, an update
  and `public-address off` in office mode.
- Applying the relay mode without a restart: if the relay client cannot start in-process safely, fall back to the
  existing restart-when-idle (say so on screen).
- Security review (independent) of the contract and the CP endpoints before the flag is turned on: signing strings,
  replay, the one-time claim hand-over, rate limits, generic refusals.
- Languages: every app language file; the Windows installer text is English (as today).

## Tests

- Contract: vectors and validators (`tests/unit` cloud-protocol), the CP's copy byte-identical (CONTRACT-SYNC).
- Server unit: start/poll/back-off/expiry, approved → claim saved → registered with the claim (fake relay), office
  `availableModes`, reauth and role checks on the routes, the link-existing proof.
- CP unit: signed calls (bad key, replay, clock skew), poll only by the key holder, one per account, 30-day cap,
  network counters, global caps, kill switch, slug/look-alike, claim deleted after pick-up, `relay_free` skipped by
  the trial/billing lifecycle and `assertNoLiveTeam`, health probe flagging.
- Relay: existing conformance suite (`bun run test:relay`) unchanged; phase 2 adds byte-counter tests.
- Web e2e: the System card states with a mocked CP (no real CP in e2e); `bun run typecheck`, `bun run check:i18n`,
  `bun run check:docs`, `bun run check:prepush`.
- Installers: `scripts/ci/linux-install-check.sh`, `scripts/ci/windows-install-check.ps1` (the question and
  `-NoRelayAddress`), office install check.
- Real check before the flag goes on: the QA servers above get a `qa-self-*` address through the real flow, a phone
  outside the office network opens it, Remove releases it.

## Result

Filled in at the end.
