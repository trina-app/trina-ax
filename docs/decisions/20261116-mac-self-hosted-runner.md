# Release Mac jobs may run on a self-hosted office Mac, release.yml at v* tags only

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: ci/mac-self-hosted-runner (the owner: "우리 맥 쓰면 안되니?", release coordinator's conditions)

- **Ask:** GitHub's hosted macOS pools had no runners; the 0.5.10 Mac release jobs kept getting cancelled. Use our Mac.
- **Rule:** one office Mac runs a repository runner `trina-mac-1` with the single label `trina-mac-release`, chosen by the
  repository variable `RELEASE_MAC_RUNNER`. Only release.yml at a v* tag of trina-app/trina-ax may run there: a
  job-started hook on the host refuses everything else before any step, and every self-hosted job starts with a guard
  step that checks the same. Pull request checks stay on hosted runners. The runner runs as the hidden standard
  account `_trinaci` (no access to the admin's home, sandbox, pf, its own 60 GB volume) and holds no certificate or key:
  signing still comes from repository secrets into a keychain of the job. Each job's work, tool cache and HOME are
  wiped. Fork pull request workflows need approval for all outside contributors.
- **Why:** the repo is public; a self-hosted runner that takes any job lets anyone with a pull request run code on a
  Mac that holds other work and credentials.
- **Left out:** runner groups with workflow restrictions (not on the Free plan); `--ephemeral` with re-registration
  (would need a repository admin token on the Mac, readable by the runner account).
- **Tests:** docs/RELEASE-CI.md 13 (setup.sh's checks, removal).
- **Version impact:** none.
