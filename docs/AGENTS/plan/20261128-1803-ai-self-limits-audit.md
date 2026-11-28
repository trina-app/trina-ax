# The AI's own words stop telling it "you can't" where it can

- Date (UTC): 2026-11-28 18:03
- Branch: `fix/ai-self-limits-audit`
- Status: in progress
- Where: server/src (the AI's instructions, tool descriptions and tool errors). Why: an audit after the Aside attach
  case (#754) found more texts that tell the AI something is impossible while another tool does it.
- Version impact: patch. Only words the AI reads change; no tool, permission or route changes.

## Goal

The owner asked whether there are more cases like Aside: the AI said "impossible" because our own text told it so,
while the capability existed. Claude Code is the floor (memory: ai-should-match-claude-code). This PR fixes the
text-only cases. Cases that need code or a security review are listed in the PR for the owner, not built here.

## Scope

In (text only):
1. `plainWordsRule` (chat/prompt.ts): its example for a turn with edit_pdf taught "I can't change the text of the
   existing PDF here". edit_pdf `replace_text` does that since 11-19 (docs/decisions/20261118-pdf-replace-text.md).
   The example now uses a real limit (files on the person's computer).
2. `stamp_pdf` description: "It cannot change the text of a PDF" names edit_pdf replace_text instead.
3. `edit_office` and `comment_docx` descriptions: "cannot change speaker notes, charts, tables in a deck, comments;
   say so" and "Tracked changes cannot be made here: say so" are now about this tool; when the turn has the document
   skills (box_shell), the skills do it. `DOC_SKILLS_RULE` gets one line on changing an existing Office file with the
   skills and saving it back as a new version (copy_files under the same name).
4. `unzip_file`: .tar.bz2, .tar.xz and a password zip (with the password the person gives) open in box_shell when the
   turn has it; the AI tells the person to unzip it themselves only when it has no such tool.
5. Team `write`/`edit` on a binary file: the error names the tool that changes or makes that type (edit_office,
   edit_hwp, edit_pdf, make_file, make_zip) instead of "write .md/.csv/.txt instead".
6. "Where you run": "you cannot see or open anything on the user's device: ... apps ... screen" now leaves out what
   the turn's own tools reach there (the desktop browser, an app on their computer under Connected services).

Out (need code or security review; listed in the PR): mail attachments in scheduled runs under Always allow, Outlook
attachments, room audio/video reads, intro_deck in shared chats, guests' office tools, public git clone in shared
chats, the Mac document kit's Python libraries line, sub-agent read tools. The Aside attach case itself is #754.

## Steps

1. Change the six texts.
2. Tests: unit tests that pin each new sentence and that the false ones are gone; re-record the engine prompt pins
   (`PIN_RECORD=1`), since the Claude Code and Codex paths change on purpose.
3. `changes/ai-self-limits-audit.md`.

## Decisions

None new: each change follows an existing decision (ai-should-match-claude-code, 20261118-pdf-replace-text.md,
20261124-doc-skills.md, 20261121-ai-sees-and-saves-workspace-output.md, 20261118-local-app-connectors.md).

## Risks

Prompt length: about +600 characters in tool descriptions and +150 in every turn's instructions; the budget and pin
tests run. No migration, no permission change, no UI string.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, the prompt, office, PDF, unzip, files and
engine-pin unit tests, all under Bun 1.3.12.

## Result

(filled in at the end)
