// What a file made or used here may point at and which Word fields it may hold (QA TC-4949, TC-4948). One list, used by
// the template check (office-template.ts), the check of every finished Word / PowerPoint / Excel file
// (office-links-check.ts), the PDF link filter there and the Markdown link filter (tools/office-links.ts), so the
// checks cannot drift apart. Plain functions, no imports: the office worker bundles this file.

// eslint-disable-next-line no-control-regex
const NOT_IN_URL = /[\s\x00-\x1f\x7f\\\p{Cf}]/u
/** the parameters a mail link may carry: anything else (attach=, file=, ...) is refused, some mail apps add a file */
const MAILTO_PARAMS = new Set(['to', 'cc', 'bcc', 'subject', 'body'])

/**
 * A web page (http, https), a mail address (mailto, with only to / cc / bcc / subject / body) or a place inside the
 * document (#name): the only link targets a file made here may carry. No white space, control or format characters
 * or backslashes anywhere in it.
 */
export function allowedLinkTarget(target: unknown): boolean {
  if (typeof target !== 'string' || target.length > 8192 || NOT_IN_URL.test(target)) return false
  if (target.startsWith('#')) return !/[/%:]/.test(target)
  if (/^https?:\/\/[^/?#]/i.test(target)) return true
  const m = /^mailto:([^?]*)(?:\?(.*))?$/is.exec(target)
  if (!m || (!m[1] && m[2] === undefined)) return false
  if (m[2] === undefined) return true
  for (const pair of m[2].split('&')) {
    if (!pair) continue
    let name = pair.split('=')[0]!
    try { name = decodeURIComponent(name) } catch { return false }
    if (!MAILTO_PARAMS.has(name.toLowerCase())) return false
  }
  return true
}

/**
 * Word fields a file may hold: page numbers, dates, document properties, references inside the document, tables of
 * contents, form fields, formulas. Any other field is refused, known or not (a new Word may add one that fetches).
 * HYPERLINK is here; its target is checked by fieldProblem.
 */
export const SAFE_FIELDS = new Set([
  'PAGE', 'NUMPAGES', 'SECTIONPAGES', 'SECTION', 'DATE', 'TIME', 'CREATEDATE', 'SAVEDATE', 'PRINTDATE', 'EDITTIME',
  'AUTHOR', 'TITLE', 'SUBJECT', 'KEYWORDS', 'COMMENTS', 'LASTSAVEDBY', 'FILENAME', 'FILESIZE', 'NUMCHARS', 'NUMWORDS',
  'DOCPROPERTY', 'DOCVARIABLE', 'INFO', 'TEMPLATE', 'USERNAME', 'USERINITIALS', 'USERADDRESS',
  'TOC', 'TOA', 'TA', 'TC', 'INDEX', 'XE', 'REF', 'PAGEREF', 'NOTEREF', 'STYLEREF', 'SEQ', 'LISTNUM',
  'AUTONUM', 'AUTONUMLGL', 'AUTONUMOUT', 'BIDIOUTLINE', 'GOTOBUTTON', 'HYPERLINK', 'SYMBOL', 'EQ', 'ADVANCE',
  'FORMTEXT', 'FORMCHECKBOX', 'FORMDROPDOWN', 'IF', 'COMPARE', 'SET', 'ASK', 'FILLIN', 'QUOTE', 'BARCODE',
  'DISPLAYBARCODE', 'MERGEFIELD', 'MERGEREC', 'MERGESEQ', 'NEXT', 'NEXTIF', 'SKIPIF', 'ADDRESSBLOCK', 'GREETINGLINE',
  'CITATION', 'BIBLIOGRAPHY', '=',
])
/** Word fields that run something or read from outside the document: named in the refusal */
export const UNSAFE_FIELDS = new Set(['DDE', 'DDEAUTO', 'INCLUDETEXT', 'INCLUDEPICTURE', 'INCLUDE', 'IMPORT', 'LINK', 'DATABASE', 'RD',
  'MACROBUTTON', 'AUTOTEXTLIST', 'AUTOTEXT', 'GLOSSARY', 'PRIVATE', 'ADDIN', 'EMBED', 'SHAPE'])

/** The words of a field code: "quoted text" or runs without spaces. */
export function fieldWordsOf(code: string): string[] {
  return [...code.replace(/\p{Cf}/gu, '').matchAll(/"([^"]*)"?|(\S+)/g)].map((m) => m[1] ?? m[2]!)
}
/** a field's name, as Word reads it: the first word, upper case ("=" for a formula such as "=SUM(A1:A3)") */
export function fieldName(code: string): string {
  const w = fieldWordsOf(code)[0] ?? ''
  return w.startsWith('=') ? '=' : w.replace(/^\\+/, '').toUpperCase()
}

/** One field as the parsers read it: its code (the pieces of a complex field joined), whether a field is nested in
 * its code at all, and whether one comes before or inside its name (its name would then be made by that field). */
export interface FieldCode { code: string; nested: boolean; nestedName: boolean }

/** Why a Word field may not be in a file made or used here, or null. */
export function fieldProblem(f: FieldCode): string | null {
  if (f.nestedName) return 'a field whose name is made by another field'
  const name = fieldName(f.code)
  if (!name) return null
  if (UNSAFE_FIELDS.has(name)) return `a ${name.slice(0, 20)} field, which runs or fetches something when the file is opened`
  if (!SAFE_FIELDS.has(name)) return `a ${name.replace(/[^A-Z0-9=_-]/g, '').slice(0, 20) || 'unknown'} field, which is not one of the fields allowed in files made here`
  if (name !== 'HYPERLINK') return null
  if (f.nested) return 'a HYPERLINK field whose target is made by another field'
  const words = fieldWordsOf(f.code)
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (/^\\[lot]$/i.test(w)) { i++; continue } // \l bookmark, \o tooltip, \t target frame: a value follows
    if (/^\\[a-z]$/i.test(w)) continue // \m, \n
    // Word reads a doubled backslash in a field's text as one
    const target = w.replace(/\\\\/g, '\\')
    if (!allowedLinkTarget(target) || target.startsWith('#')) return 'a HYPERLINK field to something that is not a web page or a mail address'
  }
  return null
}
