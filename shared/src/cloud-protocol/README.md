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
| `tenant-commands.ts` | the `mycel-ctl` commands ax-hostd may run for the control plane (`tenantCommand`), their args, stdin and output, `TenantStatus`, the gate `tenantCommandProblem()` | control-plane 3.5.3 |
| `common.ts` | shared field rules: `TenantId` (ULID), `TeamSlug`, `RelayTeamId`, `PlanId`, `TimeZoneName`, `AccountUsername` (= the team server's username rule), `HttpsUrl` (https, http only to this machine), `CredentialKind`, `CLOUD_DEFAULT_CREDENTIAL_KINDS` | — |
| `files.ts` | `plan.json` (runtime field names + the control plane's `maxActiveMembers`, `display`, `links`; the team server reads plan.json with this schema), `notices.json`, `<data>/relay/registration.json`, `PlanResources` (ax-hostd's VM resources), `PlanLimits` | control-plane 3.5.6, linux-runtime 3.8.5 |
| `release.ts` | `server/<channel>.json` and `server/<version>/release.json` (the server's `ReleaseFeed` + optional fields) | control-plane 3.7.1, linux-runtime 3.6.3 |
| `relay-ops.ts` | relay operator API: types, `opsSigningString`, the `Authorization: MycelRelayOps` header, scopes, plain validators. **Erasable TypeScript, no zod** (the relay loads it with Node type stripping) | control-plane 3.6.2 |
| `relay-ops-schema.ts` | zod mirrors of the operator API bodies for the control plane | control-plane 3.6.2 |
| `signing.ts` | canonical JSON (signed JSON documents, e.g. ax-hostd job `cpSig`) and the signing strings (`register`, `rotate`, `reattach`) | control-plane 3.5.2, isolation §6.1 |
| `vectors.ts`, `vectors/vectors.json` | test vectors for other implementations (Go: mycel-enroll, ax-hostd): canonical JSON, signatures from a fixed RFC 8032 test seed, tenant-command gate cases, enroll documents | — |

Rules:

- Additive changes only once a field is in use (new optional fields, new commands). A removed or renamed field needs a
  new version (`v: 2` / `format: 2`).
- Signed strings are UTF-8, signatures Ed25519 in standard base64. Signed JSON documents use `canonicalJson()`.
- `TenantStatus` never carries conversations, file names, people's names, mail addresses, IP addresses or tokens: it is
  a strict schema, an extra field fails.
- `bun scripts/cloud-protocol-vectors.ts` rewrites `vectors/vectors.json`; `tests/unit/cloud-protocol.test.ts` fails
  when it is out of date.
