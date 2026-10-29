// Share of each displayed usage row in the token sum of all displayed rows.
type TokenRow = { inputTokens: number; outputTokens: number }

// Returns percents (0-100). The percents add up to 100 when any row has tokens.
// Skill and group rows can overlap, so a share is a part of the displayed rows, not of unique team usage.
export function usageShares(rows: readonly TokenRow[]): number[] {
  const tokens = rows.map((r) => r.inputTokens + r.outputTokens)
  const sum = tokens.reduce((a, b) => a + b, 0)
  return tokens.map((n) => (sum > 0 ? (n / sum) * 100 : 0))
}
