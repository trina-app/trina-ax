# The AI says where to get Hangul files while the HWP plugin is off

- Date: 2026-11-25
- Status: accepted
- Supersedes: the line "Off, the instructions say nothing about Hangul documents at all" of "Hangul writing and
  filling come with the HWP plugin" (docs/DECISIONS.md, 2026-11-04); the gate itself stays
- Branch: fix/hwp-plugin-hint (plan: docs/AGENTS/plan/20261125-0904-hwp-plugin-hint.md)

- **Ask:** a person asked Trina AX for a Hangul file (.hwp/.hwpx) on a team without the HWP plugin
  (`app.trina.hwp-preview`). The tools and instructions say nothing about Hangul while the plugin is off, so the AI only
  said it could not. Admins of teams whose default language is English never learn the plugin exists (the
  "Recommended" hint in Admin › Plugins follows the workspace language).
- **Rule:** while Hangul writing is off (`PluginManager.hwpWriting` false, so no edit_hwp and no `hwpx` format),
  make_file's rule ends with one sentence (`chat/hwpx-guide.ts HWP_PLUGIN_HINT`): Hangul files cannot be made or filled
  in here until a team admin installs and turns on "HWP Preview" (한글 문서 미리보기) in Admin › Plugins; only when
  someone asks for a Hangul file, or writes in Korean and asks which document format to use, the AI says so plainly (to
  an admin: that exact place) and offers a Word (.docx) file meanwhile. It is in every team member's turn whatever the
  team's or the person's language (the AI answers in the person's language); not in a guest's turn (a guest from
  outside the team has no admin to ask by that name) nor a sub-agent's (it does not talk to the person).
- **Unchanged:** writing and filling Hangul documents still need the plugin; the tool list, make_file's schema without
  `hwpx`, and the refusal (`hwpWritingOff`, which already names the place) are as they were. Reading .hwp/.hwpx stays on
  for every team.
- **Why one instruction line, not phrase matching:** the model knows when it is asked for a Hangul file in any
  language; a word list in code would miss phrasings and grow. About 70 tokens, only while the plugin is off.
- **Rejected:** keeping silence (the person hears "can't" with no way forward, and an English-language team's admin
  never finds the plugin); turning the plugin on by default (the owner's 2026-11-04 decision: Korean customers add it);
  a notice on every turn or in every answer (teams that never asked would be told about it).
- **Known limit:** a resumed Claude session keeps its first instructions, so a chat started before this change does not
  have the line until a new chat; its Hangul call is still refused with the place named.
- Tests: `tests/unit/doc-skills.test.ts` (the line while off, not while on, never the guide or `.hwpx` while off),
  `tests/unit/i-wiring.test.ts` (a chat turn with the plugin off has the line and no edit_hwp; on, no line).
