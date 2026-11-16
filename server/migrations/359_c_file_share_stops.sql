-- min_compatible_reader: 1
-- Component C: who stopped sharing a file with whom (docs/decisions/20261116-ai-share-card-and-stop.md, server/src/
-- files/shares.ts FileShares.change). One row per person or group taken off a share, kept while they stay off it: the
-- link page tells someone it no longer opens for "<name> stopped sharing this file" instead of the plain "no access".
-- Adding them again deletes the row; the share's row going takes its rows along.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE file_share_stops (
  share_id TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
  subject_id TEXT NOT NULL,
  stopped_by TEXT NOT NULL,
  stopped_at TEXT NOT NULL,
  PRIMARY KEY(share_id, subject_type, subject_id)
);
