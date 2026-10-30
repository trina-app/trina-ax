-- min_compatible_reader: 1
-- Component B: sub-agents (Claude Code's Agent tool; docs/DECISIONS.md "Sub-agents"). Additive only; older builds
-- never read these columns.
-- proxy_tokens.tools: what this Claude attempt's model requests may name as tools, as JSON {"agent":bool,"webSearch":bool}
-- (server/src/proxy/model-proxy.ts checkToolNames): our mcp__team__ tools, plus Agent and WebSearch when allowed. A
-- sub-agent's own tool list shows only in its requests, so the proxy checks every request (plan review M1). NULL:
-- a token from before (or of a Codex turn): no Agent; WebSearch unless the turn is confidential.
ALTER TABLE proxy_tokens ADD COLUMN tools TEXT;
-- tool_events: the engine's id of the call (Claude Code's tool_use id, from the MCP call's _meta) and, for a call a
-- sub-agent made, the id of the Agent call that started it; a sub-task's own start / end rows (tool 'agent') carry
-- that Agent call's id. NULL for the main AI's calls of engines without these ids and for rows written before.
ALTER TABLE tool_events ADD COLUMN tool_use_id TEXT;
ALTER TABLE tool_events ADD COLUMN parent_tool_use_id TEXT;
-- turns: what the answer's sub-agents did, measured before any limit on it is set (plan review M6): how many started,
-- their tool calls and tokens (Claude Code's AgentOutput / task_notification totals). 0 without sub-agents.
ALTER TABLE turns ADD COLUMN subagents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN subagent_tool_uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN subagent_tokens INTEGER NOT NULL DEFAULT 0;
