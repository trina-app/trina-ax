- **Releases**: a good stable release can now go to every server and office at once after it is out, without a new
  version: Actions › Feed › `promote` (or `bun scripts/release/hosting.ts promote stable --version X`). It ends the
  staged roll-out early, as if the release had been published with `Rollout: all`. The same workflow can also hold,
  resume or show a release's roll-out, so this no longer needs the release key on a person's computer.
