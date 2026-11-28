# A self-installed server gets its official relay address from a signed-in Trina account, no code from us

- Date: 2026-11-28
- Status: proposed (waits on the owner's three answers in the plan)
- Supersedes: none yet. When accepted it replaces, for free self-serve addresses, trina-cloud spec §3.13 / D32
  (paid relay add-on, code shown once and pasted by hand) and the INSTALL docs' "Needs an issued connection code".
- Branch: feat/relay-self-serve (plan: docs/AGENTS/plan/20261128-1333-relay-self-serve.md)

- **Ask (owner, 2026-11-28, "오키 병렬로 ㄱㄱ"):** a non-developer admin of a self-installed team (Linux, Docker,
  office Mac, Windows/WSL) gets a working https address for colleagues and phones with no manual code from us.
- **Rule (proposed):** Admin › System › Get address (or the installers' `relay-link`) starts a link signed with the
  server's relay team key. The admin confirms it in the browser at account.trina.app, signed in to a Trina account,
  matching the short code shown on their own server page. The console then asks the relay for a claim code
  (`POST /ops/v1/claims`, 15 minutes) and hands it only to the same key (signed poll); the server registers with it
  as today (`POST /teams {…, claimCode}`). Nobody sees or pastes the code. Open registration with proof of work
  stays closed on the production relay.
- **Why an account and not proof of address:** the Google broker's self-registration proves an address the server
  already has (docs/decisions/20261125-google-broker-self-install-default.md); a server asking for a relay address
  has none. Proof of the key alone would make `*.trina.app` an anonymous free https host for phishing. An account
  gives one person to contact, one address per account, and a Remove button.
- **Limits (proposed):** one live address per account, 3 new or renamed per 30 days, per-network and per-block daily
  counters, 50 new a day and 200 in total at first, a kill switch `CP_RELAY_SELF_SERVE`; per-team bandwidth caps in
  the relay before 50 addresses.
- **Not here:** paid tiers, custom domains on the official relay, a relay region choice.
- Version impact: **minor** (a new Admin › System feature and a new public contract).
