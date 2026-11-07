# The in-app AI keeps the team's folders tidy when it saves files

- Date (UTC): 2026-11-07 08:15
- Branch: `feat/tidy-file-placement`
- Status: in progress
- Where: this repo, `server/src/chat` (the instructions and the chat turn's tool results) and `server/src/mcp/protocol.ts`.
  Why: the in-app AI ("Ask Trina" chats and @트리나 in rooms) is core chat behaviour (see docs/REPOSITORY-RULES.md).
- Version impact: minor. The AI visibly places files differently (a fitting subfolder instead of the top of `shared/`);
  no API, setting or database change.

## Goal

Asked "<file> 이건 shared에 올려줘", the AI copied the file to the top of `shared/`, left the original in the person's
folder and only said that everyone can see the amounts. The person had to ask again ("정리해서 넣어놔야지"). The AI then
made `shared/Sales/Quotes/<client>/` following the English names already in `shared/Sales/`, moved the files there and
cleared the top. The owner: files go to a good place, the file system stays tidy, and an odd place gets a warning.
That second answer should be the first.

## Scope

In:

- A short rule in the instructions (main AI and room sessions, also a resumed session's turn context): a folder the
  person names is the area, not the spot; list it and pick or create a fitting subfolder that follows the existing
  names; nothing loose at the top of `shared/`, a group's folder or the team root unless asked for exactly that; move,
  not copy, unless a copy is asked for; say in one line where it went, and say so when more people can see it.
- A one-line server note in the tool result when a tool call of the turn created a new file directly at the top of
  `shared/`, `groups/<folder>/` or the team root: the existing subfolders there (at most 8, names that pass an
  allowlist, marked as data). The server already reads every new file event of the turn after each tool call
  (`TurnExec.afterTool`); the note rides on that. Never blocks the save.

Out:

- The remote MCP connector (`server/src/connectors/remote-mcp/**`): another change is working there.
- Sub-agents' instructions (they save where their task says); the note waits for the main AI's next call.
- A UI line on the saved-files card, a new setting.

## Steps

1. This plan.
2. `FILE_PLACEMENT_RULE` in `server/src/chat/prompt.ts` (person lines, not for sub-agents).
3. `server/src/chat/file-placement.ts`: which area a new file is loose in, the area's subfolders the person may list
   (room sessions: only those everyone in the room may read), the note.
4. `TurnExec` collects loose new files in `afterTool`; the chat tool set and the MCP handler append the note to the
   main AI's tool result.
5. Tests, DECISIONS.md entry, CHANGELOG line.

## Risks

- Names of team folders reach the model: allowlist (letters, digits, space, `._-`, at most 40 characters), quoted and
  labelled as data; a room session names only folders everyone in the room may read.
- Template runs (fixed scope) get no note: the approved scope decides where files go.
- No migration, no permission change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests with `prompt`, `chat`, `turn`, `files` in
their names, a new unit test for the rule and the note. A real-engine check with test data if possible.

## Result

Filled in at the end.
