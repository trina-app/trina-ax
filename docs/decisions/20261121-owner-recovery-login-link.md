# A hosted team's sign-in page links the owner to the console's /recover

- Date: 2026-11-21
- Status: accepted
- Supersedes: none
- Branch: feat/owner-recovery-login-link (QA TC-6060 to TC-6063; the console half is trina-cloud's `/recover`, SUP-D4)

- **Rule:** a hosted team's `GET /api/setup` sends `ownerRecoveryUrl` = the edition console (`HOSTED_BROKER_ORIGIN`, from `SERVICE_HOSTS.accountHost`, not the Drive broker setting) + `/recover`, the same for every team (never its host, slug or install id; null when not hosted); the sign-in page shows `auth.forgotHosted` (guest line kept) with a plain new-tab link that adds `?team=<location.host>` itself, the console matches it only against the signed-in account's own teams, and the removed-guest screen still shows no forgot line.
