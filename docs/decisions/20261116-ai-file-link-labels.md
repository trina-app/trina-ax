# The AI names a file or folder by a link with its shown name, not its team path

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/ai-file-link-labels (AI scenario check 2026-11-16, root cause #1 "jargon")

- **Ask:** answers told office workers where a file is with raw team paths in code formatting (`groups/영업/견적서/`,
  `users/sora/작업/`, `skills/…/SKILL.md`), because the instructions said "Say where with the team path".
- **Rule:** the AI names a team file or folder by a link labelled with the name people see:
  a link to /files/view?path=<the file> for a file, the same link for a folder (it opens the Files screen there), and a
  top folder or the person's own folder by the name the app shows (전사 공유, 내 폴더, …). No team path as text or in
  code formatting unless the person asks for it. Nothing found: the closest files are listed as links. In Slack (no
  cards there) the AI still gives the team path, next to a link. A guest (no file page) gets the file and folder names.
- **Shared chats and sub-agents:** in a shared chat the asker's own folder is called by their name ("<name>'s
  folder"), since 내 폴더 would read as each reader's own. Sub-agents still report team paths to the assistant. The rule
  is about the answer only: tool calls, sub-agent tasks, file contents and posted room text keep paths.
- **API engine:** the API engine's link guard (server/src/engine/api-links.ts) turns a /files/view link that no tool
  result, instruction or user message gave into its plain label, so a folder named there shows as text, not a link.
- **Why:** the people are office workers; a path is how the disk names a place, not how the screen does.
- **Left out:** rewriting backticked paths into links after the answer. The answer streams to the screen as it is written,
  a rewrite needs the access check and the folder words for every viewer of a shared chat, and it cannot tell when the
  person asked for the exact path.
- **Tests:** tests/unit/b-prompt-file-links.test.ts, tests/unit/b-prompt-find-file.test.ts.
- **Version impact:** patch.
