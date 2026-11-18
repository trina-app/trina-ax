# A shared chat's commands show no proxy login and no name of a folder some people may not open

- Date: 2026-11-18
- Status: accepted
- Supersedes: none. Adds to [Commands run in shared chats](20261118-devenv-shared-chats.md)
- Branch: fix/devenv-shared-followups (QA TC-4928, TC-4929, TC-4930 on qa.trina.app)

- **Ask:** on a real server, `env` in a run showed srt's proxy login, and in a chat shared with people a limited folder
  only one of them may open showed in `ls` as an empty folder.
- **Rule, the proxy login** (`server/src/devenv/srt/proxy-login.ts`): srt 0.0.81 gives a run's command the login of its
  own network proxy in the environment. It is random per srt process (one per run), the proxy lives in that process and
  ends with the run, and only the run reaches it (Linux: through the bridge in the run's own network namespace;
  macOS: a run may connect to its own proxy port only). So it is useless outside its run and gone when the run ends;
  the Docker suite checks that two runs get different logins and that one run's login is refused in the next (S15).
  Commands need it (curl, npm, pip, git read these variables), so it stays in the environment. What a command printed
  is shown to the AI with it hidden (`<hidden>`), in every chat, and so are the log tails of jobs in the lists.
- **Rule, names** (`server/src/devenv/srt/mounts.ts`): srt hides a denied folder inside a readable one with an empty
  folder over it, so its name lists. In a shared chat's run a read-only folder that holds a denied folder is given
  entry by entry, the denied ones left out (links never given one by one); the folder itself is then only the place of
  those entries. Only the run's mounts change; the view's hash does not, so saving a file there stops no command. A
  file added to such a folder while a command runs is not in that command. The Docker suite checks it (S14).
- **Known:** in a shared project chat the project folder is writable, and a writable folder cannot be given entry by
  entry (what a command writes at its top would be lost). A sub-folder of it that some of the chat's people may not
  open still shows as an empty folder there. Its content stays hidden.
- **Rule, the send queue** (`web/src/store/sendQueue.ts`, QA TC-4930): messages typed while an answer ran pause when
  that answer is stopped or fails ("The answer didn't finish, so this has not been sent."). When the person tries again
  and that answer is no longer the newest, the pause says "This message has not been sent yet." and still waits for
  Send now (the chat moved on, as after a reload). Before, the first words stayed under the finished answer.
- **Version impact:** patch.
