-- min_compatible_reader: 1
-- Component B: whether something unread in a room mentions a person (rooms/store.ts unreadCount: the "@" mark on the
-- rooms list, the read state after each send, each thread follower's room after a reply, the phone badge) was looked
-- for by reading every unread message after the first 1000: 50 ms at 100k messages, 120-170 ms at 300k (QA TC-4796).
-- Now it is two index lookups (docs/decisions/20261117-post-perf-history.md):
--   room_message_mentions: one row per person picked in a message (room, person, the message's seq), kept by the
--     triggers below from room_messages.mentions on every insert, edit and delete, whoever writes the row (a send, an
--     edit, Rooms.remove clearing it, an AI or app line, a room deleted with its messages). A look is the person's own
--     rows after their read position; each row's message is still checked by the full rule (MENTIONS_SQL and what
--     they may see), so this table only says where to look.
--   room_messages_mention_all: the messages that mention everyone ("@everyone"), few in any room.
-- Additive (reader 1): an older server writes messages through the same triggers.
CREATE TABLE IF NOT EXISTS room_message_mentions (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id, seq)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS room_message_mentions_insert AFTER INSERT ON room_messages
WHEN NEW.mentions <> '[]' AND json_valid(NEW.mentions) BEGIN
  INSERT OR IGNORE INTO room_message_mentions (room_id, user_id, seq) SELECT NEW.room_id, j.value, NEW.seq FROM json_each(NEW.mentions) j WHERE j.type = 'text';
END;

CREATE TRIGGER IF NOT EXISTS room_message_mentions_update AFTER UPDATE OF mentions, room_id, seq ON room_messages
WHEN OLD.mentions IS NOT NEW.mentions OR OLD.room_id IS NOT NEW.room_id OR OLD.seq IS NOT NEW.seq BEGIN
  DELETE FROM room_message_mentions WHERE room_id = OLD.room_id AND seq = OLD.seq
    AND user_id IN (SELECT j.value FROM json_each(CASE WHEN json_valid(OLD.mentions) THEN OLD.mentions ELSE '[]' END) j WHERE j.type = 'text');
  INSERT OR IGNORE INTO room_message_mentions (room_id, user_id, seq)
    SELECT NEW.room_id, j.value, NEW.seq FROM json_each(CASE WHEN json_valid(NEW.mentions) THEN NEW.mentions ELSE '[]' END) j WHERE j.type = 'text';
END;

CREATE TRIGGER IF NOT EXISTS room_message_mentions_delete AFTER DELETE ON room_messages
WHEN OLD.mentions <> '[]' BEGIN
  DELETE FROM room_message_mentions WHERE room_id = OLD.room_id AND seq = OLD.seq
    AND user_id IN (SELECT j.value FROM json_each(CASE WHEN json_valid(OLD.mentions) THEN OLD.mentions ELSE '[]' END) j WHERE j.type = 'text');
END;

-- the messages written before this migration
INSERT OR IGNORE INTO room_message_mentions (room_id, user_id, seq)
  SELECT m.room_id, j.value, m.seq FROM room_messages m, json_each(CASE WHEN json_valid(m.mentions) THEN m.mentions ELSE '[]' END) j WHERE m.mentions <> '[]' AND j.type = 'text';

CREATE INDEX IF NOT EXISTS room_messages_mention_all ON room_messages(room_id, seq) WHERE mentions_all = 1;
