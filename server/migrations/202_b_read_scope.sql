-- Component B: where the content the model saw in a chat came from (design tab 1 chats.session_read_scope, tab 7
-- "공용 폴더를 거친 유출"; server/src/chat/read-scope.ts). JSON {sources:[{type:'folder',id}|{type:'user',id}|{type:'root'}]},
-- NULL = nothing read yet (no limit). Additive only.
ALTER TABLE chats ADD COLUMN session_read_scope TEXT;
