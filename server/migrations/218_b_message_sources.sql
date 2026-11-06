-- min_compatible_reader: 1
-- Component B: the files each answer read or saw passages of while it was written, the "참고한 파일" list under the
-- answer (docs/DECISIONS.md "Sources under each answer"; server/src/files/sources.ts). One row per file, in the order
-- the AI first opened it: its team path then, the sha256 when the tool knew it, the places looked at (JSON list of
-- SourceLoc: pages, sheet ranges, slides, sections), how (comma list of read / search / grep) and whether the main AI
-- and/or a sub-agent opened it. The list is checked against the viewer's access each time it is shown; the rows go
-- with the message (and so with the chat). Additive only: an older build never reads this table.
CREATE TABLE message_sources (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  locs TEXT NOT NULL DEFAULT '[]',
  via TEXT NOT NULL,
  by_main INTEGER NOT NULL DEFAULT 1 CHECK(by_main IN (0,1)),
  by_subagent INTEGER NOT NULL DEFAULT 0 CHECK(by_subagent IN (0,1)),
  PRIMARY KEY (message_id, ord)
);
