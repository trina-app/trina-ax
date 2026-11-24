// Keys on the pages of the desktop app's browser (docs/decisions/20261124-browser-key-guard.md). The AI may take the
// person to a service's sign-up or API key page; a key that page shows must not reach the AI or any record. Two layers:
// 1. The AI stops at a key screen and hands over (prompt.ts BROWSER_RULES, and keyScreenNote on the result that found
//    one, with the sentence for the person in the chat's language).
// 2. The server hides the person's stored connection keys in every form (integrations/connections/redact.ts, the same
//    redactor as the answer and the audit) and key-like text of any service (shared/src/page-keys.ts) in every browser
//    result before the model, tool_events,
//    the step record, the logs or the audit see it, and keeps pictures and script output of a key screen away: a
//    screenshot cannot be text-masked, and a script can return a key in a form the masking does not know (reversed,
//    spaced). Before a call that takes a picture or runs a script, the tab is read (read_page) and the call is refused
//    on a key screen; after one that could have changed the page first (a batch, a script), the tab is read again and
//    its pictures and output are left out on a key screen.
import type { BrowserResult, BrowserToolName, Locale } from '@mycel/shared/api'
import { scanPageText } from '@mycel/shared/page-keys'
import { HIDDEN } from '../integrations/connections/hide'
import { nothingToHide, type Redactor } from '../integrations/connections/redact'
import { tr } from './i18n'

export type BrowserCall = (tool: BrowserToolName, args: Record<string, unknown>) => Promise<BrowserResult>

/** what the server reads of a tab to decide whether it shows a key: the whole outline, deep (modals sit deep) */
export const KEY_CHECK_READ = { filter: 'all', depth: 100, max_chars: 1_000_000 } as const

export interface MaskedResult {
  result: BrowserResult
  /** values hidden in the result's texts */
  hidden: number
  /** the result shows a key (shared/src/page-keys.ts): its pictures were left out */
  keyScreen: boolean
}

/** A text with the person's stored keys (every form: escaped, base64; redact.ts) and then every key-like value
 * (page-keys.ts) replaced by HIDDEN. A stored key on the page makes it a key screen. A withholding redactor (stored
 * keys that cannot be read now) is not used here: the browser keeps working and the shape layer still runs. */
export function scanBrowserText(text: string, stored?: Redactor): { text: string; hidden: number; keyScreen: boolean } {
  const known = stored && !stored.withheld && !nothingToHide(stored) ? stored.hide(text) : text
  const storedHits = known === text ? 0 : Math.max(1, known.split(HIDDEN).length - text.split(HIDDEN).length)
  const s = scanPageText(known, HIDDEN)
  return { text: s.text, hidden: s.hidden + storedHits, keyScreen: s.keyScreen || storedHits > 0 }
}

/** The result with the stored keys and every key-like value in its texts and its error replaced by HIDDEN; on a key
 * screen without its pictures. */
export function maskBrowserResult(r: BrowserResult, stored?: Redactor): MaskedResult {
  let hidden = 0
  let keyScreen = false
  const content: BrowserResult['content'] = []
  for (const c of r.content) {
    if (c.type !== 'text') { content.push(c); continue }
    const s = scanBrowserText(c.text, stored)
    hidden += s.hidden
    keyScreen ||= s.keyScreen
    content.push(s.hidden ? { type: 'text', text: s.text } : c)
  }
  // the error repeats the text (desktop common/browser-result.ts): not counted twice
  const error = r.error === undefined ? undefined : scanBrowserText(r.error, stored)
  if (error?.keyScreen) keyScreen = true
  return {
    result: { ...r, content: keyScreen ? content.filter((c) => c.type === 'text') : content, ...(error ? { error: error.text } : {}) },
    hidden,
    keyScreen,
  }
}

const PICTURES = new Set(['screenshot', 'zoom'])
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const tabOf = (a: Record<string, unknown>): string | undefined => (typeof a.tabId === 'string' && a.tabId !== '') || typeof a.tabId === 'number' ? String(a.tabId) : undefined
const takesPicture = (name: unknown, input: Record<string, unknown>) => name === 'computer' && PICTURES.has(String(input.action))

export interface PageCheck {
  /** the tabs to read (undefined: the fronted tab) */
  tabs: (string | undefined)[]
  /** the page may change before the picture or the output (a batch, a script): read again after the call */
  after: boolean
  /** the call runs the AI's code in the page */
  script: boolean
}

/** A call that brings back pixels or what a script read: which tabs it acts on. Null for every other call. */
export function pageCheckOf(tool: string, args: Record<string, unknown>): PageCheck | null {
  if (tool === 'computer') return takesPicture(tool, args) ? { tabs: [tabOf(args)], after: false, script: false } : null
  if (tool === 'javascript_tool') return { tabs: [tabOf(args)], after: true, script: true }
  if (tool !== 'browser_batch' || !Array.isArray(args.actions)) return null
  const actions = args.actions.filter(isObj).map((a) => ({ name: a.name, input: isObj(a.input) ? a.input : {} }))
  const script = actions.some((a) => a.name === 'javascript_tool')
  if (!script && !actions.some((a) => takesPicture(a.name, a.input))) return null
  return { tabs: [...new Set(actions.map((a) => tabOf(a.input)))], after: true, script }
}

