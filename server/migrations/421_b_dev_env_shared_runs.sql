-- min_compatible_reader: 1
-- Component B: jobs and dev servers of shared chats, and the port of a dev server
-- (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md).
--   dev_env_runs.shared_key: '' for a run of the person's own chat. A run of a shared chat: the key of who sees the chat
--     and what all of them may read when it was asked for (srt/runner.ts sharedLogKey). It names the run's logs folder
--     (devenv/chat-logs/<chat>/<key>), which later commands of that chat with the same people and view read; the tracker
--     builds the chat's people again for every check and stops the run when they or their access change.
--   dev_env_runs.port: the port a dev server listens on, as the AI named it (NULL: none named). A later command of the
--     same chat reaches it there on Linux (mycel-sandbox port-bridge).
-- Additive only (reader 1): an older build does not name the new columns. It rebuilds a shared row as a private one,
-- whose access hash differs, so it stops the run; it never reads the shared logs folder.
ALTER TABLE dev_env_runs ADD COLUMN shared_key TEXT NOT NULL DEFAULT '';
ALTER TABLE dev_env_runs ADD COLUMN port INTEGER;
