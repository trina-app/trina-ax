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
  people sees any team folder they all may read, read-only, and starts in the chat's own work folder. When nothing is
  common, only the work folder. Writes: only where the person may write in that set, and only in the project folder
  (owner decision Q0 (b) as before; never a skill folder); a people chat writes no team folder. Never a personal folder,
  the person's own included, never `.system/`, never another chat's work folder.
- **Rule, the audience changes:** every command builds its view again from the audience read at that moment, and the
  tracker compares a running command's view with the current one (`srt/runner.ts` `accessHash`, key per chat): someone
  joining who cannot read a folder in it, or someone leaving (the view would widen), stops the command with "the dev
  environment setting or your access to this folder changed". Someone in the audience who cannot be loaded, or a
  person no longer in it, gives no run (fail closed).
- **Rule, the answer's record:** before a run starts, every folder it may read joins the answer's record with who sees
  the chat (`SharedRun.noteReads` → `chat/shared-answers.ts`), as a file read does; a record that cannot be written
  stops the run. Someone who joins later and cannot read one of those folders does not get that answer.
- **Rule, nothing personal:** a shared chat's runs have a home and logs per chat (`devenv/chat-home/<chat>`,
  `devenv/chat-logs/<chat>`: caches, `HOME`, `TMPDIR`, `TRINA_LOGS`), not the person's (their npm or git config, their
  other chats' logs). They are cleaned like person homes (`system/devenv-clean.ts`) and removed with the chat. The
  environment is built from nothing as before and names no folder of the person. **Credential cards: off.** A command
  that would use a login (git push, npm publish, ssh …) is refused in a shared chat with no card (a run holds no
  credentials anyway); it is the simpler of the two safe options. No jobs and no dev servers in a shared chat (their
  rows, logs and notices are per person); foreground commands only, up to 1800 s. Results of the person's jobs are not
  given to the AI there. The site card stays and goes to the person of the turn only, like every card of a shared chat.
- **What others see:** the command and its output, like any answer; only folders they all may open are mounted.
- **Unchanged:** the flag, the team setting and `mayUseDevEnv` (checked again on every call), never in a scheduled,
  template or restricted run, the in-app browser stays off in shared chats. The instructions of a shared chat drop "the
  dev environment" from what is not available when `box_shell` is offered, and say what a command sees there.
- **Left out:** jobs and dev servers in shared chats; a per-command credential helper.
- **Tests:** `tests/unit/dev-env-shared-access.test.ts` (the view against the rules for several audiences, the record,
  the settings check, the environment), `tests/unit/dev-env-shared-chat.test.ts` (a whole shared turn with a fake srt
  system, a restricted subfolder and the person's own folder kept out, writes, the audience changing between calls and
  during a command, a people-shared chat, no credentials or job results). Real srt runs are Linux only (Docker suite).
- **Version impact:** minor (a shared chat can run commands).
