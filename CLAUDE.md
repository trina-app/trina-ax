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
- A feature that needs a system package or a downloaded program (an apt package, a font, a browser, node) adds it to
  the one list `scripts/system/packages.json` (a downloaded program with its version and a sha256 per platform), never
  to one install script. The image, `install-linux.sh`, the dev environment and the office Mac all install from it;
  `tests/unit/system-packages.test.ts` fails when a script keeps a list of its own. A changed list is a root update.
- Versions follow Semantic Versioning 2.0.0 (https://semver.org/). Pick a release number and bump versions only as
  [docs/RELEASE-CI.md](docs/RELEASE-CI.md) "Version numbers" says, and state every PR's version impact (patch, minor,
  major or none, with one reason).

## Branches and the dev server

- Work on a feature branch. Open the PR into `dev`, not `main`.
- Plan first. Before you write code for a feature or a fix, write a plan in `docs/AGENTS/plan/` named
  `<timestamp>-<feature>.md` (`date -u +%Y%m%d-%H%M`, e.g. `20261107-0830-room-message-links.md`) and commit it as the
  first commit on the branch. Format and template: [docs/AGENTS/README.md](docs/AGENTS/README.md). Link the plan in
  the PR.
- `dev` takes merges without waiting for full CI. Before you merge, run `bun run typecheck`, `bun run check:i18n`
  and the unit tests for the area you changed.
- Keep PRs small. Before you add a migration, check the highest number in `server/migrations/` on `dev`: two files
  with one number stop the server.
- After a merge into `dev`, CI (`.github/workflows/dev-build.yml`) builds the server bundle (about 5 minutes) and the
  dev server installs it within 1 minute: https://potenlab.trina.app (Lightsail `trina-ax-test-1`). Test there, with
  test data only.
- If the new build fails its health check, the dev server goes back to the last good build by itself. Status:
  `/var/lib/trina-dev-update/status.json` on the dev server.
- `main` and releases: only through a PR `dev -> main` with full CI green. Only the release owner merges it and cuts
  a release.
- Never deploy a dev build to potanlab.trina.app or any customer server. Never use the release key for dev builds.
  Do not change `dev-build.yml` without the release owner.
