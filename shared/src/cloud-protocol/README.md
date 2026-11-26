# cloud-protocol — contracts between the team server and hosting control plane

**License: MIT** (see `LICENSE` in this folder). This folder is dual-licensed with the rest of the repository: the
repository is AGPL-3.0, and the files in `shared/src/cloud-protocol/` are *also* offered under the MIT license, so
the private control plane (`potenlab/teamax-cloud`) can copy them without becoming a work based on the AGPL program.
Nothing in this folder imports code from outside it (only `zod` and `node:crypto`). Keep it that way.

The control plane copies this folder at a pinned commit (`scripts/sync-protocol.ts` in the private repository) and CI
compares the copy. Change a contract here first, add vectors, then update the control plane (the private
repository records which files at which commit).

This folder is also the **one source of truth for ax-hostd's tenant-side schemas**: `ee/cloud/contracts/substrate.ts`
imports `TenantStatus`, `EnrollFile`, `EnrollStatus`, the `tenantCommand` allow-list and argv, `PlanResources` and the
id / name rules (`TenantId` = ULID, `TeamSlug`, `RelayTeamId`, `PlanId`, `TimeZoneName`, `Locale`, `EnrollToken`) from
here as `@mycel/shared/cloud-protocol` and only adds what the control plane and ax-hostd alone speak.

