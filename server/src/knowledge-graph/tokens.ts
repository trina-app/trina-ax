// A rough token count for text the knowledge graph puts in front of the model (the lookup block before the model
// starts, the knowledge_explore answer). Budgets are in tokens, not characters: Korean and other non-Latin text takes
// far more tokens per character than English, so a character budget let a Korean block grow to two or three times the
// planned size (review of wave 1). About 4 ASCII characters per token, and 1 token for every other character (Korean
// is about 1 per character), so a Korean block stays within its budget.

/** estimated tokens of `text` */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other)
}

/** `text` cut at a whole character so that it fits `budget` estimated tokens (the whole text when it fits) */
export function fitTokens(text: string, budget: number): string {
  if (budget <= 0) return ''
  if (estimateTokens(text) <= budget) return text
  let used = 0
  let i = 0
  for (const ch of text) {
    used += ch.charCodeAt(0) < 0x80 ? 0.25 : 1
    if (used > budget) break
    i += ch.length
  }
  return text.slice(0, i)
}
