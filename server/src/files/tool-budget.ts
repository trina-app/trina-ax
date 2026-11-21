// How much text one result of the AI's file tools may hold (QA TC-4921): Claude Code cuts an MCP tool result over
// MAX_MCP_OUTPUT_TOKENS (25,000 tokens by default), so a long grep or folder list lost its end without a word. A result
// stops below that and ends with the exact next call (`offset`). read has its own budget (files/read-lines.ts).
import { textTokens } from './vision'

/** A tool result's text budget: characters and tokens (vision.ts textTokens). */
export interface OutputBudget { chars: number; tokens: number }
/** about 20,000 tokens, with room for the notes; the same numbers as read's (files/read-lines.ts, PR #1282) */
export const TOOL_TEXT_BUDGET: OutputBudget = { chars: 28_000, tokens: 20_000 }

/** A folder's entries from `offset`, as many as fit the budget; a cut list ends with the next call. */
export function listPage(lines: string[], offset: number, budget = TOOL_TEXT_BUDGET): string {
  if (offset >= lines.length && offset > 0) return `(no entries from ${offset}: the folder has ${lines.length})`
  const out: string[] = []
  let chars = 0, tokens = 0, i = offset
  for (; i < lines.length; i++) {
    const l = lines[i]!
    const t = textTokens(l) + 1
    if (out.length && (chars + l.length + 1 > budget.chars || tokens + t > budget.tokens)) break
    out.push(l); chars += l.length + 1; tokens += t
  }
  if (i < lines.length) out.push(`... (${lines.length - i} more of ${lines.length} entries; for the next ones call list again with offset=${i}, or use glob to find names)`)
  return out.join('\n')
}
