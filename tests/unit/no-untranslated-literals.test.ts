// No screen text in the web app and the phone app that skips translation (language audit 2026-11-27: "every language,
// not only Korean"). The Hangul guard (no-hangul-literals.test.ts) catches Korean; this one catches words of any
// language written straight into the places a person reads: JSX text, the attributes aria-label, title, placeholder,
// alt and label, and the text of toast(), confirm(), alert() and Alert.alert(). Words there go through t('key') with
// the key in web/src/i18n/en.ts (and the other five), or a six-language table.
// What is not counted, because it is not words of one language: message keys ("auth.passwordRule"), brand and product
// names, identifiers, paths, addresses, file names, keys and shortcuts, CSS classes, HTML entities, numbers and
// symbols. A literal that has to stay (a command to copy, a token's prefix shown as an example) goes in ALLOWED with
// its reason; when a count drops, lower it here so the room is not left for a new one.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const DIRS = ['web/src', 'mobile/src', 'mobile/App.tsx']
const ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'accessibilityLabel', 'accessibilityHint', 'hint', 'description', 'confirmLabel', 'cancelLabel'])
const CALLS = new Set(['toast', 'confirm', 'alert', 'prompt'])
const CALL_PROPS = new Set(['text', 'detail', 'label', 'title', 'message', 'body', 'description'])
/** names that read the same in every language */
const NAMES = new Set(['Trina', 'Trina AX', 'Google', 'Google Drive', 'Gmail', 'Slack', 'GitHub', 'Notion', 'Claude', 'Claude Code', 'Codex', 'ChatGPT', 'OpenAI', 'OpenRouter', 'Anthropic', 'Ollama', 'Figma', 'Canva', 'Microsoft', 'Windows', 'macOS', 'Linux', 'Android', 'iPhone', 'iOS', 'Mac', 'Chrome', 'Safari', 'Docker', 'Tailscale', 'Discord', 'Jira', 'HubSpot', 'Stripe', 'Zapier', 'Make', 'Sentry', 'PDF', 'HWP', 'MCP', 'API', 'URL', 'AI', 'ID', 'OK', 'Ctrl', 'Shift', 'Alt', 'Cmd', 'Enter', 'Esc', 'Tab', 'Mycel', 'Markdown', 'JSON', 'CSV', 'HTML', 'SHA-256'])

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [rel]
  return fs.readdirSync(abs, { recursive: true }).map(String)
    .filter((f) => /\.(tsx?|js|mjs)$/.test(f) && !f.endsWith('.d.ts') && !/(^|[/\\])(node_modules|test|tests|__tests__)[/\\]/.test(f) && !/\.test\.[jt]sx?$/.test(f))
    .map((f) => `${rel}/${f.split(path.sep).join('/')}`)
}

