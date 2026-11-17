// Spanish contractions after a filled-in value (QA, integrate/sharing-all final run 2026-11-17: "¿Quitar a el grupo
// QA-Design…?"): a text's "a {who}" or "de {who}" with a value that starts with the article "el" ("el grupo Ventas")
// reads "al grupo Ventas" / "del grupo Ventas", as Spanish requires. Only values the code filled in are marked, so a
// text's own words and a name someone typed elsewhere in it are never changed.

/** An invisible mark put before a value; never in a text of ours. */
const MARK = '⁣'

/** The value as it goes into a Spanish text, marked when it starts with "el ". */
export const esMark = (locale: string, value: string): string => (locale === 'es' && value.startsWith('el ') ? MARK + value : value)

/** The filled text with "a el" / "de el" before a marked value contracted, and every mark gone. */
export function esContract(text: string): string {
  if (!text.includes(MARK)) return text
  return text.replace(/(^|[^\p{L}])(a|de) ⁣el /gu, (_all, pre: string, prep: string) => `${pre}${prep === 'a' ? 'al' : 'del'} `).replaceAll(MARK, '')
}
