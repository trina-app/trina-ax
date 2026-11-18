# Group and project skill scripts: never run, never copied (server side)

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (extends docs/decisions/20261118-run-code-skills-subagents.md)
- Branch: fix/skill-scripts-copy-refusal (QA TC-4932)

- **Why.** A group skill is written by any member of the group, a project skill by anyone who may write the project
  folder. A script runs with the reading person's access and allowed sites, so a script one member planted could read
  and send out another member's files. #1289 kept their scripts out in the prompt only.
- **Runs.** Every box_shell run (a person's chat, a shared chat, a job, a dev server) hides every
  groups/<folder>/skills and projects/<name>/skills folder on disk, in any letter case (srt denyRead through
  `RunWrites.othersSkills`, folders from `othersSkillRoots`). A command cannot read, copy or run a file there however it
  names it. A folder that appears later changes the run's view; the tracker then stops the person's jobs, as for any
  view change. A command whose text names such a folder (or a cwd in the project's own skills folder) is refused before
  it runs, with the reason, so the AI does not retry in other words.
- **File tools.** An AI-side save (write, edit, a conflict copy) outside those folders whose content is a copy of a file
  in one of them is refused: compared after line endings and trailing spaces are evened out, Markdown files left out
  (the instructions may be quoted), text under 24 characters left out (too short to tell from a coincidence). Saves in a
  skill folder keep their own card (skills/guard.ts); people's saves on the Files screen are not checked; copy and move
  of a skill folder's files were refused already.
- **Not covered.** A script the AI rewrites in other words: the rule tells it never to. skill_files' take-out of a file
  from a skill folder stays as it is (the person answers its card).
