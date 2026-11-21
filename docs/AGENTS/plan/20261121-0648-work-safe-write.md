# A safe way for the server to write into a chat's work folder (P2's hard prerequisite)

- Date (UTC): 2026-11-21 06:48
- Branch: `feat/work-safe-write` (off `feat/shared-chat-attach-work-file` 57e5a4b1c, #200's head)
- Status: in progress
- Where: server (devenv: a new module `devenv/work-write.ts`, a small record `devenv/srt/copied-in.ts`, the srt
  settings and the runner), tests/unit, tests/linux. Why: the dev environment and the AI's file tools are core
  (docs/REPOSITORY-RULES.md)
- Version impact: **none** on its own. A module that nothing calls yet; P2 (`feat/places-copy`) calls it. The srt
  settings get one optional read-only folder, used only by this module
- Plan it serves: [20261121-0615-chat-places-as-paths.md](20261121-0615-chat-places-as-paths.md) ("After the
  independent review", must-fix 3 and 5)

## Goal

P2 lets `copy_files` copy a team file, a chat file or a whole folder (an HTML file and its images folder) into
`chat:work/` ($TRINA_WORK). The work folder is written by sandboxed commands at any time. The server cannot write
there by path: Node/Bun has no `openat`, so every folder on the way is looked up again by name, and a command can swap
one for a link to a server folder between the check and the write (an `O_CREAT|O_EXCL` would then make a file outside
the work folder, as the server, which may write far more than the box). `safe-ops/broker.ts` would avoid that with
`openat2`, but it is Linux only, and Mac team servers are supported.

This PR builds the one function P2 calls, `writeIntoWork`, so that a write into the work folder can only reach places
the box could already write.

## Design: the write runs inside the sandbox (review option a)

1. **The server stages** a copy of the source in a new server folder `<base>/devenv/stage/<id>/item` (0700, files
   0600). Every file is read from one checked descriptor: `O_NOFOLLOW`, a regular file with one link, and the kernel's
   path of the open file (`openFilePath`: /proc/self/fd on Linux, F_GETPATH on macOS) must be **exactly** the path the
   walk expected, so a folder swapped for a link during the walk refuses the whole copy. A team file passes the lstat
   of its permission check (`openToRead(abs, seen)`, as every team read). Links, devices, pipes, sockets and
   hard-linked files are never copied (a folder copy skips them and says so). Names are checked (no empty part, `.`,
   `..`, control characters, more than 255 bytes). The quarantine hash of each file is checked (a download-only
   artifact is not copied in).
2. **Limits before anything is written:** each file at most the read limit, the call at most 1 GB and 2,000 files, and
   the turn's write limits when the caller passes them. Over a limit, nothing is copied and the error names the limit.
3. **A box command copies it in** with the box's own rights: the runner's normal `runCommand` in the space `spaceOf`
   gives (it makes the work folder; a shared chat's run records what it may read, as every command does). Its srt
   settings get the stage folder **read-only** (a new `stage` input: in `allowRead`, never in `allowWrite`;
   `settingsProblems` refuses a stage outside `<base>/devenv/stage/` or a writable one). The command is a fixed
   script with quoted arguments: `mkdir -p` the parent, pick a free name (`name (2).ext`, never overwrite), `cp -R -P`
   the staged item, remove a half-made copy on failure, print where it landed. A link a command left in the work
   folder can now lead the copy only where the sandbox lets that box write. macOS: the stage folder gets the dev
   accounts' ACL like the writable folders (`SpawnSpec.readable`), and it sits in `<base>/devenv`, whose ACL it
   inherits.
4. The stage folder is removed when the call ends (and leftovers older than an hour at the next call).

Why not (b), a macOS path in the broker: it needs new native code (a Go `openat` walk with `O_NOFOLLOW` per part and
`fstatat` checks), its own fuzzing on two kernels, and it would be a second writer next to the box with the server's
rights. (a) reuses the one fence that already decides every command's writes on both platforms, and costs a command
slot per copy, which is fine for an explicit copy. (b) stays the fallback if staging proves impossible on a Mac.

## Copied-in provenance per workspace key (must-fix 5)

A copy into a **shared** chat's work folder records its read group `{c: who saw the chat, s: the sources}` under the
workspace key (the folder `sharedWorkOf` names) in a server-only file `<base>/devenv/copied-in/<chat>/<key>.json`
(hidden from every run, as the whole base folder is). It is written **before** the copy (a crash mid-copy over-records,
never under-records). From then on:

- every run on that key (`noteSharedRun`: commands, jobs and dev servers asked for in a turn, and the job results a
  turn reads, `noteSharedReads`) records the same groups again into its own answer, as y groups (a read card's yes
  covered them), through a new `SharedRun.noteCopied`. A run whose turn cannot record them does not start (fails
  closed). A queued job that starts out of a turn recorded them when it was asked for;
- P1/P2's `read`/`list` of `chat:work/` call the exported `noteCopiedIn` (same rule);
- a new key (people changed) has no record: its folder is new and empty;
- the record goes with the chat (`forgetChatWork`).

## API for P2 (exported from `server/src/devenv/work-write.ts`)

```ts
writeIntoWork(ctx, target: { userId, chatId, project, shared?, expect?: WorkFolder }, dest: string,
  source: { kind: 'file', abs, seen?, name? } | { kind: 'folder', abs, include?(rel, kind) },
  o?: { sources?: ReadSource[]; maxFileBytes?; turnLeft?: { bytes, files }; signal? })
  → { path, files, bytes, skipped: { path, why }[] }
noteCopiedIn(ctx, { chatId, shared, workRoot }): boolean
copiedInOf(chatId, workRoot): CopiedGroup[]
validWorkRel(dest): string
WORK_COPY_MAX_BYTES (1 GB), WORK_COPY_MAX_FILES (2,000)
```

`expect`: the work folder the resolver showed the person; another one now (the people changed) refuses. `include`:
the caller's permission check per entry (P2 passes the folder rules and adds `boundaryFolders()` to `sources`).
`sources` is required in a shared chat (the caller's read card decides; this module records).

## Scope

In: the module, the stage settings, the record and its re-noting, tests. Out: `copy_files` and the cards (P2), the
resolver and reads (P1), `chat:files/` writes.

## Decisions

None new: this implements must-fix 3 and 5 of the reviewed plan. The plan's text says "0400" for the staged files;
they are 0600, because the sandbox already gives the run the stage folder read-only, and `cp` keeps the mode, so 0400
would leave read-only copies the AI's later commands could not edit.

## Risks

- A copy takes a command slot and the root lock of the work folder: it waits behind a running command of the chat,
  and says "the dev environment is full" like a command when no slot is free.
- srt's own write denies (`.git/hooks`, shell rc files) in a copied folder make the copy fail; the half-made copy is
  removed and the error says so.
- No migration.

## Tests

- `tests/unit/devenv-work-write.test.ts` (fake system that runs the script with `sh`): file and folder (HTML and its
  images folder) copies, no overwrite, destination traversal, names, an inner link, a device-like entry, a hard link,
  a link swapped in at the root and mid-walk, limits (count, bytes, per file, turn), quarantine, the stage folder
  read-only in the settings and gone afterwards, the server never writing into the work folder itself, a key change
  when people change, provenance recorded and re-recorded on later runs (and a run refused when it cannot be), macOS
  settings (darwin platform) and the ACL grant of the stage folder.
- `tests/linux/srt-work-write.ts` on real srt (bwrap) in the image of `tests/linux/Dockerfile.srt`: a link to a team
  folder or the server's data at the destination's root and mid-path cannot make the copy land outside what the box
  may write; the stage folder is read-only in the run.
- `bun run typecheck`, `bun run check:prepush`, the devenv unit tests with Bun 1.3.12.

## Result

Filled in at the end.