| File | What | Spec |
|---|---|---|
| `enroll.ts` | `/run/ax/enroll.json`, `POST /enroll` request and answer (modes `new`, `restore`, `verify`, `reattach`), `/run/ax/enroll-status.json` | control-plane 3.5.2, isolation §5.4 |
| `tenant-commands.ts` | the `mycel-ctl` commands ax-hostd may run for the control plane (`tenantCommand`), their args, stdin and output, `TenantStatus`, the gate `tenantCommandProblem()`, `FRESH_TEAM_FAILING_CHECKS` (checks that fail on a fresh hosted team; the update gate does not roll back on them) | control-plane 3.5.3 |
| `common.ts` | shared field rules: `TenantId` (ULID), `TeamSlug`, `RelayTeamId`, `PlanId`, `TimeZoneName`, `AccountUsername` (= the team server's username rule), `HttpsUrl` (https, http only to this machine), `CredentialKind`, `CLOUD_DEFAULT_CREDENTIAL_KINDS` | — |
| `files.ts` | `plan.json` (runtime field names + the control plane's `maxActiveMembers`, `display`, `links`, `speechFreeHours`; the team server reads plan.json with this schema), `notices.json`, `<data>/relay/registration.json`, `PlanResources` (ax-hostd's VM resources), `PlanLimits` | control-plane 3.5.6, linux-runtime 3.8.5 |
| `release.ts` | `server/<channel>.json` and `server/<version>/release.json` (the server's `ReleaseFeed` + optional fields) | control-plane 3.7.1, linux-runtime 3.6.3 |
| `relay-ops.ts` | relay operator API: types, `opsSigningString`, the `Authorization: MycelRelayOps` header, scopes, plain validators, the wake request and answer (`OpsWakeResponse`: `state`, `retryAfterSec`, optional `reason: 'no_room'` with `busy` only, since 2026-11-22). **Erasable TypeScript, no zod** (the relay loads it with Node type stripping) | control-plane 3.6.2 |
| `relay-ops-schema.ts` | zod mirrors of the operator API bodies for the control plane | control-plane 3.6.2 |
| `push-gateway.ts` | push gateway API (`push-gateway/`, team server → native push): `POST /v1/send` body (`parsePushGatewaySend`, strict), the `Authorization: MycelPush` header, `pushGatewaySigningString`, error codes and their status. **Erasable TypeScript, no imports at all** (Node and Bun load it as it is) | `push-gateway/README.md` |
| `drive-broker.ts` | Google Drive sign-in broker (control plane `src/drive-broker/`, hosted teams): `POST /api/drive-broker/v1/{status,start,redeem,refresh,revoke}` bodies (strict parsers), the `Authorization: TrinaDriveBroker` header signed with the relay team key, `driveBrokerSigningString`, the one Google return address and the team return address, error codes. **Erasable TypeScript, no imports at all** | `docs/GOOGLE-DRIVE.md` "Hosted teams" |
| `slack-broker.ts` | the official Slack app's broker (control plane `src/slack-broker/`, hosted teams and registered servers): `POST /api/slack-broker/v1/{status,install,redeem,token,poll,uninstall,signin/start,signin/redeem}` bodies (strict parsers), the `Authorization: TrinaSlackBroker` header signed with the relay team key, `slackBrokerSigningString`, the one Slack redirect URL and the team return addresses, the long-poll events, the sealed bot token (`X25519-HKDF-SHA256-A256GCM`), error codes. **Erasable TypeScript, no imports at all** | `docs/SLACK.md` "The official app" |
| `google-signin.ts` | Sign in with Google through the hosting service (control plane `src/google-signin/`, hosted teams only): `POST /api/google-signin/v1/{status,start,redeem}` bodies (strict parsers; the team server chooses the OpenID Connect nonce), the `Authorization: TrinaGoogleSignin` header signed with the relay team key, `googleSigninSigningString` (its own prefix: no Drive or Slack signature verifies here), the one Google return address and the team return address `/api/auth/google/return`, the start-answer check `googleSigninAuthorizeUrl`, error codes. The control plane hands back Google's raw id_token; the team server checks its signature and claims itself. **Erasable TypeScript, no imports at all** | `server/src/auth/google-login-broker.ts` |
| `team-name.ts` | the team's name, hosted team server → control plane (`teams.display_name`) after a rename in Admin › Team settings or at setup: `POST /api/hosted-team/v1/name` `{ v: 1, displayName }` (strict parser), signed exactly like the Drive broker (`TrinaDriveBroker` header, `driveBrokerSigningString` with this path), only a hosted team's primary tenant key; `teamNameProblem()` is the one name rule (1-60 characters like the console, NFC, no controls, default-ignorable characters, Arabic letter mark, Hangul fillers or Braille blank; a joiner only inside an emoji). **Erasable TypeScript, imports only `drive-broker.ts`** | — |
| `problem-report.ts` | a person's problem report, team server → control plane intake → the operators' room ("문제 신고", 👎 under an answer): `POST /api/problem-reports/v1/report` `ProblemReport` (strict parser `parseProblemReport`: the words, versions, platform, screen kind, turn id, failure code, tool ids, and the question and answer only when ticked), signed exactly like the Drive broker (`TrinaDriveBroker` header, `driveBrokerSigningString` with this path), any relay team key; 200 also for a known id, 404 = this control plane takes none. **Erasable TypeScript, imports only `drive-broker.ts`** | `docs/decisions/20261126-problem-reports.md` |
| `owner-claim.ts` | a team made from the desktop app: **A.** the app ↔ console API (`/app/connect` with a loopback return to `http://127.0.0.1:<port>/console-callback`, RFC 8252 + PKCE S256; `POST /api/app/v1/token` → a 2-hour bearer token, a `store=1` token reads and opens only; `GET /me`, `POST /teams` (Free plan only), `GET /teams/:id`, `POST /teams/:id/{retry,resume,owner-claim}`, `POST /waitlist`; the answers `AppMe`, `AppTeam`, `AppFreePlan` and the error codes `APP_ERRORS`, strict parsers); **B.** the owner claim, hosted team server → control plane, two-phase: `POST /api/hosted-team/v1/owner/{reserve,confirm}` `{ v: 1, claim }` (strict), reserve answers who the owner is (`OwnerClaimOwner`, repeatable), confirm spends the claim (`{ ok, spent }`, a repeat by the same team answers `spent: false`), signed exactly like the Drive broker with the path, only a hosted team's primary tenant key; the claim (43 base64url characters, sha256 stored, 10 minutes) rides in `https://<team>/app-setup#c=<claim>`; `suggestTeamSlug` and `teamSlugOk` (the relay's label rule). **Erasable TypeScript, imports only `drive-broker.ts`** | `docs/decisions/20261126-desktop-create-team.md` |
| `signing.ts` | canonical JSON (signed JSON documents, e.g. ax-hostd job `cpSig`) and the signing strings (`register`, `rotate`, `reattach`) | control-plane 3.5.2, isolation §6.1 |
| `vectors.ts`, `vectors/vectors.json` | test vectors for other implementations (Go: mycel-enroll, ax-hostd): canonical JSON, signatures from a fixed RFC 8032 test seed, tenant-command gate cases, enroll documents | — |

Rules:

- Additive changes only once a field is in use (new optional fields, new commands). A removed or renamed field needs a
  new version (`v: 2` / `format: 2`).
- **plan.json: a new optional field is not free.** The Go reader (`native/internal/plan`, used by mycel-ctl apply-plan,
  the launcher) refuses a key it does not know, even with a `null` value, and a refused plan fails
  `apply-plan` (the previous plan stays) and, in an enroll answer, the whole enroll. So a new plan.json field has no
  zod default (parsing must not add it), and the control plane writes it only to a tenant whose kit knows it:
  `TenantStatus.rootVersion` for apply-plan, `EnrollRequest.kitVersion` for an enroll (`""`/unknown = older). Fields
  and the first kit that reads them: `speechFreeHours`, the first release after 0.4.0-beta.10.
- Signed strings are UTF-8, signatures Ed25519 in standard base64. Signed JSON documents use `canonicalJson()`.
- `TenantStatus` never carries conversations, file names, people's names, mail addresses, IP addresses or tokens: it is
  a strict schema, an extra field fails.
- `bun scripts/cloud-protocol-vectors.ts` rewrites `vectors/vectors.json`; `tests/unit/cloud-protocol.test.ts` fails
  when it is out of date.