/** Words of a language a person reads, not a name, a key or code. */
export function looksLikeWords(raw: string): boolean {
  const s = raw.replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\{x\}/g, ' ').trim()
  if (NAMES.has(s.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ''))) return false
  // a letter word of two or more letters with a lowercase letter in it ("Save", "the"), any script
  if (!/\p{L}*\p{Ll}\p{L}*/u.test(s) || !/\p{L}{2,}/u.test(s)) return false
  if (/^(\w+:\/\/|https?:|mailto:|\/|\.\/|#|@|data:|npx |curl |irm |bun |brew )/.test(s)) return false
  if (/^\.[\w-]+$/.test(s)) return false // a dot folder (.claude)
  if (/^\w*[-_][\w-]*…$/.test(s)) return false // a token's prefix as the example (sk-…, xoxb-…)
  if (/^[a-z][\w-]*(\.[\w-]+)+$/.test(s)) return false // a message key, a file name, a host
  if (/^[\w$-]+$/.test(s) && !/^\p{Lu}?\p{Ll}+$/u.test(s)) return false // identifiers, kebab, snake, camelCase; one plain word stays
  if (/^[\w.-]+\.(png|svg|jpe?g|pdf|json|ts|tsx|js|css|html|md|txt|zip|docx|xlsx|pptx|hwpx?)$/i.test(s)) return false
  if (/^(\w+[-:/[\].%#!()]*)+(\s+[\w-:/[\].%#!()&>*]+)+$/.test(s) && /(^|\s)!?(flex|grid|px-|py-|text-|bg-|border|rounded|w-|h-|items-|gap-|p-|m[trblxy]?-|hidden|block|inline|max-md:|md:|hover:|focus)/.test(s)) return false // CSS classes
  if (/^[^\p{L}]*([\p{L}+⌘⇧⌥⌃]{1,5}[+\s|]*)+$/u.test(s) && /[⌘⇧⌥⌃+]/.test(s)) return false // shortcuts
  return true
}

const nameOf = (n: ts.PropertyName | ts.JsxAttributeName | undefined) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : n ? n.getText() : '')

/** The screen texts of one file that skip translation. */
export function untranslatedLiterals(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const add = (n: ts.Node, s: string) => { if (looksLikeWords(s)) found.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${s.replace(/\s+/g, ' ').trim().slice(0, 100)}`) }
  const literals = (e: ts.Expression | undefined): string[] => {
    if (!e) return []
    if (ts.isStringLiteralLike(e)) return [e.text]
    if (ts.isTemplateExpression(e)) return [e.head.text + e.templateSpans.map((s) => '{x}' + s.literal.text).join('')]
    if (ts.isJsxExpression(e)) return literals(e.expression)
    if (ts.isParenthesizedExpression(e)) return literals(e.expression)
    if (ts.isConditionalExpression(e)) return [...literals(e.whenTrue), ...literals(e.whenFalse)]
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) return literals(e.right)
    return []
  }
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) { if (n.text.trim()) add(n, n.text) }
    else if (ts.isJsxAttribute(n)) {
      if (ATTRS.has(nameOf(n.name)) && n.initializer) for (const s of ts.isStringLiteral(n.initializer) ? [n.initializer.text] : literals(n.initializer as ts.Expression)) add(n, s)
    } else if (ts.isJsxExpression(n) && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      for (const s of literals(n.expression)) add(n, s)
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf)
      if (CALLS.has(callee.split('.').pop()!) && !/^(console|window\.console)\./.test(callee)) {
        for (const a of n.arguments) {
          for (const s of literals(a)) add(a, s)
          if (ts.isObjectLiteralExpression(a)) for (const p of a.properties) if (ts.isPropertyAssignment(p) && CALL_PROPS.has(nameOf(p.name))) for (const s of literals(p.initializer)) add(p, s)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

/** Files that keep a literal on purpose: how many, and why. */
const ALLOWED: Record<string, { n: number; why: string }> = {
  'web/src/pages/admin/System.tsx': { n: 1, why: 'an example team address name (acme), the form the field takes' },
  'web/src/pages/admin/OfficeMcpNotice.tsx': { n: 2, why: 'terminal commands an admin copies, said with the words around them in t()' },
}

describe('no untranslated screen text in the web and phone apps', () => {
  test('every literal screen text is allowed, with its reason', () => {
    const byFile = new Map<string, string[]>()
    for (const dir of DIRS) for (const rel of files(dir)) {
      if (/^web\/src\/i18n\//.test(rel) || rel === 'mobile/src/strings.ts') continue
      const found = untranslatedLiterals(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
      if (found.length) byFile.set(rel, found)
    }
    const problems: string[] = []
    for (const [rel, found] of byFile) {
      const allowed = ALLOWED[rel]?.n ?? 0
      if (found.length > allowed) problems.push(`${rel}: ${found.length} untranslated texts, ${allowed} allowed. Use t('key') with the words in web/src/i18n/en.ts (and the other five languages):\n  ${found.join('\n  ')}`)
      else if (found.length < allowed) problems.push(`${rel}: ${found.length} untranslated texts, ALLOWED says ${allowed}: lower it`)
    }
    for (const rel of Object.keys(ALLOWED)) if (!byFile.has(rel)) problems.push(`${rel}: no untranslated texts any more: take it out of ALLOWED`)
    expect(problems).toEqual([])
  }, 60_000)

  test('the scan sees words in any language and skips keys, names and code', () => {
    const src = [
      "// <p>Comments do not count</p>",
      "const a = <p>Save changes</p>",
      "const b = <button aria-label=\"Close\" title={t('x.close')} />",
      "const c = <input placeholder={busy ? 'Loading…' : t('x.find')} />",
      "toast({ level: 'error', text: 'Could not save' })",
      "const d = <p>{t('x.y')} · Google</p>",
      "setError('auth.passwordRule')",
      "const e = <code className=\"flex items-center gap-2\">SHA-256</code>",
      "const f = <kbd>{mac ? '⌘K' : 'Ctrl+K'}</kbd>",
      "const g = <p>Guardar</p>",
      "const h = <img alt=\"\" src=\"/logo.svg\" />",
      "console.log('debug line here')",
    ].join('\n')
    expect(untranslatedLiterals('x.tsx', src).map((s) => s.split(' ')[0])).toEqual(['x.tsx:2', 'x.tsx:3', 'x.tsx:4', 'x.tsx:5', 'x.tsx:10'])
  })
})
