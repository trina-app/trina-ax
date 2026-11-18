# Jobs and dev servers in shared chats; a chat's commands reach its own dev server

- Date: 2026-11-18
- Status: accepted
- Supersedes: "Left out: jobs and dev servers in shared chats" and "No jobs and no dev servers in a shared chat" of
  [Commands run in shared chats](20261118-devenv-shared-chats.md); "a later command cannot reach the dev server" of the
  archive's [Dev environment on a Mac team server](../DECISIONS.md) and of the srt preview entry
- Branch: feat/devenv-shared-jobs-mac-localhost (the owner, 2026-11-19: "Claude Code is the floor"; QA TC-4989, TC-4990)

- **Ask:** Claude Code starts `npm run dev` in the background and curls it from its next command. Trina refused `job`
  and `background` in every shared chat (team project chats are shared by default), and a later command could not
  reach the dev server it started (Mac: the run may connect only to its own port; Linux: each run has its own network
  namespace).
- **Rule, shared chats** (`devenv/srt/runner.ts`): a job or dev server of a shared chat follows the rules of a shared
  chat's command. Its view is the one of everyone who sees the chat (`sharedFolderView`), it writes only in the project
  folder or the chat's shared work folder, and nothing personal is mounted. When it is asked for, what it may read joins
  the answer's record (`sharedRowStart` → `SharedRun.noteReads`), and the row keeps the access hash and `shared_key`
  (migration 421): the hash of who sees the chat, what all of them may read there and the folder
  (`sharedLogKey`). The tracker rebuilds who sees the chat from the chat for every check (`devenv/shared-chat.ts`, the
  same functions as the turn: `chatAudienceOf`, `peopleAudience`), so any change of its people or their access stops it
  (the starter leaving or losing access, someone joining who cannot open what it sees, a folder rule, the chat no
  longer shared); the access hooks check at once (`admin/devenv-hooks.ts`, `chat/people-share.ts`). A job that waited in
  the queue starts only while the hash and key are still the ones recorded.
- **Rule, its results:** its notice goes to the person who started it (as before). The AI gets its exit code and log
  tail on the next `box_shell` call in that chat, whoever makes it, only while the chat's people and view have the same
  key, and only after what a run there may read joined that answer's record; a job of an earlier audience is never
  told to a new one. The project page shows no log line of it (its readers are not the chat's people); the starter's
  own list does.
- **Rule, its logs:** a shared chat's runs use the logs folder of their key (`devenv/chat-logs/<chat>/<key>`,
  `config.ts sharedLogs`; read-only in a run): a later command of the same people reads a job's log with
  `tail $TRINA_LOGS/<name>.log`; another audience gets another, empty folder. A command's own output files are removed
  when it ends, as are each run's home and temp folder (a job's when its row ends, `dropRowRun`). The disk clean-up
  removes an unused logs folder after a few days.
- **Rule, preview:** a person who sees the chat now may open a shared chat's dev server when a run of theirs there
  would have the row's key and access hash now (`sharedPreviewer`: the same view and the same writes; a guest only when
  they pass the same check), and its starter may still use the dev environment (`previewAllowed`). Anything else fails
  closed. A person who may only read the project never drives the dev server of one who may write it (the key counts
  reads and writes alike, so it is not enough: security review of #1336). A private chat's dev server stays its
  starter's.
- **Rule, reach** (`reachTargets`): a command reaches on localhost the ports of the running jobs and dev servers of the
  same chat and folder whose view is its own, and nothing else. A person's own chat: the person's own rows that are
  not a shared chat's, with the access hash of a run there now (a run from before the person's access narrowed is
  never reached; the tracker stops it). A shared chat: the rows of the same key and the same access hash as a run of this person there now (the same writes), whoever started them. A private run
  never reaches a shared row and the other way round. At most 8 ports.
  - macOS: the port is the row's slot port (`$PORT` of that run). `srt-mac.mjs` adds an outbound rule per port in
    `TRINA_REACH_PORTS` (connect only, never bind or accept; a bad list fails closed). A slot whose port a living run
    may reach is not given to another run while that run lives (`system-mac.ts` pick), so a later run on that port is
    never reached. pick() reserves the slot it gives until that run's state is written, so two runs started at once
    never get the same slot (it could before this change, across the awaited ACL grant). The real Seatbelt check is in `tests/unit/dev-env-srt-mac.test.ts`.
  - Linux: the port the AI named (`port`, kept in the row). `mycel-sandbox port-bridge` (portbridge_linux.go) waits
    for the new run's sandbox network namespace (where srt's relay listens), listens on 127.0.0.1 and ::1 there with no
    capabilities and copies to the dev server's forwarder (port-forward, the preview's), which reaches only that port
    of that run. The command waits up to 5 s for it (bash `/dev/tcp`). It ends with the command. Only with the sandbox
    helper and run units (not with `MYCEL_DEV_ENV_SRT_DIRECT`).
- **Why:** owner rule 2026-11-19, Claude Code is the floor. What stays is what keeps one person's data from another:
  the shared view, the audience checks, no reach across chats or people.
- **Known:** a Mac that has not run the installer again has the old `mac.mjs`, which ignores `TRINA_REACH_PORTS`: no
  reach there until then (fail closed). Bridges and forwarders end with a server restart; the next command starts them
  again. A command that itself listens on a bridged port gets "address in use".
- **Tests:** `tests/unit/dev-env-shared-jobs.test.ts` (the fence, the record, results, logs, the audience changing,
  the starter leaving, a queued job, preview, reach on Linux and macOS), `tests/unit/dev-env-srt-mac.test.ts` (the
  rules, real Seatbelt, slot holds), `native/cmd/mycel-sandbox/portbridge_test.go`; Docker suite `tests/linux/srt-attack.ts`
  S16-S16d (logs folders per audience, read-only) and L1 (no reach between runs without a bridge); spike VM
  `tests/linux/srt-vm-preview.ts` P8 (the bridge on a real server).
- **Version impact:** minor (new behaviour in shared chats; a migration that adds two columns).
