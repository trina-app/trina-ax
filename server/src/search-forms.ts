// A search word's forms (shared/src/search-text.ts searchForms) as one SQL condition on a text column: any of them as a
// part of the text (docs/decisions/20261121-ko-search-forms.md). A Korean verb has many forms that differ only in their
// last syllable ("만든", "만들", "만듭" …; "보내고", "보내지" …), so those of Hangul only are written as a few GLOBs, one
// for each start they share, the last syllables as one class ("*만[든들듭]*", "*보내[고지]*"): a scan of a column reads
// each row a few times, not thirty (a scan of 100,000 messages with 30 LIKEs took seconds). Anything else is a LIKE as
// before (A–Z in any case, % and _ as themselves). Hangul has no case and no character GLOB treats as special.

/** Hangul syllables only (U+AC00…U+D7A3) */
const HANGUL = /^[\uAC00-\uD7A3]+$/u
const likeArg = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** The GLOB patterns and the LIKE words `forms` are found by (see above) */
export function formPatterns(forms: readonly string[]): { globs: string[]; likes: string[] } {
  const groups = new Map<string, string[]>()
  const likes: string[] = []
  for (const f of forms) {
    const c = [...f]
    if (!HANGUL.test(f) || c.length < 2) { likes.push(f); continue }
    const k = c.slice(0, -1).join('')
    groups.set(k, [...(groups.get(k) ?? []), c.at(-1)!])
  }
  const globs = [...groups].map(([k, xs]) => `*${k}${xs.length > 1 ? `[${xs.join('')}]` : xs[0]}*`)
  return { globs, likes }
}

/** `col` holds any of `forms`: the SQL (in brackets) and its parameters in order */
export function formsWhere(col: string, forms: readonly string[]): { sql: string; args: string[] } {
  const { globs, likes } = formPatterns(forms)
  const parts = [...globs.map(() => `${col} GLOB ?`), ...likes.map(() => `${col} LIKE ? ESCAPE '\\'`)]
  return { sql: `(${parts.join(' OR ')})`, args: [...globs, ...likes.map(likeArg)] }
}
