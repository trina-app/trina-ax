-- min_compatible_reader: 1
-- 대화방 메시지 검색 (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): the text of the room messages, for the search
-- palette's substring search, Korean included ("견적" finds "견적서를"): the trigram tokenizer, as messages_fts for the
-- chat records (201). Additive only:
--   room_messages_fts: one row per room message with text, its rowid the message's rowid (event lines and deleted
--     messages have body '' and no row). Kept by the triggers below: a new message, a change of body (an edit replaces
--     the text, a delete empties it) and a row deleted (a room deleted with its messages).
--   It only finds candidates: who sees a message is decided on room_messages by the rooms' own rule (rooms/store.ts
--   canSee), and each candidate's own body is matched again (rooms/search.ts).
-- Backfilled here, then merged into one segment ('optimize': new messages are written without merge work later).
-- An older build ignores the table; the triggers are in the database and keep it right while it runs.
-- Numbered 267: 266 is the room AI grants branch's (not on dev yet).
CREATE VIRTUAL TABLE room_messages_fts USING fts5(body, tokenize = 'trigram');
CREATE TRIGGER room_messages_fts_insert AFTER INSERT ON room_messages WHEN new.body <> '' BEGIN
  INSERT INTO room_messages_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER room_messages_fts_update AFTER UPDATE OF body ON room_messages BEGIN
  DELETE FROM room_messages_fts WHERE rowid = old.rowid;
  INSERT INTO room_messages_fts (rowid, body) SELECT new.rowid, new.body WHERE new.body <> '';
END;
CREATE TRIGGER room_messages_fts_delete AFTER DELETE ON room_messages BEGIN
  DELETE FROM room_messages_fts WHERE rowid = old.rowid;
END;
INSERT INTO room_messages_fts (rowid, body) SELECT rowid, body FROM room_messages WHERE body <> '';
INSERT INTO room_messages_fts (room_messages_fts) VALUES ('optimize');
