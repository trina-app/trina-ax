// The words of the popup and the pair page at run time: the person's language when the team told it (the server's hello
// sends their own language, else the team's), else Chrome's own (chrome.i18n, the browser's UI language). Chrome picks
// _locales only by the browser's language, so the tables in messages.ts are bundled here too.
import { PRODUCT } from '../../shared/src/product'
import { MESSAGES, type Locale, type MessageKey } from './messages'

/** a team language (shared Locale: ko en id ja es zh) as the extension's _locales folder names it, or null */
export function extLocale(l: unknown): Locale | null {
  switch (l) {
    case 'en': case 'ko': case 'ja': case 'es': case 'id': return l
    case 'zh': return 'zh_CN'
    default: return null
  }
}

let chosen: Locale | null = null

/** Speak this team language from now on (null: the browser's). */
export function useLocale(l: unknown) { chosen = extLocale(l) }

/** One message with $1, $2 filled, in the chosen language, else Chrome's. */
export function t(key: MessageKey, subs: string[] = []): string {
  if (!chosen) return chrome.i18n.getMessage(key, subs) || key
  return fill(MESSAGES[chosen][key], subs)
}

/** `{app}` is the product's name; $1.. the values (a "$" in a value stays as it is) */
export function fill(text: string, subs: string[]): string {
  return text.replace(/\{app\}/g, () => PRODUCT.displayName).replace(/\$(\d)/g, (m, n: string) => subs[Number(n) - 1] ?? m)
}

/** the page's lang attribute */
export function uiLanguage(): string {
  return chosen ? chosen.replace('_', '-') : chrome.i18n.getUILanguage()
}