export interface KeyRead {
  keyScreen: boolean
  /** why a tab could not be read (masked), or null */
  failed: string | null
}

/** Read each tab's outline and say whether any shows a key. */
export async function readForKeys(call: BrowserCall, tabs: readonly (string | undefined)[], stored?: Redactor): Promise<KeyRead> {
  let failed: string | null = null
  for (const tab of tabs) {
    const r = await call('read_page', { ...(tab !== undefined ? { tabId: tab } : {}), ...KEY_CHECK_READ })
    if (!r.ok) {
      failed ??= scanBrowserText((r.error ?? r.content.find((c) => c.type === 'text')?.text ?? 'the page could not be read').slice(0, 300), stored).text
      continue
    }
    if (r.content.some((c) => c.type === 'text' && scanBrowserText(c.text, stored).keyScreen)) return { keyScreen: true, failed: null }
  }
  return { keyScreen: false, failed }
}

/** What the AI is told on a key screen: stop, never try another way, hand over with the person's sentence. */
export function keyScreenNote(locale: Locale): string {
  return `This page shows a key, token or other secret. In what you got it is ${HIDDEN}; screenshots and scripts on this page are refused. Stop using this page now: do not read it again, do not press show, reveal or copy for a key, and never try to get the key another way (zoom, a script, network requests, selecting or copying text). Hand over to the user now with exactly this sentence in your answer: "${tr('browserKeyHandOver', locale)}" Then wait until the user says they are done.`
}

export type Guarded =
  | { refused: true; text: string; summary: string }
  | { refused: false; result: BrowserResult; hidden: number; keyScreen: boolean; withheld: boolean; notes: string[] }

/**
 * One browser call with the key guard around it (see the top of this file). `call` runs a browser tool on the
 * person's window; `stored`: the person's stored keys (the turn's redactor). A single picture or script whose page
 * cannot be read first is not run (fails closed); a batch is (it may open the pane or the page first), and is checked
 * after.
 */
export async function guardedBrowserCall(tool: BrowserToolName, args: Record<string, unknown>, call: BrowserCall, locale: Locale, stored?: Redactor): Promise<Guarded> {
  const check = pageCheckOf(tool, args)
  const what = check?.script ? 'a script' : 'a screenshot'
  if (check) {
    const before = await readForKeys(call, check.tabs, stored)
    if (before.keyScreen) return { refused: true, text: `Not run: the page shows a key, token or other secret, and ${what} would give it to you. ${keyScreenNote(locale)}`, summary: `${tool} -> refused: the page shows a key (handed over)` }
    if (before.failed && tool !== 'browser_batch') {
      return { refused: true, text: `Not run: before ${what} the page is read to check that it shows no key, and that read failed (${before.failed}).`, summary: `${tool} -> refused: the page could not be checked for keys` }
    }
  }
  const raw = await call(tool, args)
  const m = maskBrowserResult(raw, stored)
  const notes: string[] = []
  if (m.keyScreen) {
    notes.push(keyScreenNote(locale))
    return { refused: false, result: m.result, hidden: m.hidden, keyScreen: true, withheld: false, notes }
  }
  const pictures = raw.content.some((c) => c.type === 'image')
  if (check?.after && (pictures || check.script)) {
    const after = await readForKeys(call, check.tabs, stored)
    if (after.keyScreen || after.failed) {
      // the pictures and the script's output (one text with the batch's other results) are left out
      const why = after.keyScreen
        ? `The page showed a key, token or other secret after this call, so its screenshots and output were left out. ${keyScreenNote(locale)}`
        : `This call's screenshots and output were left out: the page could not be read afterwards to check that it shows no key (${after.failed}). Read the page again, or take a new screenshot.`
      return { refused: false, result: { ...m.result, content: [], ...(m.result.error !== undefined ? { error: 'output left out (key check)' } : {}) }, hidden: m.hidden, keyScreen: after.keyScreen, withheld: true, notes: [why] }
    }
  }
  return { refused: false, result: m.result, hidden: m.hidden, keyScreen: false, withheld: false, notes }
}

/** the audit line's ending for a guarded result (never a value) */
export function guardSummary(g: Extract<Guarded, { refused: false }>): string {
  if (g.withheld) return g.keyScreen ? ' (key screen after the call: output left out, handed over)' : ' (output left out: key check failed)'
  if (g.keyScreen) return ` (key screen: ${g.hidden} key-like value${g.hidden === 1 ? '' : 's'} hidden, pictures left out, handed over)`
  return g.hidden ? ` (${g.hidden} key-like value${g.hidden === 1 ? '' : 's'} hidden)` : ''
}
