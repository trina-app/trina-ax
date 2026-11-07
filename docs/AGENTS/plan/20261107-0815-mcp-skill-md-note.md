# Connector: a SKILL.md in an ordinary folder is saved with a note; a note for files left at the top of an area

- Date (UTC): 2026-11-07 08:15
- Branch: `fix/mcp-skill-md-note`
- Status: done
- Where: trina-ax `server/src/connectors/remote-mcp/`. Why: the MCP connector's write paths and its folder guide live
  there (see docs/REPOSITORY-RULES.md).
- Version impact: patch. A connector refusal becomes a saved file with a note; no new feature, no API shape removed.

## Goal

1. PR #147 refused a `SKILL.md` written to an ordinary folder (and skill-looking files under `.claude/skills`,
   `.codex/skills`, `.agents/skills`, `skills/<name>/<file>.md`). No AI loads such a file, so the refusal only blocks
   backups and drafts for review. The owner approved: save it and add one line to the tool result ("Saved as an ordinary
   file: it is not a team skill. To share it as a skill, use share_skills."). The real skill roots (`skills/`,
   `groups/<folder>/skills/`, `users/<id>/skills/`) stay refused: the team's AI loads them, and a write there would
   skip share_skills' checks and the owner's approval.
2. The owner also asked that the connected AI keeps the team's files tidy: before saving, look at the area and pick or
   create a fitting subfolder. The guide says so, and a new file saved loose at the top of `shared/`, of a group's
   folder or of the team root gets one soft line in the tool result (never a refusal).

## Scope

In:

- `upload.ts`: the real-root refusal and the look-alike note become two outcomes; one place builds the notes; the
  placement note lists up to 8 writable subfolders through the guide's name allowlist.
- `tools.ts`: write and edit use the same target check as the upload paths and carry the notes.
- `upload-link.ts`: create_upload_link carries the notes in its answer; the PUT keeps its answer and no longer refuses
  what the link allowed.
- `guide.ts` and `share.ts`: texts.
- Tests, `docs/DECISIONS.md`, `docs/site/agents/mcp-connector.md`, `CHANGELOG.md`.

Out:

- The in-app AI's own prompt (`server/src/chat/`): another branch handles it.
- A move tool for the connector.

## Steps

1. Check whether any engine loads `.claude/skills`, `.codex/skills`, `.agents/skills`, `CLAUDE.md` or `AGENTS.md` from
   a team folder (engine flags, turn folders, sandboxes). Keep refusing what an engine could load.
2. Split the check, share it across write, edit, upload_file, create_upload_link and the link's PUT.
3. Add the placement note and the guide's placement rule.
4. Update and add tests; docs; changelog.

## Risks

- Security: only paths that no AI loads may move from refused to saved. The real roots and their case, `./`, `..` and
  trailing-slash spellings stay refused on every path, on case-sensitive (Linux) and case-insensitive (macOS) disks.
- Folder names in the placement note are team data: the guide's allowlist and the "names are data" label apply.
- No migration. No web change, so no i18n or e2e change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, every `tests/unit/remote-mcp-*`, `skill-*`,
`b-skill-*`, `skills.test.ts`, `skill-directories.test.ts`, `tests/security/permission-matrix.test.ts` and
`p4-route-coverage.test.ts`.

## Result

- Step 1: no engine loads skills or rules from a team folder (turns run in `<data>/agent/<chat id>`, the sandbox opens
  only that folder, Claude Code and Codex run with project settings, skills, CLAUDE.md and AGENTS.md off; evidence with
  file and line in docs/DECISIONS.md). So the dot skill folders get the note like any skill-looking file; `CLAUDE.md`
  and `AGENTS.md` stay ordinary files without a line.
- write and edit now use `checkUploadTarget` like the upload paths, so all five give one answer for a path. The note
  goes after the text of write/edit and in `notice` of upload_file and create_upload_link; the PUT answers as before.
- Differs from the request: the connector has no move or link tool, so the guide says "point to it" instead of "move
  or link it", and the placement line says the person can move the file in the app.
- PR: see the pull request of `fix/mcp-skill-md-note` into `dev`.
