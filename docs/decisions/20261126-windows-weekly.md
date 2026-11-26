# The Windows installer ships about once a week; every other download ships with every release

- Date: 2026-11-26
- Status: accepted
- Supersedes: none
- Branch: ci/windows-weekly (the owner, 2026-11-26; plan [20261126-0332-windows-weekly](../AGENTS/plan/20261126-0332-windows-weekly.md))

- **Ask:** the owner: at most one release a day, and the Windows installer signed (SSL.com eSigner, tier 1 = 20
  signings a month) and published only about once a week. The Mac app, the server and the phone keep shipping with
  every release. Automatic, no human step on a normal day.
- **Why:** a Windows build signs 3–4 files (the app exe, the uninstaller, the installer; a retry signs again). One
  release a day would be 90–120 signings a month; weekly is 12–20, inside tier 1.
- **Rule:**
  - `prepare` decides from the repository's GitHub Releases only (no other state, `scripts/release/windows-cadence.ts`):
    the installer goes in when the last release on this channel with it is 7 or more calendar days old (Korea), when
    there is none, or when signing is on and that installer is unsigned (the first signed one goes out at once).
  - A tag message line `Windows: yes` (alone, outside code) sends it on any day, `Windows: no` leaves it out; the line
    leaves the notes. The manual run's `windows` input wins over the line. A run again of a published tag does what its
    first run did: a version's office manifest never changes its Windows app.
  - The plan guard: signing on, (signed Windows releases of the last 30 days + 1) x 4 over the monthly limit
    (`WINDOWS_SIGNING_MONTHLY_LIMIT`, default 20): an automatic day leaves Windows out with a warning, `Windows: yes`
    stops the release before anything is built.
  - Without a Windows build the office feed names the channel head's `windows` again (`publish.ts --keep-windows`; its
    files stay in that version's folder). Every reader keys on `windows.version`, so offices, Linux servers and the
    desks' Windows apps keep offering and updating to that build. No head, or a head without a Windows app, stops the
    publish rather than dropping Windows from every later release.
  - The GitHub Release then has no installer and starts with the line "**Windows:** no new Windows installer in this
    release …; the current Windows installer is the one of vX." Windows is not listed as a missing download.
- **Left out:** a separate state file or variable for "last Windows date" (the releases already say it); counting by
  the eSigner billing month (rolling 30 days is close enough and errs to the safe side); the website (another repo)
  already offers the newest release that has a Windows installer.
- **Tests:** `tests/unit/windows-cadence.test.ts` (the line, the PE signature check, the rule, the command, a carried
  Windows app offered by a server and accepted by the desk app, the workflow's wiring).
- **Version impact:** none (release CI only).
