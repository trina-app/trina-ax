# Self-installed servers register themselves for the hosting service's Google sign-in

- Date: 2026-11-25
- Status: accepted (team server); the control plane side waits for the owner to open self-registration
- Supersedes: the "only when its operator sets the variable" rule of "Self-installed servers sign in to Google through
  the hosting service" (docs/DECISIONS.md, 2026-11-11) and QA TC-2635
- Branch: fix/google-apps-broker-default (plan: docs/AGENTS/plan/20261125-0307-google-apps-broker-default.md)

- **Ask (owner, 2026-11-25):** on potenlab.trina.app, Settings › Connectors (Only me) showed Gmail, Calendar, Docs,
  Sheets and Drive as "not set up yet" and a member could not connect them until an admin set up a Google app. "Does
  Google connection really need the team admin to allow it? Why??"
- **Why it happened:** two opt-ins. The team server used the hosting service's Google sign-in on a self-installed
  server only with `MYCEL_GOOGLE_DRIVE_BROKER_URL`, and the hosting service served it only after an operator recorded
  its relay public key and exact address by hand. Hosted teams skip both (their key is recorded at enroll).
- **Rule:** a self-installed server (selfhost or office, not dev, not `NODE_ENV=test`) with a public address
  (`tunnel.host`, https on 443, a DNS name), no Google client of its own and the variable left out, uses the edition's
  console and registers itself: it publishes its relay public key at `GOOGLE_BROKER_KEY_PATH` and sends a signed
  `register` with its address; the console fetches the key there and serves the server only when it matches (proof of
  address, like ACME http-01). The variable set still wins (an operator's console, registered by hand); empty or `off`
  turns it off; a client of its own still wins; no public address: no call out.
- **Why proof of address:** the console must never send a browser with a handoff to an address the key holder does
  not control. Fetching the key at the address proves both halves without an operator, and needs nothing new on the
  server (the relay team key exists on every server, even with the relay off). Chosen over a relay-registry lookup
  (most self-installed servers, potenlab and jdr among them, use their own Cloudflare tunnel, not the relay) and over a
  browser-polled handoff without an address (the start page could no longer name the server).
- **Back-off:** a refused registration tries again after 1, 2, 4, 8, 16, then every 30 minutes, and status checks
  slow to the same pace after every "no" of the console (not served, not reachable, not configured, rate limited; a
  yes starts over), so servers the console says no to do not poll it every minute. An admin page still asks on
  load.
- **Not here:** a UI switch (env `off` and the per-app members switch exist), Slack (still only with its variable),
  servers without a public address.
- **Owner decision before the console opens it:** the hosting service's Google app (GCP trina-ax-513907) is still in
  Google's data-access review. Until it is verified, Google caps it at 100 new users for sensitive and restricted
  scopes, shared with hosted teams, and Gmail and Drive data would reach servers outside the hosted service that the
  verification and CASA describe. The console therefore keeps self-registration off until its operator sets
  `CP_DRIVE_BROKER_SELF_REGISTER=1`; this team-server change is harmless before that (the server stays as today).
- Version impact: **minor** (a changed default of a `MYCEL_*` variable that is visible in Connectors, one new public
  route, one new contract op).
