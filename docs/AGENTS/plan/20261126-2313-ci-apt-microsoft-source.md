# CI: drop the runner's Microsoft apt source before apt-get update

- Date (UTC): 2026-11-26 23:13
- Branch: `ci/apt-ms-source`
- Status: in progress
- Version impact: none (CI workflows and one test only; nothing ships)

## Goal

The GitHub runner image ships `/etc/apt/sources.list.d/microsoft-prod.list`. On 2026-11-27 packages.microsoft.com
answered 403, `apt-get update` failed on it and the merge queue failed. Every package our jobs install comes from Ubuntu.

## Steps

1. Before each `apt-get update` (and before `playwright install-deps`, which runs one) in `ci.yml`, `feature-map.yml`,
   `team-image.yml` and `desktop.yml`, run `sudo rm -f /etc/apt/sources.list.d/microsoft-prod.list`.
2. No job needs a Microsoft package (no dotnet, azure-cli or apt-installed powershell; `shell: pwsh` on Windows runners is
   not apt). `release.yml` and `dev-build.yml` run no apt-get; `dev-build.yml` is not touched.
3. `tests/unit/ci-apt-sources.test.ts`: every run step that calls `apt-get update` or `install-deps` removes the source first.

## Checks

`bun run check:prepush`, the new test.
