# Shared chats: a narrowed search says so, "/" looks further, and the share tools say their plain limits

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (adds to "Shared project chats" in docs/DECISIONS.md, 20261116-ai-share-words.md "Nobody by that
  name", 20261116-share-folder-tool.md and 20261116-files-shared-with-me.md)
- Branch: fix/shared-chat-share-find (real-AI scenarios SWM-01.project, SHR-01.project, FSH-01.project,
  FIND-01.project, each failed twice on dev d4a853a0b)

- **Ask:** four real-AI cases failed in a shared project chat. Each came from what the AI was told, not from what it
  chose: a search result that looked complete but was cut to the project folder, a name check that did not read
  "민호 님이랑 공유해줘" as naming 민호, a share refusal that hid the real limit behind another rule, and no fact that files
  shared with one person are not reachable in a shared chat.
- **Rule 1, a search kept in the project folder says so (FIND-01).** In a shared project chat, grep and glob without a
  path still look in the project folder only (the read gate's default, unchanged). The first result of a turn from a
  main-AI search that looked only in the project folder (no path, or a path that is the project folder or inside it: the AI
  also named the project folder itself) now ends with one note (`PROJECT_SEARCH_NOTE`, `server/src/chat/search-path.ts`): only the project folder was
  searched; other team folders and the user's own folder were not; search again with path `"/"` to look further.
  The note names no folder: the AI writes where everyone in the chat reads.
- **Rule 2, `"/"` alone is the whole team folder in a shared project chat, without the asker's own folder.**
  `TurnExec.sharedArgs` turns path `"/"` (that string alone) into the team root as the asker can open it, and the
  call leaves out `users/<asker>` (`SKIP_OWN`: files/service.ts glob and grep, files/search.ts `skip`, the file
  lists, and `sharedSources`, so the card does not list it either). The read card asks first for every place there
  that some of the chat's people cannot open, as for any wider path; a no reads nothing. The own folder is left out
  because the read card's "Always allow" (`shared_read`) is one choice for every place: a person who allowed a group
  folder did not choose to put their own files into a shared chat with a one-character path (review finding). Any other path without a folder ("", ".", "./") still stays in the project folder, and a chat shared with
  chosen people keeps its own rule (one folder everyone may read). The instructions say the same in the search line.
  - The asker's own folder is searched in a shared chat only by its own path, as before (behind the read card, or
    the person's own "Always allow"); files shared with them one by one are not reachable at all (Rule 4). The note
    is given for the main AI's own searches only (a sub-agent's search does not use it up).
- **Rule 3, the share tools say their plain limits.**
  - `share_with_person` checks every recipient before the files: a recipient nobody matches is said first. A member
    who names a group by its form ("마케팅팀", "Sales team", `group:<id>`) gets the plain limit: they are not in a group by
    that name, a member shares only with groups they are in, and what works (share with the group's people by name,
    or ask the team owner or an admin). The text is the same whether such a group exists or not, as before: a group
    the user is not in still reads like none (20261116-ai-share-words.md).
  - A file is named in the asker's own words also by its name without the date, number or version at its end
    (`namesFileCore`, `coreName`: "단가표" names 단가표-2026.xlsx, "report" names report_v2.docx; never with another date
    or number right after it: "ledger-3" does not name ledger-4.txt). Only for share_with_person's rule that a file in
    a chat others wrote in is one the asker named, and such a file always gets the card, also under "Always allow":
    several files can share one such name. `namesFile` and `namesFileLoose` keep their old rule, so the explicit-ask
    skip, stop_sharing and who_can_open are unchanged.
  - The group refusal says the AI cannot see who is in a group the user is not in, so it asks for the names once in
    its answer, not on an ask_user card with nothing to offer as choices (SHR-01 reruns asked twice).
  - A person is named as a recipient also by "(님/씨)이랑 / 랑 / 와 / 과 / 하고" right before the request 공유해줘
    (공유해 + 줘, 주세요, 주시겠어요, 주십시오, 달라: "민호 님이랑 공유해줘"). Only the request: "민호 님과 회의한 내용
    공유해줘", "민호랑 공유했던 견적서 …", "민호랑 공유하면 안 되니까 …" still name nobody (review finding).
    `share_folder`'s "every person in the asker's own words" rule, the "Always allow counts" rule and the explicit-ask
    skip of share_with_person and post_to_room (namedInFull) read it the same.
- **Rule 4, files shared with one person are not in a shared chat (SWM-01).** The shared chat's "Not available here"
  line now lists the files and folders teammates shared with the asker one by one, with where they are
  (Files › Shared with me, in the asker's language) and that they are the asker's alone: the AI does not search the
  asker's own folder for them and does not suggest attaching them to the shared chat. `shared_with_me`, if reached
  there anyway, says the same instead of "ask for the link" (links to shared files do not open in a shared chat).
- **Left for later:** the read card lists boundary folders (`sharedSources`), while a root search also starts at
  each `projects/<name>` of the staff project zone (`allowedRoots`); a project folder with no `folders` row (an older
  build's) would be checked as the team root. The same gap was there for path `"projects"` before this change.
- **Unchanged:** the read card, who it counts, what a no does; the asker-named rules for files, folders and
  recipients in a chat others wrote in; Always allow; the cards themselves.
- **Tests:** `tests/unit/shared-chat-share-find.test.ts` (the name rules, the group limit, the instructions, the
  path rule) and two cases in `tests/unit/b-shared-chats.test.ts` (the note once a turn and `"/"` behind the card; the
  group limit before the file rule), `tests/unit/ai-situation.test.ts` (the Shared with me label matches the app).
- Version impact: **patch** (what the AI is told and two looser name matches; no DB, API or screen change).
