-- Component C: the echo check for learned web links (server/src/tools/connection-urls.ts, docs/DECISIONS.md "Web links:
-- a bigger budget, the echo check for every learned link").
--   chat_seen_urls.echo: 1 when the address, as it came (a web search result, a link of a fetched page), carried what
--     the AI had sent in a tool input of this chat before it came (the marks of chat_sent_marks: the address, its query,
--     its host and path, an address inside it, a long random-looking part). Such an address always asks on a card,
--     whatever is left of the link budget, like an echo of a connection (chat_connection_urls.echo). Decided when the
--     address comes back. 0: rows written before (they keep opening within the budget, as they did).
-- An older build ignores the column (it opens the database; its rows get 0). Additive only.
ALTER TABLE chat_seen_urls ADD COLUMN echo INTEGER NOT NULL DEFAULT 0 CHECK (echo IN (0, 1));
