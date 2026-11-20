# File list: new files show within a minute — 새 파일은 1분 안에 목록에

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (extends "File list — 파일 목록" in docs/DECISIONS.md)
- Branch: feat/files-list-incremental
- **Ask:** "_FILES.md only updates at night, so the 3 files I just uploaded aren't in the index yet." A new file had no
  sidecar row until the nightly scan, and a row showed only once the AI had described it.
- **Rule:** every team-folder change already goes through `publishChanges` (Files screen, uploads, the AI's and the
  remote connector's write/edit/upload_file/upload link, moves, deletes, restores); its `tree-changed` paths are collected
  per folder and looked at 30 s after the folder's last change (at most 60 s after its first): a stat per path, a folder
  walked (at most 20,000 files), and each listable file the sidecar does not know gets a row without fields. A bulk
  upload is one pass. No hashing, no AI call. Off in server.json (`fileList.enabled: false`): nothing is collected.
- **Plain lines:** a file whose AI fields may not show (not read yet, changed since, moved to another unit, a rule
  changed, a call-mate hidden) now gets a plain line, `path — <ext> file; -; -; <size>, changed <day>, not described
  yet (…)`, instead of no line. It holds nothing from the content or a model, and passes the same per-person checks
  (visiblePath, the list's own path readable), so it says no more than the folder listing. The night describes it.
- `FILE_LIST_RULE` and the list header say so. Tests: `tests/unit/c-file-list.test.ts` ("between runs"),
  `c-file-list-format.test.ts`, `c-file-list-connector.test.ts`.
- **A restart drops the checks still waiting** (they are timers in memory); the night pass's scan picks those files up.
- **The night hashes rows added between nights** (they have no hash yet) when they are small enough to read, so identical
  files are still read once. A folder that can never be listed (users/ while personal folders are not read, skills/) is
  not walked, and a name that can never be listed costs no stat.
