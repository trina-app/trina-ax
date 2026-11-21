# The chat's files and its work folder become paths that every file tool takes

- Date (UTC): 2026-11-21 06:15
- Branch: `plan/chat-places-as-paths` (plan only, off `feat/shared-chat-attach-work-file` 57e5a4b1c; the builds get
  their own branches, below)
- Status: reviewed (go with changes, 2026-11-21); P1 in progress on `feat/places-resolver-read`
- Where: server (file service, the turn's cards, tool lists, chat files, devenv work files), shared (one path parser),
  web (step labels, links). Why: the AI's core file tools are core (docs/REPOSITORY-RULES.md)
- Version impact: **minor**. The file tools take two new kinds of path; old tools keep working as aliases; no
  existing behaviour is narrowed; one additive migration in P4 (`chat_files.replaces`, `root_id`)
- Base: the end state after the merge order #198 + #195 → #207 → #200 + #199. This plan **replaces** PR2b
  `copy_to_work` and PR2c H1 (`chat:<name>` output) of
  [20261121-0334-shared-chat-attach-work-file.md](20261121-0334-shared-chat-attach-work-file.md) (fdec6fb24). Neither
  is built.

## After the independent review (2026-11-21): go, with these changes

This section wins wherever the text below says otherwise. The owner settled both questions: project chats keep the
project folder as their only save place (`chat:files/` is read-only there), and `room:files/` waits until P1–P5 have
run for a week.

1. **Provenance cannot be laundered.** `chat:files/` names only `source:'chat'` rows (`chat_files`, people-shared
   chats). A personal chat's upload (`users/<id>/.attachments/<chat>/…`) and a `source:'team'` attachment
   (shared/src/api/entities.ts Attachment) stay **team paths**. The transcript names them by their team path, and a
   read records `sourceOf(team path)`, never `{type:'chat'}`. A `chat:files/<name>` that would match one of them is
   "not found". So in a personal or project chat `chat:files/` lists only what `chat_files` holds for that chat
   (usually nothing, or the files of a chat made private again).
2. **Versions belong to P4, which also owns the plan's only migration.** S2 (trina-ax-78) is web only and builds on it.
   - P4 adds `chat_files.replaces` and `chat_files.root_id` (indexed), with the next free component-B number at build
     time.
   - `ChatFiles.putVersion` is the only code that writes a version. A web save, a restore and an AI `write`/`edit` all
     go through it. A restore makes a new head.
   - A chain's id is its root's file_id. Every lookup (by id, by name, a link) resolves root → head.
   - `sent()`, `onlyOnHidden()` and the sweep look at the messages that carry the **root**.
   - The uploader's "own unsent upload" exemption in `open()` holds only for a row with `replaces IS NULL`.
   - `list`, `grep` and the name lookup go through a new `ChatFiles.visibleTo(userId, chatId)`, so a name carried only
     by hidden answers never shows.
   - The last 20 versions are kept, and pruning never removes the head. The chip says "Updated by <name>".
3. **The work-folder write runs inside the sandbox.** Node/Bun has no `openat`, and `safe-ops/broker.ts` is Linux
   `openat2` only, so P2 cannot write `chat:work/` from the server. Instead the server stages a read-only copy (checked
   fd, quarantine hash checked, 0400, in a server temp folder that the run is allowed to read for this one call), and a
   box command run with the box's own rights (`cp --no-dereference`, no clobber: `name (2).ext`) copies it into the
   work folder. The sandbox then decides what the box can write, exactly as for any command. A macOS path in the
   broker is the fallback if staging proves impossible on the Mac. This is a **hard prerequisite of P2**.
4. **Consumers the inventory missed, now in section 3's work:**
   - `files/sources.ts` `isTeamFilePath` (the used-files list, skill-draft links): `chat:` is never a team file (P1).
   - `tools/make-file.ts` `copyImages` (~557–586): image references inside a document resolve through the resolver
     against the source's own place, so an HTML in `chat:work/` cannot pull images from the team folder (P3).
   - Folder copies into `chat:work/` add every `boundaryFolders()` folder under the copied folder that the person may
     read to the sources, as `make_zip` does (P2).
   - The `list` own-path branch in `sharedSources` (`tool === 'list' && k === 'path'`): a `chat:` list path resolves
     before that branch (P1).
   - #207's carried reads are keyed by file id; a chain's root id is that key (P4).
   - The transcript lines (turn.ts ~5178 and ~5485, and 5232) name `chat:files/<name>` for `source:'chat'` only (P1).
   - `engine/api-links.ts` LinkGuard: `/c/` joins `ROUTE`, and `key()` keeps the `file=` parameter (P3).
5. **Copied-in provenance persists with the work folder.** A copy into a shared chat's `chat:work/` records its y
   group under the **workspace key** (`sharedWorkOf`, runner.ts ~286–296), in a small server-side record next to the
   key's logs. Every later run, and every `read`/`list` of that key, records the same groups again into its own answer
   (`noteSharedReads`), so an answer made from the copy a day later still carries it. The copy-in uses `spaceOf` (which
   creates the folder and notes the reads). P1's reads keep PR1's "look up without creating" (`workFolderAt`), and the
   write path is the one place that may create.
6. **P1's fail-closed rule is narrow.** Only the reserved prefixes `chat:` and `room:` change: they go to the resolver
   or are refused. Every other `scheme:` value keeps today's handling (URLs, connector ids). A test walks every
   PATH_ARGS key of every tool with both prefixes. **Sub-agents get no `chat:` path** (`chat_file` is in
   PARENT_ONLY_TOOLS, subagents.ts:37): the resolver refuses there. On every call the resolver checks `livePrincipal()`
   and `seesChatFiles()` again, because `ChatFiles.open()` does not check the chat.
7. **An original team path maps to its copy only through #207's `file-access` lookup.** Every other route gets "not
   found". `keepCopy`'s contract holds:
   - bytes come only from the checked fd;
   - `from` and `fromSha256` stay on the server, and `copyForViewer` strips them, from version rows too;
   - a 404 on a chat-file link is generic, with no Ask button;
   - `sharedCopiesNote` stays in the branch for answers that are not withheld (chat/shared.ts ~625).
   The resolver never maps a team path to `chat:files/` itself.

**Phasing after the review:**
- **P1** ships fixes 1, 4 (isTeamFilePath, the transcript lines, the list branch) and 6. Reads only: `read`, `list`
  and `grep`/`glob` of `chat:files/`, and `read` of `chat:work/` (PR1's path, now spelled `chat:work/`).
- `list`/`grep`/`glob` of `chat:work/` move to P2.
- **P2** needs fixes 3 and 5. **P3** needs the copyImages fix. **P4** carries fix 2 and the migration.

**Also in, from the review:**
- The web renders `[x](chat:files/…)` as a chip (Markdown.tsx ~562), not as an external link with an unknown scheme.
- The card and place words exist in all 6 languages.
- `rename_file`, `rename_files` and `move_files` on a chat file refuse and suggest `copy_files`.
- A test fails if a second code path opens a chat file (anything other than `ChatFiles.open` / `visibleTo`).
- Copies into `chat:work/` check the quarantine hash.
- P5: the legacy-name mapping matters only for the API engine and remote MCP. Claude Code and Codex sessions get the
  current tool list on every turn.

## Goal

Trina keeps files in three kinds of place: the team folder (`shared/`, `users/<id>/`, group and project folders), the
chat's own files (people's uploads, the AI's attached files since #200, share-time copies since #207), and the AI's
work folder (`$TRINA_WORK`, box_shell's commands). The AI's core file tools (`read`, `write`, `edit`, `copy_files`,
`move_file`, `make_file` and the other produce tools, `list`, `grep`) take team paths only. Every other place grew its
own tool: `chat_file`, `save_chat_file`, `room_file`, `save_room_file`, `save_work_file`, and two planned ones
(`copy_to_work`, a `chat:<name>` output). So the AI keeps hitting dead ends that Claude Code never has: it cannot open
its own video frames with the tool it knows, cannot hand an MP4 back in a shared chat without a special tool, and cannot
bring the asker's proposal HTML (with its images folder) into a shared chat's work folder to build a PPTX.

The owner: "fix the root, not patches; the AI decides itself". The root (independent review): the chat's places are
not places in the file permission model. This plan makes them real paths, resolved by **one resolver** that gives
every tool the same three answers it gives for a team path: where the bytes are, who can see them (the read scope),
and whether this turn may write there. Every existing card then applies unchanged.

For the person nothing new appears: no new card, no new button. The AI just stops saying "I can't".

## 1. Path grammar

Two new path families, one optional third. All are plain text in a tool's existing path argument.

| Form | Means | Shown to people (step line, card, answer) |
|---|---|---|
| `chat:files/<name>` | this chat's file named `<name>` (an upload, an AI-attached file, a share-time copy), its newest version | en "This chat › proposal.pptx", ko "이 대화 › proposal.pptx" |
| `chat:files/<file_id>/<name>` | the same, by id; the form the transcript uses when two files share a name | the same as above |
| `chat:files/` | the chat's file list (for `list`, `grep`) | "This chat's files" / "이 대화의 파일" |
| `chat:work/<path>` | this chat's work folder for this person now (as box_shell's `$TRINA_WORK`) | en "Work folder › out/promo.mp4", ko "작업 폴더 › out/promo.mp4" |
| `chat:work/` | the work folder itself (list, grep, a copy target) | "Work folder" / "작업 폴더" |
| `room:files/<name>` (phase 6, owner question 2) | the files of *this* room, only in a room's ✦ side chat | "<room> › <name>" |

- **Aliases, accepted and normalized at the parser** (never shown): `$TRINA_WORK/<p>`, `${TRINA_WORK}/<p>` and the work
  folder's absolute path as a command prints it (`pwd`), exactly what PR1's `workRel` accepts today; a bare chat file id
  or `file_id=<id>` in a chat-file argument of an old tool. The AI sees `$TRINA_WORK` inside box_shell (the variable
  stays) and `chat:work/` in the file tools; the box_shell text says they are the same folder.
- **Names.** `<name>` is the chat file's stored name (NFC, no `/`). When two sent files of the chat share a name, the
  name alone means the newest one and the transcript lists the others in the id form, so the AI never guesses. An id
  that is not this chat's, a name that is not here, a file carried only by answers hidden from this person (#207
  `onlyOnHidden`) and an unsent upload of someone else: all the same "not found" (no probe).
- **Never shown:** the server's absolute paths (`.system/chat-files/…`, `devenv/work-shared/<chat>/<key>`), file ids in
  people's words, the work folder key. Every result, error, summary and step line goes through one `shownPlace()`
  (an extension of PR1's `shownWorkPath`). The audit keeps ids only, as today.
- **One parser**, `shared/src/places.ts` (`parsePlace(input) → {kind:'team'|'chatFiles'|'work'|'roomFiles', rest}`),
  used by the server and the web so a link and a step line read the same. Anything with another `scheme:` stays what
  it is today (a URL or a connector id). A team path can never start with `chat:` or `room:`: its first part is one of
  `TOP_FOLDERS` (shared/src/folder-labels.ts), checked in the parser test.
- **Links in answers.** A team file keeps `/files/view?path=…`. A chat file gets `/c/<chatId>?file=<fileId>` (the chat page,
  which opens the chip's viewer on that file: one small web change; the bytes stay behind
  `GET /api/chats/:id/files/:fileId` and its checks); tools return that link, so the API engine's link guard (which keeps only links a tool gave) keeps it. A work-folder file has
  **no link** (it is per person and per audience); the tool result says so and points to the save path below.

## 2. One resolver

`server/src/files/places.ts`: `resolvePlace(turn, input, use: 'read' | 'write' | 'list') → Place`, the only code that
turns a path argument into storage. Its answers:

| | team path | `chat:files/…` | `chat:work/…` | `room:files/…` (ph. 6) |
|---|---|---|---|---|
| Storage | `authorize()` as today | `ChatFiles.open` / `visibleTo` (row, root → head of P4's chain, sha256, quarantine), `source:'chat'` rows only | PR1's checked work folder (`turn.workFolder()`, `copyWorkFile` safe open) | room file store |
| Readers (read scope) | `sourceOf()` as today | `{type:'chat', id}` (the chat's viewers), plus the k groups of the answers that carry it (below) | shared chat: `{type:'chat', id}` after `noteSharedReads`; personal chat: `{type:'user', id: me}` (as PR1) | `{type:'room', id}` |
| Exists / fresh | `authorize(...).exists` | a name of this chat now | `lstat` under the checked root | room store |
| Who may open | folder rules | `seesChatFiles` + `sent()` + #207 `onlyOnHidden` | the person of the turn, main AI, dev env on | room members |

**Writability by chat kind** (the turn decides; the resolver returns a refusal text in plain words, before any card):

| Chat kind | `chat:files/` write (new file, or a new version of one) | `chat:work/` write (copy in) | `chat:work/` read |
|---|---|---|---|
| Personal (incl. a personal project chat) | its uploads stay **team paths** (`users/<id>/.attachments/<chat>/`, review fix 1); `chat:files/` holds only `chat_files` rows of a chat made private again; a write is refused with "save it in My files (users/<id>/)": the 20261117 rule stays | yes, no card (a run there already reads the person's folders) | yes |
| Shared with people | yes, no card (exactly the chat's people see it); refused in a turn that has a k group (as #200) | yes; a source not every person here may read asks the **shared read card** first | yes |
| Shared project chat / project room side chat | no: refused with "save it in the project folder (projects/…)"; the project folder is its shared place and its commands run there | no work folder (commands run in the project folder, a team path) | n/a |
| Room ✦ side chat | no (the room's save place is a team folder, decisions 20261117) | as the chat's kind | as the chat's kind |
| Confidential (locked) | `chat:files/` read only (uploads are there); no write (no attach path in a locked chat) | none (box_shell is not offered) | none |
| Guest turn | none (guests are never in a chat shared with people; GUEST_TURN_TOOLS keep their list) | none | none |
| Scheduled run | read `chat:files/`; no write to `chat:files/` (nobody to see the attach live; the run's save folder stays its place); no work folder | none | none |
| Sub-agent | none: `chat:` refused (chat_file is PARENT_ONLY today; the main AI reads) | none | none |
| Remote MCP (no turn) | none: the parser accepts the form and the resolver answers "only inside a Trina chat" | none | none |

**k (hidden from newcomers).** A chat file carried only by answers that have a k group (a connection's answer,
chat/shared-answers.ts) keeps that answer's protection wherever its bytes go: (1) #207's `onlyOnHidden` refuses it to
whoever the answer is hidden from, as "not found"; (2) when the asker (who sees it) reads it, the resolver adds the
carrying answers' k groups to this turn's read record, so the new answer is hidden from the same people; (3) a write
of `chat:files/` in a turn with a k group is refused (as #200 does for `save_work_file`), so a hidden answer never
carries a file; (4) a copy of such a file into `chat:work/` is refused (the work folder reaches every later run of the
same people, which the k rule cannot follow).

**Workspace key change.** A shared chat's work folder is keyed by its people and their common view (sharedWorkOf).
The resolver looks it up again at every call (never cached across calls). After people change, `chat:work/x` is
"not found in this chat's work folder (the people in the chat changed, so commands now start in a new, empty work
folder; copy the files in again)". The old folder is never opened. A file written by the copy-in is re-checked right
before the write (the root's key is the same as at the card).

## 3. Every consumer that assumes "path = team path"

Found by grep on the #200 head (57e5a4b1c) plus #207 (785a2c4df). Each row says how it changes. "R" = it asks the
resolver first; a non-team place then takes the place's own branch.

**79 consumer sites** in 7 groups. Seven are hubs that most others go through: `namedPaths`, `sharedSources`,
`confirmSharedRead`, `sharedStep`, `writeTargetOf`, `roomChangeWrites`, `authorize`. Two findings decide the order of
work:

- **A `chat:` value is skipped today.** `sharedSources` (turn.ts ~3702) and `sharedStep` (~4022) skip any value that
  matches `/^[a-z][a-z0-9+.-]*:/i` (a URL). A read of `chat:files/x` would get no read card and no hidden-path step.
  P1 changes both to ask the resolver first and to **refuse** any other scheme in a file tool's path argument.
- **`authorize` already refuses `chat:`** (`badSegment`: `:` is a Windows-illegal character), and `fresh()` reads that
  refusal as "something is there", so a `chat:` write target fails closed today. P1 keeps it that way for every caller
  that has not moved to the resolver.

| Group | Sites | How each changes |
|---|---|---|
| Argument lists | `PATH_ARGS`, `namedPaths` (and its one carve-out for `save_work_file.path`), `WRITE_TARGET_ARGS`, `OUTPUT_PATH_OF`, `SAVE_CARD_TOOLS`, `WRITE_TARGET_NOT_SAVES`, `SHARED_TOOLS`/`ROOM_FILE_TOOLS`/`ROOM_READ_ONLY_TOOLS`/`OWN_WORDS_TOOLS` (rooms/ai-tools.ts); hide-args `KEEP`; `RUN_WRITES` + `steerableWriteRefusal` (chat/tools.ts, shared-run.ts); demo `FILE_TARGETS`/`FOLDER_TARGETS`; `PATH_STEP_TOOLS` (shared/step-labels.ts) | The lists stay as they are (a path argument is still a path argument). `namedPaths` returns each value with its parsed place (`{key, value, place}`), and the carve-out goes. `OUTPUT_PATH_OF` runs on the place's own path. `steerableWriteRefusal` lets a scheduled run write only `users/<id>` and its save folder, as now, and so refuses `chat:` targets. Hide-args resolves a `chat:` target's current text through the resolver, or nothing when it is not text. |
| turn.ts cards | `sharedArgs`, `sharedSources`, `asWritten`/`fresh`, `roomNames`, `confirmSharedRead`/`sharedReadRefusal`/`askSharedRead`, `sharedStep`, `skipStep`, `noteSharedReads`, `confirmRoomChange`, `WIDEN_TARGET_TOOLS`, `writeTargetOf`, `roomChangeWrites`, `fileChangeTarget`, `ownFolderTarget`/`ownFolderPlace`/`ownFolderPdf`, `hwpTarget`/`sourceRel`, `confirmWidening`/`widenNeed`, `askWidening`/`widenSources`/`seesSource`, `noteTaint`, `noteRoomTool`/`workRead`/`workShown`, the tool_start step builder, `attachmentsForTurn` | Each one calls `resolvePlace` before it uses a team rule. For a `chat:` place: the source is the place's readers (section 2), and for a k-carried file its k groups. `fresh()` asks the place whether the name exists. A target is never wider than the chat (no save card), but `confirmWidening` still compares the sources' readers with the chat's people, so a personal source into `chat:work/` of a shared chat asks the shared read card. In the room card, a new `chat:files/` or `chat:work/` file in a personal chat counts as "own folder". `noteTaint`/`workRead` treat every `chat:` read as a box_shell or chat_file read (other people's words). `roomNames` and `hwpTarget` stay for team places only. |
| Newcomer / k | `ReadGroup` and `lateHides` (shared-answers.ts), `wideningAnswers` (widening.ts and its 5 callers), #207 `onlyOnHidden` | Unchanged code. The resolver writes the right groups (y after a card, and the carried k) through `noteSharedReads`, so the warning and the hiding see them. |
| Path rules | `parseInput`, `walk`, `authorize`, `RuleSet.access`/`canList`/`boundaryFolders`, `badSegment`, `savePathArg`, `teamSegs`, search-path helpers, read-scope `sourceOf`/`sourceKey`/`chatViewers`/`widening`, `seesChatFiles` | Unchanged. They stay the team branch of the resolver, and `{type:'chat'}` already has its viewers (`chatViewers`) and its label. `savePathArg` runs only after the parser said "team". |
| Tool code | FileService `call`/`list`/`glob`/`grep`/`read`/`write`/`writeBytes`/`edit`, `readAuth`, `readWork`; `apart()`; `TurnFiles`; make_file and the produce tools (`placeProduced`); file-moves (`move_files`, `copy_files`, `rename_file`, `rename_files`); comment_docx, edit_office, hwp_render, promo_video, intro_deck; chat_file, save_chat_file, `chatFileCopyOf`; room_file, save_room_file; save_work_file; devenv/work-files.ts; `buildToolSet`, `call()`/`beforeFileTool`/`afterFileTool`/`widenOf`; `templateToolRefusal`; remote MCP file tools | `readAuth`'s single `sharedChild` becomes a map of bound places (P1). `read`, `list`, `grep` and `glob` branch on the place (P1). `copy_files` (P2) and `placeProduced` with `write` (P3) gain the place targets. `edit` and `write` on an existing chat file (P4) make a new version. The old tools become aliases (section 4). `rename_file`, `rename_files` and `move_files` refuse a chat file ("chat files keep their name; copy it"). Remote MCP refuses `chat:` with one sentence. `templateToolRefusal` lets a scheduled template write no `chat:`. |
| Sources, links, steps, history | `SourceLog`/`saveSources`/`isTeamFilePath`/`viewSources`, `noteReads`, the API engine `LinkGuard`, `FileLinkRepair`, the link rules in prompts (`SOURCE_LINK_RULE`, share-words, `fileLink`s), web `markdown.ts`/`appLinks.ts`, link-names, `stepLabel`/`placeName`/`stepPlace`, `viewSteps`, history-summary `stepLine`, audit lines and `fileEvent`, prompt "what it uses", demo `runReplay`, demo record, `PARENT_ONLY_TOOLS` | The answer's "files used" list keeps team files only. A chat file it used is already on the chat, and a work file is per person. `LinkGuard` and the web learn the chat-file link `/c/<chat>?file=<id>` (P3), and `FileLinkRepair` leaves it alone. Step labels go through `shownPlace()` and the same words in all six languages. `viewSteps` shows a `chat:` step to whoever sees the chat. The audit keeps ids, and `fileEvent` stays team-only, because chat files have their own `chat.file_add`. Demo replay skips `chat:` values, since a recording has no chat files. |
| Dev environment | `sharedFolderView`/`sharedReadable`/`sharedPathAccess`/`sharedHiddenFolders`/`sharedAccess`, `sharedWorkOf`/`chatWork`/`spaceAt`/`spaceOf`/`workFolderAt`/`runsInWorkFolder`, `CLAUDE_BUILTIN_DENIED`/`CLAUDE_ALLOWED_TOOLS`, Codex `CODEX_DISABLED_FEATURES` | Unchanged. The resolver reads the work folder through `workFolderAt`, looked up again at every call without creating it. The built-in tools stay denied. |
| Chat file store | `ChatFiles` (`create`, `createFromAi`, #207 `keepCopy`, `record`, `open`, `thumbnail`, `copyEarlier`, `sweep`), `Attachment` (`source`, `origin`), the transcript line (turn.ts ~5232), quarantine, `cleanPicture`, `CHAT_FILE_MAX`/`CHAT_FILE_AI_MAX` | `createFromAi` and `keepCopy` become one `put(origin)`, and `open` stays the one open. In the transcript, attachments read `chat:files/<name>` (with `file_id=` for one release). A personal chat's uploads are already team files (`users/<id>/.attachments/<chat>/`), and `chat:files/` there lists them by name. A shared project chat's uploads sit in the project folder and stay team paths. |

## 4. The tool surface after the refactor

**Gain the new paths (through the resolver, in this order of PRs):**
`read` (all modes: text, pages, as_images incl. PPTX from #195, media frames, versions of a chat file), `list`
(`chat:files/`, `chat:work/`), `grep` and `glob` (a chat's files' text; the work folder by name and text), `copy_files`
(any direction among team, `chat:files/`, `chat:work/`; folders too), `write` and `edit` (`chat:files/` in place as a
new version, `chat:work/` text files), `make_file` and every produce tool that places through `placeProduced`
(source and output may be any place), `move_files` (only *out of* `chat:work/` into a team folder or
`chat:files/`: a move is a copy plus a delete, and a chat file is never deleted by the AI), `share_file` (a chat file:
the link above), `delete_files` (never a chat file; `chat:work/` only, as a command could).

**Become thin aliases (kept for old transcripts, prompts and other engines' memory; their schema text says
"same as …"):**

| Old tool | Becomes | Removed from the tool list |
|---|---|---|
| `chat_file {file, …}` | `read {file_path: chat:files/<id>/<name>, …}` | phase 5, after one release with both |
| `save_chat_file {file, save_as}` | `copy_files {paths:[chat:files/…], to_folder}` (no `save_as`: the user's downloads, as today) | phase 5 |
| `save_work_file {path, save_as}` | `copy_files {paths:[chat:work/…], to_folder}`; in a people-shared chat with no target: `chat:files/` | phase 5 |
| `room_file`, `save_room_file` | `read` / `copy_files` with `room:files/…` | only if owner question 2 is yes (phase 6) |
| planned `copy_to_work` | `copy_files {to_folder: chat:work/in/}` | never built |
| planned `chat:<name>` output (H1) | any produce tool with `output: chat:files/<name>` | never built |

The alias maps the arguments and calls the same code, so a card, a step line and an audit row look the same for both.
Old transcripts keep their old step lines (they are stored text). The history (labelledTranscript) shows attachments
as `chat:files/<name>` from phase 1 and keeps `file_id=` beside it for one release, so a model with an old session
still finds the file. The prompt and every tool text say "chat:files/" and "chat:work/"; the old tool names leave the
prompt in phase 5.

**H1 without a special output.** In a chat shared with people the prompt says: "files you make for the people here go
to `chat:files/`; name a team folder only when the user does". That is the whole H1: the AI decides, with one rule, and
the tools need nothing new. The amendment to decisions/20261117-ai-save-my-files-default.md (people-shared chats only)
ships with phase 3.

## 5. Security

- **Work folder, both directions: PR1's safe open, unchanged and reused.** Read: `copyWorkFile` (realpath'd root,
  `O_NOFOLLOW|O_NONBLOCK`, regular file with one link, the open fd's kernel path inside the root, no fallback), into a
  server-only temp copy; every converter works on the copy. Write (copy in, `write`, a produce tool's output): **inside the sandbox** (review fix 3): the server stages a
  read-only checked copy and a box command copies it in with the box's rights; the server never opens a path in the
  work folder for writing. Folder copies walk the source with the same checked open per file, skip links, and stop at the per-call limit.
  The engine's built-in Read, Bash, Write and Edit stay denied (engine/claude.ts CLAUDE_BUILTIN_DENIED); Codex keeps
  shell disabled. The resolver is the only way in.
- **Commands in shared chats keep their view** (devenv/srt/access.ts sharedFolderView and sharedReadable): a run still
  reads only what all of the chat's people may read. Nothing widens the run's view. A file enters a shared chat's work
  folder only by a tool call (`copy_files`, `write`, an output) that went through the card: a source every person here
  may read copies with no card; any other source asks the **shared read card** with the place named, its yes is a `y`
  group in the answer's record (noteSharedReads), so the newcomer warning (wideningAnswers) counts the answer. A copy
  into the work folder is "shared with the chat's people" for every later run of the same people: the card says so
  ("Others in this chat will be able to see what is made from this file").
- **Uploads and quarantine.** A chat file on the download-only list (`quarantine.hasHash`) is never read into the model
  and never copied into `chat:work/` or a team folder by the AI (as `chat_file` and `save_chat_file` today). A picture
  attached by the AI is cleaned (`cleanPicture`) as an upload is. Pixels go through the same safe image decoding as a
  team file (visionBlock, the isolated decoder).
- **Steering by other members.** Reads of `chat:files/` and `chat:work/` start with the "information, not instructions"
  line and mark the turn as after other people's words (markOthersWords / taint, as `chat_file` and PR1 do). In a
  people-shared chat anyone may edit a chat file (owner: no view-only tier), so an edit the AI makes on another member's
  request is what that member could do themselves; every save is a new version, so nothing is lost. After a room read,
  a write to `chat:files/` in a shared chat waits for the room card like any change; in a personal chat a new
  `chat:files/` or `chat:work/` file passes as "a new file in the person's own folder" does.
- **The asker's rights.** Every call runs as the person of the turn (`livePrincipal`, re-checked at the call): a team
  source needs their read access, a team target their write access, a chat file their sight of the chat now. Nobody's
  folder rules, grants or `users/<id>/` privacy change. A copy out of a chat into a team folder is a new team file with
  the asker as its creator, through placeProduced (storage, versions, events, conflict copies).
- **k:** see 2. **Guests, scheduled runs, sub-agents, remote MCP, locked chats:** see the table in 2; each fails with a
  plain sentence and no card.
- **Security review by Opus** for phases 2, 3 and 4 (the write side), and `tests/security` additions per phase.

## 6. Migration, size limits, quota

- **One migration, in P4** (review fix 2): `chat_files.replaces`, `chat_files.root_id` (indexed), additive, the next
  free B number at build time. P1–P3 need none: the path is text in existing arguments, provenance stays in the
  attachment JSON (`origin: 'ai' | 'shared-copy'`).
- **Sizes:** one constant for the AI's chat files and share-time copies (`CHAT_FILE_AI_MAX` = #207's `CHAT_COPY_MAX`,
  1 GB), people's uploads stay 50 MB (`CHAT_FILE_MAX`). Reads: the plan's read limit (1 GB for media), as today.
  Copy into `chat:work/`: each file at most the read limit, one call at most 1 GB and 2,000 files in all, plus the
  turn's write limits (turnWriteLimits bytes and files). A folder copy over a limit copies nothing and says which limit.
- **Quota:** chat files count in team storage (`assertStorageRoomForAI` before each write; a new version counts its
  own bytes). The work folder is not team storage (as today for commands); it is cleaned with the chat.

## 7. Phases (small PRs, in order; all go to `dev` in one batch with the batch rule)

Each phase: tests first, `bun run typecheck`, `bun run check:prepush`, the area's unit tests and `tests/security`,
under Bun 1.3.12. QA on a private copy of the QA team, a real engine (Claude Code, then Codex once per phase that adds a
path), screenshots looked at.

| # | PR | Size (no tests) | Contents |
|---|---|---|---|
| P1 | `feat/places-resolver-read` | M, ~500 | `shared/src/places.ts` (parser, shown names, 6 languages), `server/src/files/places.ts` (resolver; chat files and work folder read; one multi-binding in ToolCtx that generalizes `sharedChild` to a map, so one call may name several non-team places), `read`/`list`/`grep`/`glob` take `chat:files/` and `chat:work/`; the read-scope and card rows of section 3 for reads (incl. the fail-closed scheme line); the k rule of section 2 for reads; history shows `chat:files/<name>`; `chat_file` becomes an alias; box_shell text and prompt say `chat:work/`. Decision file. |
| P2 | `feat/places-copy` | M, ~450 | `copy_files` among all places, files and folders (HTML plus its images folder), with `writeWorkFile`; `save_chat_file` and `save_work_file` become aliases of it; the shared read card for a copy into a shared chat's work folder (y group); copy out of `chat:work/` into `chat:files/` (attach, #200's path) or a team folder (placeProduced); the turn limits and the 1 GB / 2,000-file call limit. |
| P3 | `feat/places-produce` | M, ~450 | `placeProduced` takes a place: `output: chat:files/<new name>` attaches, `output: chat:work/<path>` writes there; every produce tool's `source`, `template`, `images` may be any place (bound through P1's map); `write` of a new `chat:files/` or `chat:work/` text file; the link form `/c/<chat>?file=<id>` (server link guard plus the web's chat page opening the viewer); the people-shared-chat prompt rule (H1) and its decision amendment. |
| P4 | `feat/places-edit-chat-files` (owns the migration; S2 web builds on it) | M, ~400 | review fix 2 in full; `write`/`edit`/produce output on an existing `chat:files/<name>` = a new version through `putVersion`, read-before-write by the head's sha256, a changed head = a version beside it, `read {versions}` on chat files. S2's web save (`PUT …/content`) and restore call the same `ChatFiles.putVersion`. |
| P5 | `chore/places-old-tools` | S, ~150 | The old tool names leave the tool list and the prompt (`chat_file`, `save_chat_file`, `save_work_file`); `call()` still maps the old names for one release (an old session's model may call them); tool-list tests updated. |
| P6 | `feat/places-room-files` (only if owner question 2 is yes) | S–M | `room:files/` in a room's ✦ side chat; `room_file`/`save_room_file` become aliases. |

Order: P1 → P2 → P3 → (S2) → P4 → P5 (→ P6). P1–P3 alone close the three dead ends; P4 closes "edit an attached file".

### Tests per phase

- **P1** `tests/unit/places-parse.test.ts` (every form and alias; a team path never parses as a place; unknown scheme
  refused), `places-read.test.ts` (`read` of an upload, an AI file, a shared copy, by name and by id; same-name files;
  not found for: another chat's id, a hidden-answer file (#207), an unsent upload of someone else, a quarantined file's
  content; `list chat:files/` and `chat:work/`; `grep` in both; PPTX `as_images` on `chat:work/deck.pptx` and on
  `chat:files/deck.pptx`; work folder of the old key after people changed: not found; off for guest, scheduled run
  (work), sub-agent (work), remote MCP, locked chat (work)), `places-cards.test.ts` (a `chat:` value in every
  PATH_ARGS tool is resolved or refused, never skipped; reading a k-carried chat file adds the k group; the read scope
  gets `{type:'chat'}`, not a team path), plus the existing `chat_file` tests run through the alias unchanged.
- **P2** `places-copy.test.ts`: team → `chat:work/in/` (all-readable source: no card; the asker's own folder: card,
  no = nothing copied, yes = y group and the newcomer warning counts it); a folder with an images subfolder; links,
  hard links, a link swapped in during the walk, `..`, skills and `.system/` refused; size, file-count and turn limits;
  `chat:work/` → `chat:files/` attaches (people-shared), → `users/<me>/` (personal) with no card, → a wider folder asks
  the wider-audience card; a quarantined chat file is never copied; the k-turn refusal; the old `save_chat_file` and
  `save_work_file` arguments give the same result, card and audit as before (golden tests from #198/#200).
- **P3** `places-produce.test.ts`: `make_file {source: chat:work/proposal.html, output: chat:files/proposal.pptx}`
  attaches; a source in `chat:files/` and an output in a team folder asks the card as a chat source; `output:
  chat:files/…` in a project chat refused with the project-folder sentence; the API engine keeps the chat-file link a
  tool gave and drops an invented one; web unit test for `/c/<id>?file=<id>`.
- **P4** `places-chat-file-versions.test.ts` (with S2's tests): edit without a read refused; a second person's save in
  between makes a version beside; the chip opens the newest; `read {versions}`; a removed person gets nothing; storage
  counted per version.
- **P5** the tool-list tests; an old transcript replays with the old names.

### QA scenarios (QA sheet row, one per phase as each starts)

1. **"Make a PPT from the proposal in my folder"**, ending with an attached PPTX that the AI checked as slide images
   (`read as_images` on pptx, #195):
   - personal chat: the AI copies `users/<me>/제안서/` (HTML and its images) to `chat:work/in/`, builds the PPTX with
     box_shell, reads it as slide images, fixes what it sees, saves it to My files and links it;
   - chat shared with qa-member: the same, the copy asks the shared read card once (the asker's own folder), the PPTX is
     attached to the answer, qa-member opens it;
   - shared project chat: the proposal is copied into the project folder by the asker's choice or read from there; the
     PPTX is saved in the project folder and linked (owner question 1).
2. **Video:** "make a 15-second clip with a title card" in a personal and a shared chat: the AI reads its own frames
   from `chat:work/` (PNG from ffmpeg on a Mac server, frames on Linux), fixes, and hands the MP4 over (My files /
   attached); it plays in Chrome and the desktop app.
3. **Edit an attached file** (after P4): qa-member asks "change slide 3's title" on the attached PPTX; a new version,
   the chip says "Updated by", the old version is in the panel.
4. **Newcomer joins:** add a third person to the shared chat after scenario 1: the warning counts the answer whose copy
   came from the asker's folder; after joining, their first command's work folder is new and empty, `chat:work/in/`
   is "not found" with the plain sentence, the attached PPTX opens; a connection answer's (k) attached file stays
   hidden from them.
5. **Codex too:** scenarios 1 (shared) and 2 on Codex once per phase that adds a path.

## 8. Owner questions (settled 2026-11-21: both as recommended)

1. **A shared project chat: should `chat:files/` work there too (the AI attaches its PPTX to the answer), or does the
   project folder stay the one place?** Recommend: **the project folder stays**; the AI saves there and links it, as
   today, and `chat:files/` is read-only in project chats (uploads only). One place per kind of chat
   (trina-ax-78's plan, option c) keeps "where is it?" simple.
2. **Room files as paths (`room:files/` in a room's ✦ side chat) now, or later?** Recommend: **later**, after phases
   1–5 are used for a week. `room_file` and `save_room_file` work today and the owner's dead ends were all in chats.

## Integration with trina-ax-78 (share-chat-files, #207 and S2)

1. #207's `ChatFiles.open` hidden-answer check (`onlyOnHidden`) is the resolver's open for `chat:files/` reads, list,
   grep and copies; the resolver never opens a chat file another way (a test fails a second path).
2. #207's `keepCopy` and #200's `createFromAi` become one `ChatFiles.put(origin)` used by the resolver's writes, with
   one size constant.
3. `origin: 'shared-copy'` copies are ordinary `chat:files/` names; Rule 3 ("the chat's copy wins in links") also holds
   for the AI: in that chat a team path whose original has a shared copy resolves, for a read, to the copy's
   `chat:files/` form and says so in the result (one line); a write to the original path stays a team write.
4. **S2 (web only) builds on P4's resolver and `putVersion`, not on a new tool or column:** `write`/`edit`/produce output to an existing `chat:files/<name>`
   = a new version (`replaces` = the head's id, same name, `origin: 'ai'`, the turn's person as `user_id`). Read-before-
   write as for team files: `edit` needs a read of the head in this turn (its sha256 in readHashes under the
   `chat:files/<id>` key); if the head changed since (someone saved), the save is a new version beside it and the result
   says so (the team rule's conflict copy, in chat-file form). `read {versions:true}` lists the chain; `version: n`
   reads one. The web's `PUT /api/chats/:id/files/:fileId/content` (S2) uses the same `ChatFiles.putVersion`.
5. `chatFileCopyOf` (save_chat_file's copy in users/ read as the chat's) stays for old copies; new work no longer needs
   the round trip.
6. S3's `file-access` endpoint and S4 (projects) are untouched by this plan.

## Decisions

A new `docs/decisions/20261121-chat-places-as-paths.md` with phase 1: the chat's files and work folder are places in
the file model, named `chat:files/` and `chat:work/`, resolved by one resolver; the old tools are aliases. It
supersedes the PR2b copy-in and PR2c H1 designs (never built) and amends
[20261121-ai-sees-and-saves-workspace-output.md](../../decisions/20261121-ai-sees-and-saves-workspace-output.md) ("the
finished file leaves only through save_work_file" becomes "through any file tool, by the same rules"). Phase 3 amends
[20261117-ai-save-my-files-default.md](../../decisions/20261117-ai-save-my-files-default.md) for people-shared chats.
Kept as they are: [20261118-devenv-shared-chats.md](../../decisions/20261118-devenv-shared-chats.md) (the run's view),
DECISIONS.md "Write only in the starting folder" (commands still write no team folder beyond it), the sharing model
("nothing new is hidden", k the one exception).

## Risks

- **Breadth.** Many consumers (section 3); a missed one would treat `chat:…` as a team path or as a URL. Mitigation:
  `sharedSources` skips any `scheme:` value today (turn.ts, the `/^[a-z][a-z0-9+.-]*:/i` line), so a missed consumer
  would skip the card. Phase 1 changes that line to **fail closed**: an unknown scheme in a path argument of a file
  tool is refused, and the resolver is the only place that lets `chat:` through. A test walks every PATH_ARGS tool
  with `chat:files/x` and `chat:work/x` and asserts each is resolved or refused, never passed through.
- The work-folder write side is new code on a folder sandboxed commands write at any time (Opus review).
- P4 owns the version migration and S2 (web) builds on it; until P4, phases 1–3 still close the owner's dead ends
  (a new name, never an overwrite).
- P2 depends on the in-sandbox copy (review fix 3); if staging fails on a Mac server, the broker gets a macOS path first.
- Older apps: links of the new chat-file form open the chat (the route exists); step lines are server text.
- The five app languages (six with zh): the new place names in en, ko, es, id, ja, zh (`check:i18n`).
- One migration (P4, the next free B number at build time); check `server/migrations/` on `dev` right before that PR.

## Tests

Per phase in section 7. Always: `bun run typecheck`, `check:prepush`, `check:i18n`, `check:docs`, the tool-list tests
(SHARED_TOOLS, WRITE_TARGET_ARGS / SAVE_CARD_TOOLS, PARENT_ONLY_TOOLS, GUEST_TURN_TOOLS, step labels, hide-args),
`tests/unit/places-*.test.ts` (new), `work-folder-read.test.ts`, `save-work-file.test.ts`, `b-chat-files*.test.ts`,
`b-share-chat-files.test.ts`, `dev-env*.test.ts`, widening and shared-answers tests, `tests/security`.

## Result

(filled in at the end)
