-- min_compatible_reader: 1
-- Component B: what a scheduled task's card allowed its runs to save and send without a card (docs/DECISIONS.md
-- "Scheduled tasks: saving and sending allowed on the card"; chat/schedule-scope.ts, chat/schedule-cover.ts).
--   save_folder        the team folder (actual names) its runs may put new files in, and its sub-folders that have no
--                      folder rules of their own; NULL: none
--   save_folder_id     that folder on disk when the card was answered (device:inode, rooms/ai-grants.ts folderId): a
--                      folder renamed away and another made with its name is not it
--   save_rule          the folder rules on the way to it then (a hash of the rules of every ruled folder from the team
--                      root to it, never who is in a group): a change lapses the permission, a member joining does not
--   save_readers       how many people could read it then (the number the card showed)
--   save_sources       JSON: the places whose content may go there although fewer people see them ({type:'user',id},
--                      {type:'room',id}, {type:'folder',id}, {type:'root'}); rooms also allow a connection send after
--                      a room read
--   personal_sends     JSON [{connectionId, pins}]: the person's own connections a run may send to, and only to these
--                      recipients (a Notion page, an address, a channel)
--   save_lapsed_at     when the server found the folder moved, renamed, deleted, its rules changed or the person's write
--                      access gone: runs then save in the person's own folder until the card is answered again
--   save_lapse_reason  'folder' | 'rules' | 'access'
-- Additive only (reader 1): an older build ignores the columns, and its runs save nothing without a card, as before.
-- Numbered 282: 280 (project_folder_made) is the highest on dev and feat/fewer-cards-after-room-read (#275) takes 281.
ALTER TABLE schedules ADD COLUMN save_folder TEXT;
ALTER TABLE schedules ADD COLUMN save_folder_id TEXT;
ALTER TABLE schedules ADD COLUMN save_rule TEXT;
ALTER TABLE schedules ADD COLUMN save_readers INTEGER;
ALTER TABLE schedules ADD COLUMN save_sources TEXT;
ALTER TABLE schedules ADD COLUMN personal_sends TEXT;
ALTER TABLE schedules ADD COLUMN save_lapsed_at TEXT;
ALTER TABLE schedules ADD COLUMN save_lapse_reason TEXT;
