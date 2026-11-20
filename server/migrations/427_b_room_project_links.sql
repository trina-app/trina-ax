-- min_compatible_reader: 1
-- Component B: a private channel linked to a team project (docs/decisions/20261119-channel-project-link.md,
-- server/src/rooms/project-link.ts). The channel's Files button opens the project's folder, Save to project copies a
-- document there in one click, and the channel's side chat saves new documents there. Additive only (reader 1): an
-- older build never reads this table and shows its neutral line for the new event lines.
-- One project per channel (the key); one channel per project (a separate unique index, so a later "several channels per
-- project" drops only that index). A row counts only while it is active (the room a named, unarchived group room; the
-- project not in the trash and in projects/<name>): every read checks it, and a new link replaces an inactive row.
CREATE TABLE room_project_links (
  room_id    TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- who linked it: never shown; set null when their account goes
  linked_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  linked_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX room_project_links_project ON room_project_links(project_id);
