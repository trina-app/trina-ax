# A shared project chat's restricted sub-folders do not exist for the chat

- Date: 2026-11-18
- Status: accepted
- Supersedes: for sub-folders of a shared project chat's project folder, the read card of
  [Shared project chats](../DECISIONS.md) for listings, searches and paths there; the "Known" line of
  [A shared chat's commands show no proxy login and no name …](20261118-devenv-shared-followups.md)
- Branch: fix/shared-hide-subfolder-names (QA TC-4945)

- **Ask:** in a shared project chat, names of sub-folders with their own rules that not everyone in the chat may open
  must not reach the chat: not through listings, glob or grep, a zip, a command's `ls`, step labels, errors or path
  notes. "Not found" and "no access" must read the same. One rule everywhere.
- **The rule: invisible.** Such a sub-folder (`devenv/srt/access.ts` `sharedHiddenFolders`: each folder with rules of
  its own strictly inside the project folder that the person of the turn or anyone else who sees the chat may not read,
  the shallowest only; everything below it goes with it, a folder everyone may read again inside it too, because its
  path names the hidden one) does not exist for the chat. The read card is never about it.
  - **Why not the card:** a command cannot show a card, and a card only helps the person who may open the folder; when
    the person of the turn cannot open it either, any card would name it to them. The card's "no" also told the AI the
    place exists and is limited, unlike a name that is not there.
  - **The file tools** (`policy/access.ts` `withHiddenFolders`): for each tool call of a shared project chat's turn
    (`mcp/protocol.ts`, every agent's), the person's access is "no access" at and below those folders, whatever the
    rules give. Every tool and the read card's own check (`chat/turn.ts` sharedSources) go through `RuleSet.access`, so
    listings, glob, grep, make_zip, a file list, reads and every other path argument answer as for a name that is not
    there (`authorize`: one refusal for both, security r3), with no card. Names compare after NFC and lower case (fails
    closed on a case-sensitive disk). Other people's access is unchanged; outside the call nothing changes. The set is
    worked out from the chat's people when the call starts (`TurnExec.sharedHiddenScope`); anyone who cannot be loaded,
    nobody found, or a failed check hides every rule folder in the project folder.
  - **Commands** (`devenv/srt/access.ts` sharedAccess, `srt/mounts.ts` hideDeniedNames): the run's view leaves the same
    folders and everything below them out. A writable folder that holds one on disk is now given entry by entry too (in
    TC-4929 only read-only ones were): its sub-folders stay writable, its files are read-only, links are not given, and
    folders whose names start with a dot (`.git`, `.vscode`, `.claude`) and skill folders are read-only (srt protects
    names inside a root it is given, not one given as a root of its own). The folder itself is only a place: a command
    cannot add, rename or delete an entry at its top (Linux: what it makes there is not kept, a rename or delete fails as
    busy; macOS: refused). A read-only folder that holds a hidden one is opened the same way, also when a writable
    folder is inside it (that one stays given as it is). A git repository in an opened folder is not given at all
    (`.git` in any letter case, or a folder with HEAD, objects/ and refs/ such as `web.git/`): it sits at or above a
    hidden folder, and its history may hold that folder's files (`git status`, `git show HEAD:…`, `checkout`). Every
    entry given inside an opened folder (the ones it adds and the view's own entries there, such as a writable
    sub-folder) is pinned by device and inode as listed (`entryPins`). The pins go to two files in the run's own TMPDIR
    (`writePins`), and on Linux the command's first line runs one `/usr/bin/stat` over them inside the sandbox
    (through xargs, so the list has no length limit) and compares the result with what was listed (`entryGuard`). A
    folder swapped for a link between the listing and srt's bind (which follows links) stops the command with exit 97
    before it runs. Checked in the Docker suite (S16, S17, S18, S18b, S19). Each command's result says which folders (names everyone
    may see) and what to do instead (`devenv/tool.ts` lockedTopsNote). A cwd in a hidden folder is refused with the words
    of a folder that is not there (`srt/runner.ts` sharedCwdShown). The tool's path notes use the same rule
    (sharedPathAccess).
  - **Steps** name a path only for a viewer who may open it, as before; the hidden folder never shows in a result, so
    the answer's text has nothing to name.
  - **The AI is told** in the shared project chat's instructions that such a folder is not there, and to say "not found
    here" and point to a chat of the person's own, never that it does not exist.
- **Unchanged:** a team file the person attaches from such a folder still asks on the card (their own explicit act, not
  a listing); places outside the project folder (another team folder, the person's own folder, the whole team with "/")
  still ask on the card, but the project's hidden sub-folders stay out of a "/" search too. Chats shared with people and
  groups (no project) keep the card.
  - **Writes** (`policy/authorize.ts` lockedTop): during such a call, a new entry directly in a folder that holds a
    hidden folder, the hidden name itself and any path through it are refused with one text naming only that folder,
    whatever the name. Before, a hidden name said "no access" while a free name was made, which told the AI which names
    exist. Existing files there and every sub-folder work as before. The file tools now match commands here.
- **Known:**
  - In a project with such a folder, a command can no longer make anything at the top of the folder that holds it.
    On Linux this is silent: `npm install`, `git init`, `unzip` or a build writing there seems to work, but the new
    files are not kept. The note after each command says so, and the AI saves with the file tools or works in a
    sub-folder. git does not work at that level (`.git` is not there), and an editor that saves by renaming fails on a
    file at that top.
  - The note (`devenv/tool.ts` lockedTopsNote), and the file tools' refusal of a new entry there, name the folder
    that holds a hidden one. Everyone in the chat may open that folder, so its name is no secret, but they tell the
    chat that something in it is hidden from someone (never what, or from whom). That cannot be avoided once writes
    behave differently there.
  - A folder that someone with write access renames on disk to a visible name is visible under that name. That is
    the same as copying its files out, which they may do anyway.
- **Tests:** `tests/unit/shared-hidden-subfolders.test.ts` (the set, the access in a call, the view, the writable
  folder and a read-only one with a writable folder inside given entry by entry, `.git` left out, the pins and the
  guard, one refusal for writes), `tests/unit/b-shared-hidden-subfolders.test.ts` (whole turns: list, glob, grep, read
  with no card, the same words as a missing path, nothing for another viewer), `tests/unit/dev-env-shared-chat.test.ts`,
  `tests/linux/srt-attack.ts` S16, S17, S18, S18b, S19 and S9b/S9c.
- **Version impact:** patch.
