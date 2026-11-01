// Counts in texts: "{n, plural, one {# person} other {# people}}" (the part of ICU's plural format the apps use). The
// form is the one Intl.PluralRules picks for the number in the text's language, and # is the number as given. The web
// app, the desktop app's own screens and the team server's messages fill counts with it, so "1 people" never shows.
// English and Spanish write both forms; Japanese repeats the same words in each form (bun run check:i18n keeps the
// forms of ja / es the same as en); Korean and Indonesian do not change a word with the number and keep a plain {n}.

/** One plural placeholder: its name and its forms. */
export const PLURAL_PATTERN = /\{(\w+), plural,((?:\s*(?:zero|one|two|few|many|other)\s*\{[^{}]*\})+)\s*\}/g
const FORM = /(zero|one|two|few|many|other)\s*\{([^{}]*)\}/g

const rules = new Map<string, Intl.PluralRules>()
/** "one", "other", ... for the number in that language (English rules for a language this runtime does not know). */
export function pluralCategory(locale: string, n: number): Intl.LDMLPluralRule {
  let r = rules.get(locale)
  if (!r) {
    try {
      r = new Intl.PluralRules(locale)
    } catch {
      r = new Intl.PluralRules('en')
    }
    rules.set(locale, r)
  }
  return r.select(n)
}

/**
 * Each plural placeholder replaced by its form for the number in `params` (a number, or a string of one such as "3").
 * A placeholder whose value is missing or not a number stays as written. Plain {name} placeholders are left for the
 * caller. The values are put in after the forms are chosen, so a value can never be read as a placeholder.
 */
export function fillPlurals(template: string, params: Record<string, string | number | undefined>, locale: string): string {
  if (!template.includes(', plural,')) return template
  return template.replace(PLURAL_PATTERN, (all, k: string, forms: string) => {
    const v = params[k]
    const n = typeof v === 'number' ? v : Number(v)
    if (v === undefined || !Number.isFinite(n)) return all
    const byForm = new Map([...forms.matchAll(FORM)].map((m) => [m[1]!, m[2]!]))
    const text = byForm.get(pluralCategory(locale, n)) ?? byForm.get('other') ?? ''
    return text.replace(/#/g, () => String(v))
  })
}

/** The names of the plural placeholders of a text. */
export const pluralNames = (template: string): string[] => [...template.matchAll(PLURAL_PATTERN)].map((m) => m[1]!)
