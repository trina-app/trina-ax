-- A conversation that can receive pixels stays offline for tools, including after rollback/disable.
CREATE TABLE safe_ops_chats (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE
);
