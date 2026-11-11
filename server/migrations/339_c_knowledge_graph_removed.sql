-- min_compatible_reader: 1
-- Component C: the knowledge graph was removed (docs/DECISIONS.md, 2026-11-11, "Knowledge graph removed"). Its admin
-- switches and added folders were rows of settings that nothing reads any more: knowledgeGraph.enabled (the code map),
-- knowledgeGraph.documents (the document index) and knowledgeGraph.added (more folders to index). Its index and model
-- files in the data folder are deleted at start (server/src/main.ts removeKnowledgeGraphData), not here.
-- Data only (reader 1): an older build reads no row and uses its defaults, as on a team that never changed them.
-- Numbered 339: 338 (integration_oauth_client) is the highest on dev.
DELETE FROM settings WHERE key IN ('knowledgeGraph.enabled', 'knowledgeGraph.documents', 'knowledgeGraph.added');
