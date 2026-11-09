-- min_compatible_reader: 1
-- Component B: pinned conversations (docs/DECISIONS.md "Pinned conversations"; server/src/rooms/service.ts pin).
--   room_pins: one row per person and room they pinned to the top of their 대화 list ("상단에 고정"). A person's own
--     choice: nobody else in the room learns of it. Only a member pins; the row goes when they leave or are taken out
--     (Rooms.forgetMember), when they hide the room (Rooms.setHidden), with the room (cascade) and with the person
--     (cascade, and admin/users.ts deleteUser: the users row stays as a tombstone).
-- Additive only (reader 1): an older build ignores the table (no pins, its list in the usual order).
-- Numbered 278: 277 (chat_pins) is the highest on dev, 276 is taken by two open branches.
CREATE TABLE room_pins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, room_id)
);
CREATE INDEX room_pins_room ON room_pins(room_id);
