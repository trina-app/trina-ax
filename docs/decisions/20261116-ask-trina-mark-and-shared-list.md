# Every "Ask Trina" entry has Trina's mark

- Date: 2026-11-16
- Status: accepted
- Supersedes: none

**Ask (QA TC-4007, the owner).** Files' ⋯ menu of a file ("Ask Trina about this") and the file preview's "Ask Trina"
button (FilePanel, a team file and a room file) still showed lucide's sparkle, not Trina's ✦.

**Rule.** Both now use `AiMark`, the same mark as the rail's Trina tab: the menu takes the `menu` place; the preview
takes a new place, `label` (18 px beside its words on a computer, 24 px alone in the header's 16 px slot on a phone, as
the room header's ✦). The ✦ draws its own gradient, so it takes no accent colour anywhere (the room header's has none
either). The skills' sparkles stay: an action, not someone to ask.

The Shared with me follow-ups of the same PR (QA TC-4008..4010) are recorded in
[20261116-files-shared-with-me.md](20261116-files-shared-with-me.md).

**Tests.** Web unit `ai-face.test.tsx` (the `nav` and `label` places in both looks), `files-ask-ai-label.test.tsx`,
`sidebar.test.tsx` (the row's mark, no bubble, no count).
