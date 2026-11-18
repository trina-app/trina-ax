# make_file takes any file the person can read as its template

- Date: 2026-11-18
- Status: accepted
- Supersedes: the `skills/` rule for templates in [Hangul writing](../DECISIONS.md) ("A team's template is a .hwpx under `skills/`") and in make_file's first version
- Branch: feat/any-file-template (limits audit 2026-11-18 item #2, QA TC-4906)

- **Ask:** "Make it like my last report": the AI should use the person's own document (or the team's forms in
  `shared/양식/`, which the instructions already point to) as the design of a new Word, PowerPoint or Hangul file, as
  Claude Code would. A template had to be a file under `skills/`, so it could not.
- **Rule:** make_file's `template` is any file of the output's format (.docx, .pptx, .hwpx) the person may read. It is
  checked with the person's folder rules like any read (a file they cannot see reads as "not found or no access"), a
  folder is refused, and the size limits stay (50 MB for .docx / .pptx, the .hwpx template limit). Nothing else about
  templates changes: pandoc uses only the styles of a .docx / .pptx reference document, and a .hwpx template goes to
  the office worker as untrusted input (scripts, OLE and the other refusals of `files/hwpx-write.ts`).
- **Why it is safe:** the template was already a source of the output (`sources.push(tpl.rel)`), so the
  wider-audience check of make_file applies: a template from a narrower folder saved where more people can read asks
  the person first in a chat, and is refused without a chat turn. `skills/` was never what kept another person's
  data out; folder rules and that check are.
- **What a template may not hold (QA TC-4948):** pandoc copies a .docx / .pptx reference document's headers, footers,
  settings, masters and layouts as they are, so before it runs the template is checked in the office worker
  (`files/office-template.ts`) and refused, naming the reason, when it has a Word field that runs or fetches something
  (DDE, DDEAUTO, INCLUDETEXT, INCLUDEPICTURE, INCLUDE, IMPORT, LINK, DATABASE, MACROBUTTON, ...; complex fields joined
  across runs and simple ones, in any part under `word/`), a relationship to something outside the file other than a
  plain hyperlink (an attached template, a linked picture, an OLE object, a frame, a subdocument), an embedded object or
  control, or macros. Refused rather than stripped: the person learns which file is unsafe, and a cleaned copy would
  silently differ from the template they named. Every `.rels` part and every part under `word/` is read with saxes, namespaces resolved
  (security review): single quotes, spaces around `=`, another prefix for WordprocessingML or the strict namespace hide
  nothing, and a part with a DTD or that is not well-formed is refused. An included document (`aFChunk`, altChunk) is
  refused like an object. pandoc runs with a memory cap (1 GB, `PANDOC_RSS_MIB`): a small template can expand to
  hundreds of MB. In a chat the template is asked on the same one card as a source (`chat/tools.ts` widenOf). Page numbers, dates and hyperlinks pass. A .hwpx template was already
  safe here: only its header's style lists and its first section's page setup are used, never its text, and scripts,
  OLE objects and addresses or paths in what is kept are refused (`files/hwpx-write.ts`).
- **Guests:** they may use a file they can read (their project, their own folder); their tool text drops the
  `skills/` mention.
- **Tests:** `sec-office-template` (each unsafe field, external and object relationship, macros, the tool path), `c-tools` (a readable team document outside `skills/`, an unreadable one, a folder),
  `c-make-file-hwpx` (the person's own .hwpx, someone else's own folder), `sec-make-file-images` (a template from a
  narrower team folder is a source), `b-guests-prompt` (the guest rewrite).
- **Version impact:** patch.
