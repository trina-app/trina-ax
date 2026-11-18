# Commands run in shared chats, seeing only what everyone in the chat may open

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "never in a shared chat" gate of [Dev environment on srt](../DECISIONS.md) (`chat/turn.ts`); the line
  "shared project chats have no dev environment" of the archive's project-page entry
- Branch: feat/devenv-shared-chats (the owner, 2026-11-18, QA TC-4848)

- **Ask:** since 2026-11-13 team project chats are shared by default, and the dev environment (`box_shell`) was never
  offered in a shared chat, so in a project chat the AI could not run any command (it could not unzip a zip file).
  Turn it on in shared chats, with nothing reaching the other people in the chat that they could not open themselves.
- **Rule, what a run sees** (`devenv/srt/access.ts` `sharedFolderView`, the same folder rules as every run,
  `RuleSet.access`): a folder is readable only where the person of the turn AND every person who sees the chat now
  (`chat/turn.ts` sharedAudience: the project's audience, or the creator and people of a chat shared with people and
  groups) may read it. A shared project chat sees only its project folder (the run starts there); a chat shared with
  people sees any team folder they all may read, read-only, and starts in a work folder of its own for the people who
  see it now and what they may read (`devenv/work-shared/<chat>/<key>`, `srt/config.ts` sharedWork, the key = its
  people and the hash of the shared view, `srt/runner.ts` sharedWorkOf): never the chat's private work folder
  (`devenv/work/<chat>`, which may hold copies of the person's own files from before the share). A different set of
  people, or the same people after someone's access narrowed (out of a group, a folder rule changed), gets a different,
  empty folder, so nothing a run copied there while they could read it reaches a run that could not (the same people
  with the same view get theirs back). A new rule folder anywhere they read also changes the view, and with it the
  folder (fail closed: the files there are not lost, the folder is kept until the chat is purged or cleaned). When nothing is common, only that work folder. Writes: only where the person may write in that set, and only in the project folder
  (owner decision Q0 (b) as before; never a skill folder); a people chat writes no team folder. Never a personal folder,
  the person's own included, never `.system/`, never another chat's work folder.
- **Rule, the audience changes:** every command builds its view again from the audience read at that moment, and the
  tracker compares a running command's view and people with the current ones (`srt/runner.ts` `accessHash`, key per
  chat, the hash holds the key of its people): any change of who sees the chat stops the command with "the dev
  environment setting or your access to this folder changed". The check runs at once after every access change
  (`admin/devenv-hooks.ts`, an `onAccessChange` hook: a project's people, folder rules, groups, accounts) and after a
  people-shared chat's people are saved (`chat/people-share.ts`), not only at the next poll (up to 10 s later). People
  who change between choosing the work folder and the run: no run ("the people of this chat changed"). Someone in the audience who cannot be loaded, or a
  person no longer in it, gives no run (fail closed).
- **Rule, the answer's record:** before a run starts, every folder it may read joins the answer's record with who sees
  the chat (`SharedRun.noteReads` → `chat/shared-answers.ts`), as a file read does; a record that cannot be written
  stops the run. Someone who joins later and cannot read one of those folders does not get that answer.
- **Rule, nothing personal:** a shared chat's command has a home and logs of its own (`devenv/chat-home/<chat>/<run>`,
  `devenv/chat-logs/<chat>/<run>`: caches, `HOME`, `TMPDIR`, `TRINA_LOGS`), made fresh for it and removed when it ends,
  never the person's (their npm or git config, their other chats' logs) and never an earlier command's (what it left
  in its home could come from folders a later audience cannot read). So caches are not kept between commands there
  (an `npm install` downloads again). One a crash left behind is removed by `system/devenv-clean.ts` after a few days. The
  environment is built from nothing as before and names no folder of the person. **Credential cards: off.** A command
  that would use a login (git push, npm publish, ssh …) is refused in a shared chat with no card (a run holds no
  credentials anyway); it is the simpler of the two safe options. No jobs and no dev servers in a shared chat (their
  rows, logs and notices are per person); foreground commands only, up to 1800 s. Results of the person's jobs are not
  given to the AI there. The site card stays and goes to the person of the turn only, like every card of a shared chat.
- **What others see:** the command and its output, like any answer; only folders they all may open are mounted. The
  tool's notes name only paths the run may name now, by the rules for the person and everyone in the chat path by path
  (`access.ts` sharedPathAccess) and only where the path's folder is on disk (a renamed or trashed restricted folder is
  not in the run's view, which lists only folders on disk): changes by other people since the last command (and no count of
  the others), files changed in the background or in the command's window (someone's save in a restricted subfolder
  lands there too), conflict copies. Other people's jobs and dev servers are not listed in a shared chat. The audit
  line keeps them all (admins only). A run refused by the settings check says only "refused settings (see the server
  log)" in a shared chat: the reasons name folders, a personal one too, and go to the log.
- **Processes left behind:** none outlive the command. Linux: bwrap runs with `--die-with-parent --unshare-pid`, so
  when srt ends every process of the run ends, a `setsid nohup … &` too (attack A20 in the Docker suite), and the run's
  unit (`devenv-run.service.in`, `KillMode=control-group`) kills what is left in its cgroup when its main process ends.
  macOS: each run has its own dev slot account, and `run-wrap-mac` kills every process of that account when the
  program ends, also one that left its process group; a slot is not reused while it has processes. So a shared chat's
  command cannot leave something running that reads a later audience's folders.
- **Known, as with the file tools:** a command may copy a file from a subfolder everyone in the chat may read into the
  project folder, which may have more readers later (the project folder's audience is the chat's audience, so nobody
  in the chat learns anything new; a later project member can read the copy). copy_files and move_files behave the same
  in a shared chat today; not changed here.
- **Unchanged:** the flag, the team setting and `mayUseDevEnv` (checked again on every call), never in a scheduled,
  template or restricted run, the in-app browser stays off in shared chats. The instructions of a shared chat drop "the
  dev environment" from what is not available when `box_shell` is offered, and say what a command sees there.
- **Left out:** jobs and dev servers in shared chats; a per-command credential helper.
- **Tests:** `tests/unit/dev-env-shared-access.test.ts` (the view against the rules for several audiences, the record,
  the settings check, the environment), `tests/unit/dev-env-shared-chat.test.ts` (a whole shared turn with a fake srt
  system, a restricted subfolder and the person's own folder kept out, writes, the audience changing between calls and
  during a command, a people-shared chat, no credentials or job results). Real srt runs are Linux only (Docker suite).
- **Version impact:** minor (a shared chat can run commands).
