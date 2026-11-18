// The API engine's tool result size, in a module of its own: chat/prompt.ts reads it, and engine/api-agent.ts reaches
// chat/prompt.ts through api-tools-fit.ts (estimateTokens), so an import of api-agent from prompt would be a cycle.

/** characters of one tool result the model gets (api-agent.ts toolContent); a longer result is cut (chat/prompt.ts
 * SKILL_TOOL_LIMIT) */
export const TOOL_OUTPUT_MAX = 30_000
