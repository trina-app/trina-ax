# Documents mode: where the dev environment is off, commands still build documents

- Date: 2026-11-24
- Status: accepted
- Supersedes: "nothing turns on by itself" in [20261118-run-code-skills-subagents.md](20261118-run-code-skills-subagents.md),
  for this one capability only
- Branch: feat/doc-kit-everywhere (owner, 2026-11-24: "해야지", after docs/AGENTS/plan/20261124-0314-doc-quality-all-situations.md)

- **Ask.** Word, PowerPoint and Excel files should come out at the same quality on every install, in every chat, even
  where a team never turned the dev environment on. The document skills (docs/decisions/20261124-doc-skills.md) need
  a run: before this, a person with the dev environment off got Markdown converted by `make_file`.
- **Rule.** Where the dev environment is installed (`MYCEL_DEV_ENV=1`) and the team **never chose** it (no saved
  setting, or the row an older team got from migration 236, the one the admin's "set up before this came" notice is
  about), `box_shell` runs in **documents mode** for its people (`devenv/setting.ts commandMode`, `teamNeverChose`):
  - no network (offline, whatever the team's sites or the call's `request_sites` say);
  - no team folder: the run sees only the chat's work folder (`chat:work/`), also in a project chat and a shared
    project chat. The AI copies a file in with `copy_files`, which checks the person's access as any copy does, and
    hands the result over with `save_work_file`, which runs the same checks as any saved file;
  - foreground commands only: no jobs, no dev servers;
  - a skill's bundled scripts are not offered there (they live in the team folder);
  - not for guests (deferred), not in scheduled runs, template runs or draft chats (unchanged).
  The dev environment, when it is on for the person, works as before ("full" mode).
- **An admin's explicit choice is respected** (security review of #508). Where an admin saved the dev environment off,
  or left a person out of its scope, documents mode stays off for them too. The admin's notice for an older team says
  that documents are still built (offline, in each chat's own folder) until a choice is saved.
- **This turns one capability on without an admin step, for teams that never chose.** Before, the dev environment and everything in it waited for an
  admin's switch and the srt warning (20261118-run-code-skills-subagents.md: "nothing turns on by itself"). Documents
  mode is on for every team on a server with the dev environment installed. Why it is acceptable: it is far narrower
  than the dev environment (no network, no credentials, no team folder), and it is what makes documents the same in
  every chat. An admin turns it off by saving the dev environment off; the server operator with `MYCEL_DOCUMENTS_MODE=0`.
- **The page render, on every install.** LibreOffice draws the pages outside the run, in the converters' bwrap with no
  network and no team files, and inside the product's seccomp filter where the server has the sandbox helper
  (`MYCEL_SANDBOX_HELPER`, which every Linux install's server unit sets; `listen` kept for LibreOffice's own pipe; a
  production server without it logs that the render runs in bwrap alone), with a throwaway profile: one font table from Office fonts to the kit's (Carlito, Caladea, Liberation,
  Noto CJK), text with no language of its own drawn with the Noto CJK face of the team's language (Korean unless the
  team writes Japanese or Chinese), the kit's fonts linked in where they are not system fonts, macros off
  (`files/office-profile.ts`).
  LibreOffice comes from the list's `office-view` group: Debian 13 at least at DSA-6635-1, Ubuntu 24.04 and Debian 12
  at their newest (an exploit in the render reaches no team data and no network).
- **Tests.** `tests/unit/dev-env-srt.test.ts` (documents mode: never chosen on, saved off and out of scope off;
  offline, no team folder, work folder, no job, dev server or site), `tests/linux/srt-attack.ts` D1-D4 (real srt), `tests/unit/office-profile.test.ts`,
  `tests/unit/system-packages.test.ts`.
- **Version impact.** minor: documents are designed for more people; a root update (the package list).
