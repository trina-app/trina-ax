// A guest's Team AI limit in tokens (docs/DECISIONS.md "Guest Team AI: a token limit"): the presets the invite and
// Admin › Change AI offer, and "about N answers" next to the amount. The server sends the team's own tokens per answer
// (GuestInviteLimit.answerTokens); without enough answers yet the screens use DEFAULT_TOKENS_PER_ANSWER.

/** Tokens one answer takes when the team has too few answers to tell: 80,000. Measured on the find-files bench (docs/
 * DECISIONS.md, knowledge graph wave 1: one tool call, Claude Code 80,469 and Codex 57,949 input tokens). Every step of
 * an answer reads the conversation and the tools again, and those re-reads count, so even a short answer is tens of
 * thousands of tokens. */
export const DEFAULT_TOKENS_PER_ANSWER = 80_000
/** At least this many answers with tokens before the team's own average is used. */
export const MIN_ANSWERS_FOR_AVERAGE = 20
/** How far back the team's average reads. */
export const ANSWER_AVERAGE_DAYS = 90
/** The presets, a month each (about 12, 62 and 120 answers at the default). */
export const GUEST_TOKEN_PRESETS = [1_000_000, 5_000_000, 10_000_000] as const
/** What Team AI starts with when picked. */
export const GUEST_TOKENS_DEFAULT = 5_000_000

/**
 * About how many answers `limitTokens` allows at `perAnswer` tokens each, as a friendly number that never promises more:
 * rounded down, whole under 100, to 10 under 1,000, then to two significant digits. 0 = less than one.
 */
export function answersFor(limitTokens: number, perAnswer: number): number {
  if (!(limitTokens > 0) || !(perAnswer > 0)) return 0
  const n = limitTokens / perAnswer
  if (n < 100) return Math.floor(n)
  const step = n < 1000 ? 10 : 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.floor(n / step) * step
}
