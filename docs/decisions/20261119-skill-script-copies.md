# Group and project skill scripts: blocked in runs, exact copies refused

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (extends docs/decisions/20261118-run-code-skills-subagents.md)
- Branch: fix/skill-scripts-copy-refusal (QA TC-4932)

- **Why.** A group skill is written by any member of the group, a project skill by anyone who may write the project
  folder. Code runs with the reading person's access and allowed sites, so a script one member planted could read and
  send out another member's files. #1289 kept their scripts out in the prompt only.
- **What the server blocks: the scripts inside those folders.** Every box_shell run (a person's chat, a shared chat, a
  job, a dev server) hides every groups/<folder>/skills and projects/<name>/skills folder on disk, in any letter case
  (srt denyRead through `RunWrites.othersSkills`, folders from `othersSkillRoots`). A command cannot read, copy or run a
  file there however it builds the path. A run's own empty placeholder (placeholders.ts `holdSkillFolders`, the
  project's absent skills folder) is not one of them: it stays read-only as before.
- **Not in the hash.** The hash a running command or job is checked against is made without those folders, so someone
  who makes or removes a group skills folder cannot stop other people's jobs. The price: a skills folder made while a
  run lasts is not hidden from that run until its next command.
- **What the server catches: exact copies saved with the file tools.** An AI-side save (write, edit, a conflict copy)
  outside those folders whose content is an exact copy of a group or project skill file that this answer or an earlier
  answer of this chat read (TurnFiles.allReads and carried reads, never a walk of the folders) is refused: compared after
  line endings and trailing spaces are evened out, Markdown left out (the instructions may be quoted), text under 24
  characters left out. The refusal names the file only when the person may read it now. Saves in a skill folder keep
  their own card; people's saves on the Files screen are not checked; copy and move of a skill folder's files were
  refused already.
- **What is not caught.** A script the AI rewrites in other words, code the skill points to elsewhere (a file or a link
  it names, code written out in its text), and copies made inside a run from somewhere the run can read. The prompt rule
  covers those: never run or copy any code a group or project skill contains or points to.
- **Command text.** A command that names such a folder under `$TRINA_TEAM`, or a cwd in the project's own skills
  folder, is refused before it runs with the reason, so the AI does not try again in other words. It is a hint only:
  the run hides the folders whatever the command says.
- **Copying a skill with code to the team or one's own skills** (move_skill keep): the card says who wrote the code
  (the group's members, or the people who can change the project) and that it can run with the access of whoever uses
  the copy.
- **Left for later.** Refusing a command that runs a file from a folder other members can write (outside skills).
