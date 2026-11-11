-- min_compatible_reader: 1
-- Component B: what my group often asks, on Home (docs/DECISIONS.md "Home: what my group often asks";
-- server/src/chat/often-asked.ts, often-asked-run.ts). Once a day the team's AI (the file list's reader: no tools, a
-- team-wide AI account, a turn of the owner with no chat) groups the short first lines people typed in their own AI
-- chats and writes one generic sentence per group; the server's own checks decide which sentences each group and the
-- whole team may see.
--   often_asked_items: the sentences that passed, per audience ('team', or a group id), with when they last passed
--     (`passed_at`) and their place on that day's list. No person, no count, no material. An item that stops passing
--     stays 3 days, then goes; switching the team setting off deletes them all.
--   group_member_since: since when each person is in a group (a question counts for a group only from then). Kept by
--     triggers on group_members, so every way of adding someone is covered: a person removed and added back within
--     10 seconds (one edit of the group, which deletes and adds every member) keeps the date; later, it starts again.
--   settings `oftenAsked.since`: only questions sent from then count (this build's first start; the time the switch
--     was last turned on).
-- Additive only (reader 1): an older build does not know the tables and never reads them; its group edits leave the
-- join dates as they are (the triggers stay and keep them).
-- Numbered 285: 283 is the highest B migration on dev and #355 takes 284.
CREATE TABLE often_asked_items (
  audience TEXT NOT NULL,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL,
  passed_at TEXT NOT NULL,
  PRIMARY KEY (audience, text)
);
CREATE TABLE group_member_since (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  since TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (group_id, user_id)
);
INSERT INTO group_member_since (group_id, user_id, since)
  SELECT group_id, user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM group_members;
CREATE TRIGGER group_member_since_add AFTER INSERT ON group_members BEGIN
  INSERT INTO group_member_since (group_id, user_id, since) VALUES (NEW.group_id, NEW.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (group_id, user_id) DO UPDATE SET
    since = CASE WHEN group_member_since.left_at IS NULL OR group_member_since.left_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds')
      THEN group_member_since.since ELSE excluded.since END,
    left_at = NULL;
END;
CREATE TRIGGER group_member_since_leave AFTER DELETE ON group_members BEGIN
  UPDATE group_member_since SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE group_id = OLD.group_id AND user_id = OLD.user_id;
END;
INSERT INTO settings (key, value) VALUES ('oftenAsked.since', json_quote(strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
  ON CONFLICT (key) DO NOTHING;
