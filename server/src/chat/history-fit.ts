// The history window of a model with a small context (docs/decisions/20261118-history-small-models.md). The window
// is HISTORY_MAX_TOKENS (40,000 estimated tokens), made for Claude Code (200k) and Codex (272k). A local model with
// 8k-32k tokens got more than it can read: an error ("This conversation got too long"), or with Ollama no error at all
// but a prompt cut from the start, so the instructions were the part that was lost.
// Now the window is what the model's context leaves after the instructions, the tool list, the message and room for
// the work and the answer. What does not fit is summarized when the summary path can (chat/history-summary.ts), else
// left out with the existing note; a model too small for the instructions alone gets a plain error instead of a cut.
import { estimateTokens, HISTORY_MAX_TOKENS } from './prompt'
import { TOOLS_SHARE } from '../engine/api-tools-fit'

/** room kept for the answer and the work of the turn (tool calls and their results): a fifth of the context,
 * at least ANSWER_ROOM_MIN */
export const ANSWER_ROOM_SHARE = 0.2
export const ANSWER_ROOM_MIN = 2_048
/** estimateTokens counts 4 ASCII characters per token; JSON schemas and code take more tokens than that */
export const ESTIMATE_MARGIN = 1.15

export interface HistoryFit {
  /** the history window, in estimated tokens (0: no room for any of it) */
  budget: number
  /** the instructions, tools and message alone leave less than ANSWER_ROOM_MIN for the answer */
  overflows: boolean
  /** the model's context makes the window smaller than the default one */
  limited: boolean
}

/**
 * The history window for a model of `contextTokens`: what is left after the instructions (without the history), the
 * tool list and the message, with ANSWER_ROOM kept, at most HISTORY_MAX_TOKENS.
 */
export function historyFit(o: { contextTokens: number; instructions: string; tools: string; message: string }): HistoryFit {
  const room = Math.max(ANSWER_ROOM_MIN, Math.floor(o.contextTokens * ANSWER_ROOM_SHARE))
  const fixed = Math.ceil((estimateTokens(o.instructions) + estimateTokens(o.tools) + estimateTokens(o.message)) * ESTIMATE_MARGIN)
  const left = o.contextTokens - room - fixed
  return { budget: Math.max(0, Math.min(HISTORY_MAX_TOKENS, left)), overflows: o.contextTokens - fixed < ANSWER_ROOM_MIN, limited: left < HISTORY_MAX_TOKENS }
}

/** room the tool list leaves for the newest messages of the history: without it, every rule added to the instructions
 * took it from the history first, and a 32k model got none of the conversation, not even the message before (the
 * tools left out instead are named in the instructions, and their rules are not sent: chat/turn.ts apiLeftOut) */
export const HISTORY_ROOM_MIN = 2_048

/**
 * The most estimated tokens the tool list may take on a model of `contextTokens`: TOOLS_SHARE of it, and never more
 * than the instructions, the message, the room for the answer and HISTORY_ROOM_MIN leave (a 16k model: about 3,000,
 * the file tools). Without that second bound the instructions and a 35% tool list together filled a 16k Ollama model
 * (QA TC-5087). The file tools are sent even when the budget is smaller (engine/api-tools-fit.ts).
 */
export function toolBudgetFor(o: { contextTokens: number; instructions: string; message: string }): number {
  const room = Math.max(ANSWER_ROOM_MIN, Math.floor(o.contextTokens * ANSWER_ROOM_SHARE))
  const fixed = Math.ceil((estimateTokens(o.instructions) + estimateTokens(o.message)) * ESTIMATE_MARGIN)
  return Math.max(0, Math.min(Math.floor(o.contextTokens * TOOLS_SHARE), Math.floor((o.contextTokens - room - fixed - HISTORY_ROOM_MIN) / ESTIMATE_MARGIN)))
}
