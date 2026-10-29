# Safe PowerPoint reference

`safe-reference.pptx` is the unmodified default reference emitted by pinned Pandoc **3.9.0.2**:

```
pandoc --print-default-data-file reference.pptx > safe-reference.pptx
```

SHA-256: `305aec729e1197926d882cfd3fcfa80755da5ddf5303febb31d81a3dc6e4215d`.
`server/src/safe-ops/reference.ts` embeds these exact bytes so both server bundle layouts use the
same reviewed artifact. Regenerate that Base64 constant whenever this file changes.

Structural review: a ZIP/XML reference with no media, VBA, OLE or executable payloads; the fixed
validator rejects active/unknown output parts and external relationships. Standard layouts are
Title Slide, Title and Content, Section Header, Two Content, Comparison, Content with Caption,
and Blank. Tests verify actual output relationships, slide count, notes and layout names. These
are predictable structural layouts; there is no visual correctness claim or uploaded-template path.

Source: Pandoc's `data/pptx/reference.pptx` in https://github.com/jgm/pandoc/tree/3.9.0.2 .
Pandoc copyright John MacFarlane and contributors; GPL-2.0-or-later. Preserve the upstream copyright
and license notices distributed with Pandoc (already a bundled runtime dependency).
