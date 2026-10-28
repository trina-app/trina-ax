# Trina AX

Instructions for coding agents that work in this repository.

- Product id in code is `mycel` (folders, sockets, `MYCEL_*` environment variables). Trina branding is in
  `editions/trina/branding/` and is applied at build time to `shared/src/source.ts` and
  `shared/src/release-channel.ts`.
- Read [docs/REPOSITORY-RULES.md](docs/REPOSITORY-RULES.md) before you add a feature. Design decisions are in
  [docs/DECISIONS.md](docs/DECISIONS.md); file ownership by area is in [docs/WORKPLAN.md](docs/WORKPLAN.md).
- Do not commit secrets, customer data, real customer addresses or personal paths.
- Licence: AGPL-3.0-only, except `shared/src/cloud-protocol/` (MIT). Keep LICENSE, NOTICE and dependency notices.
- Checks: `bun run typecheck` and `bun run test:unit`.
