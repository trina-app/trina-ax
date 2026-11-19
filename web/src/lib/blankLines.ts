// Blank lines in a person's words (QA TC-4964; docs/decisions/20261118-message-blank-lines.md): a message shows the
// empty lines that were typed, as Slack does, up to MAX_BLANK_LINES in a row. A longer run (a message of thousands of
// line breaks) draws that many and no more, so it never fills the screen with empty rows. No dependencies: the plain
// text surfaces in the main bundle use it, and lib/messageMarkdown.ts uses the same number for Markdown.

/** The most empty lines shown in a row. */
export const MAX_BLANK_LINES = 5

/** The characters a blank line may hold: spaces, tabs, the ideographic space U+3000 and the no-break space (a line of
 * them looks empty; QA TC-4967). */
const BLANK = ' \\t\\u3000\\u00a0'
const BLANK_LINE = new RegExp(`^[${BLANK}]*$`)

/** A line that looks empty: nothing but BLANK characters. */
export const isBlankLine = (line: string) => BLANK_LINE.test(line)

// a line break followed by more than MAX_BLANK_LINES lines that are empty or only BLANK characters, then a line break
// (each repetition must end in "\n", so the match is linear: no two ways to split the same run)
const LONG_RUN = new RegExp(`\\n(?:[${BLANK}]*\\n){${MAX_BLANK_LINES + 1},}`, 'g')
const CAPPED = '\n'.repeat(MAX_BLANK_LINES + 1)

/** `text` with each run of more than MAX_BLANK_LINES blank lines (BLANK characters only) cut to MAX_BLANK_LINES ("\r\n"
 * and "\r" count as line breaks). Shorter runs, and everything else, stay as typed. */
export function capBlankLines(text: string): string {
  const s = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
  return s.replace(LONG_RUN, CAPPED)
}
