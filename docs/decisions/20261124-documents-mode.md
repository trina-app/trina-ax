# Documents mode: where the dev environment is off, commands still build documents

- Date: 2026-11-24
- Status: accepted
- Supersedes: "nothing turns on by itself" in [20261118-run-code-skills-subagents.md](20261118-run-code-skills-subagents.md),
  for this one capability only
- Branch: feat/doc-kit-everywhere (owner, 2026-11-24: "해야지", after docs/AGENTS/plan/20261124-0314-doc-quality-all-situations.md)

- **Ask.** Word, PowerPoint and Excel files should come out at the same quality on every install, in every chat, even
  where a team never turned the dev environment on. The document skills (docs/decisions/20261124-doc-skills.md) need
  a run: before this, a person with the dev environment off got Markdown converted by `make_file`.
- **Rule.** Where the dev environment is installed (`MYCEL_DEV_ENV=1`) but off for a person (the team turned it off,
  an older team never turned it on, or the person is out of its scope), `box_shell` runs in **documents mode**
  (`devenv/setting.ts commandMode`):
  - no network (offline, whatever the team's sites or the call's `request_sites` say);
  - no team folder: the run sees only the chat's work folder (`chat:work/`), also in a project chat and a shared
    project chat. The AI copies a file in with `copy_files`, which checks the person's access as any copy does, and
    hands the result over with `save_work_file`, which runs the same checks as any saved file;
  - foreground commands only: no jobs, no dev servers;
  - a skill's bundled scripts are not offered there (they live in the team folder);
  - not for guests (deferred), not in scheduled runs, template runs or draft chats (unchanged).
  The dev environment, when it is on for the person, works as before ("full" mode).
- **This turns one capability on without an admin step.** Before, the dev environment and everything in it waited for an
  admin's switch and the srt warning (20261118-run-code-skills-subagents.md: "nothing turns on by itself"). Documents
  mode is on for every team on a server with the dev environment installed. Why it is acceptable: it is far narrower
  than the dev environment (no network, no credentials, no team folder), and it is what makes documents the same in
  every chat. The server operator turns it off with `MYCEL_DOCUMENTS_MODE=0`; there is no team switch (owner: lean UI).
- **The page render, on every install.** LibreOffice draws the pages outside the run, in the converters' bwrap with no
  network and no team files, inside the product's seccomp filter (the sandbox helper, `listen` kept for LibreOffice's
  own pipe), with a throwaway profile: one font table from Office fonts to the kit's (Carlito, Caladea, Liberation,
  Noto CJK), the kit's fonts linked in where they are not system fonts, macros off (`files/office-profile.ts`).
  LibreOffice comes from the list's `office-view` group: Debian 13 at least at DSA-6635-1, Ubuntu 24.04 and Debian 12
  at their newest (an exploit in the render reaches no team data and no network).
- **Tests.** `tests/unit/dev-env-srt.test.ts` (documents mode: offline, no team folder, work folder, no job, dev server
  or site), `tests/linux/srt-attack.ts` D1-D4 (real srt), `tests/unit/office-profile.test.ts`,
  `tests/unit/system-packages.test.ts`.
- **Version impact.** minor: documents are designed for more people; a root update (the package list).
