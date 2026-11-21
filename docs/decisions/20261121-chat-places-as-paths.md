# The chat's files and its work folder are paths of the AI's file tools (chat:files/, chat:work/)

- Date: 2026-11-21
- Status: accepted
- Supersedes: the PR2b copy-in (`copy_to_work`) and PR2c H1 (`chat:<name>` output) designs of
  [plan 20261121-0334](../AGENTS/plan/20261121-0334-shared-chat-attach-work-file.md), never built. Amends
  [The AI opens what its commands made](20261121-ai-sees-and-saves-workspace-output.md): `read` takes `chat:work/<path>`
  as it takes `$TRINA_WORK/<path>`
- Branch: feat/places-resolver-read (plan [20261121-0615-chat-places-as-paths.md](../AGENTS/plan/20261121-0615-chat-places-as-paths.md),
  the owner, 2026-11-21: "fix the root, not patches; the AI decides itself")

- **Ask:** the AI kept hitting dead ends that Claude Code never has. It could not open its own video frames with the
  tool it knows, could not hand an MP4 back in a shared chat, and could not bring the asker's proposal into a shared
  chat's work folder. Each place had grown a tool of its own (`chat_file`, `save_chat_file`, `save_work_file`, …).
- **Rule:** next to team paths, a file tool's path argument may name `chat:files/<file_id>/<name>` or `chat:files/<name>`
  (this chat's files, `chat_files`: uploads in a chat shared with people, files the AI attached, share-time copies),
  `chat:files/` (their list), and `chat:work/<path>` (the chat's work folder, `$TRINA_WORK`). One resolver
  (`server/src/files/places.ts` resolvePlace) answers three things for each: where the bytes are, who can see them, and
  whether this call may write there. A personal chat's upload and a team attachment stay team paths with their own
  readers, never the chat's.
- **Readers:** a chat file's readers are the chat's people (`{type:'chat'}` in the read scope), so reading one in a
  shared chat asks no read card. It never goes into an answer's list of team files.
- **Fail closed:** the prefixes `chat:` and `room:` are reserved. A form the build does not take, or a tool that does not
  take a chat place yet, is refused in plain words before any card. It is never taken as a team path or a web address.
  Only the main AI of a chat turn reaches chat places (not a sub-agent, remote MCP or a template run). Each call checks
  the account and the person's sight of the chat again. A file carried by an answer that is hidden from people who join
  later (a k group) is not read.
- **One open:** a chat file is opened only through `ChatFiles.open`, and a test fails on a second way.
- **This first version (P1):** `read`, `list`, `glob` and `grep` take `chat:files/`. `read` takes `chat:work/`.
  `chat_file` is the same read under its old name. Copies, produce tools and in-place edits follow in their own PRs
  (the plan's P2–P4); until then those tools refuse a chat place.
