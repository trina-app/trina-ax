// No English sentence as an API refusal's message (language audit 2026-11-27: "Your team does not let you use auto
// mode." reached a Japanese person in English). The message of fail(code, message) and new HttpError(code, message)
// is what the app shows (web/src/lib/api.ts errorText keeps a route's own message), so it comes in the caller's
// language: from a six-language table (server/src/http/route-messages.ts routeMsg, auth/messages.ts msg, a module's
// own t(ko, en, id, ja, es, zh) table), never a literal. This scan reads server/src and relay/src (TypeScript syntax,
// so comments never count) and fails on a literal with English words in that place, beyond ALLOWED.
// fail() counts only where it is the one of server/src/http/errors.ts: other modules have helpers of that name for
// tool results the AI reads (English there is right: the AI answers in the person's language).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { ROUTE_MESSAGES, routeMsg } from '../../server/src/http/route-messages'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const DIRS = ['server/src', 'relay/src']
const WORDS = /[A-Za-z]{2,}[\s:,'’-]*\s[A-Za-z]/

/** Literal messages that stay, and why: answers read by programs, never shown to a person. */
const ALLOWED: Record<string, { n: number; why: string }> = {
  'server/src/routes/ws.ts': { n: 3, why: 'WebSocket upgrade answers, read by the browser and the relay, not shown' },
  'server/src/files/shares.ts': { n: 1, why: '"Bad cursor": a page cursor the app sent back changed, a program error the app never shows' },
  'server/src/files/folder-shares.ts': { n: 1, why: '"Bad cursor", as in shares.ts' },
}

function files(rel: string): string[] {
  return fs.readdirSync(path.join(ROOT, rel), { recursive: true }).map(String)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !/\.test\.tsx?$/.test(f))
    .map((f) => `${rel}/${f.split(path.sep).join('/')}`)
}

/** The literal English messages of one file's refusals. */
export function englishMessages(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  // `fail` only when it is imported from the HTTP errors module
  let httpFail = false
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && /(^|\/)http\/errors$/.test(s.moduleSpecifier.text)) {
      const b = s.importClause?.namedBindings
      if (b && ts.isNamedImports(b) && b.elements.some((e) => e.name.text === 'fail' && (e.propertyName?.text ?? 'fail') === 'fail')) httpFail = true
    }
  }
  if (rel.endsWith('server/src/http/errors.ts')) httpFail = true
  const literal = (e: ts.Expression | undefined): string[] => {
    if (!e) return []
    if (ts.isStringLiteralLike(e)) return [e.text]
    if (ts.isTemplateExpression(e)) return [e.head.text + e.templateSpans.map((s) => ' ' + s.literal.text).join('')]
    if (ts.isParenthesizedExpression(e)) return literal(e.expression)
    if (ts.isConditionalExpression(e)) return [...literal(e.whenTrue), ...literal(e.whenFalse)]
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.PlusToken)) return [...literal(e.left), ...literal(e.right)]
    return []
  }
  const found: string[] = []
  const visit = (n: ts.Node): void => {
    const refusal = (ts.isCallExpression(n) && httpFail && ts.isIdentifier(n.expression) && n.expression.text === 'fail')
      || (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'HttpError')
    const args = (n as ts.CallExpression).arguments
    if (refusal && args && args[0] && ts.isStringLiteralLike(args[0])) {
      for (const s of literal(args[1])) if (WORDS.test(s)) found.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${s.replace(/\s+/g, ' ').slice(0, 100)}`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

describe('API refusals are in the caller\'s language', () => {
  test('no literal English message in fail() / new HttpError() beyond ALLOWED', () => {
    const problems: string[] = []
    const seen = new Set<string>()
    for (const dir of DIRS) for (const rel of files(dir)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      if (!/\bfail\(|HttpError\(/.test(text)) continue
      const found = englishMessages(rel, text)
      if (!found.length) continue
      seen.add(rel)
      const allowed = ALLOWED[rel]?.n ?? 0
      if (found.length > allowed) problems.push(`${rel}: ${found.length} English messages, ${allowed} allowed. Put the words in a six-language table (server/src/http/route-messages.ts routeMsg) and pass c.get('locale'):\n  ${found.join('\n  ')}`)
      else if (found.length < allowed) problems.push(`${rel}: ${found.length} English messages, ALLOWED says ${allowed}: lower it`)
    }
    for (const rel of Object.keys(ALLOWED)) if (!seen.has(rel)) problems.push(`${rel}: no English messages any more: take it out of ALLOWED`)
    expect(problems).toEqual([])
  }, 60_000)

  test('the scan sees an English refusal and skips tables, codes and other helpers named fail', () => {
    const src = [
      "import { HttpError, fail } from '../http/errors'",
      "// fail('conflict', 'a comment does not count')",
      "fail('conflict', 'Your team does not let you use auto mode.')",
      "fail('not_found')",
      "fail('conflict', routeMsg('autoModeOff', locale))",
      "throw new HttpError('validation', 'Pick a folder.', { fields: {} })",
      "throw new HttpError('conflict', x ? 'Same site only.' : msg('a', l))",
      "fail('validation', `Port ${p}: not a port.`)",
      "throw new HttpError('payload_too_large', 'too_large')",
    ].join('\n')
    expect(englishMessages('x.ts', src).map((s) => s.split(' ')[0])).toEqual(['x.ts:3', 'x.ts:6', 'x.ts:7', 'x.ts:8'])
    expect(englishMessages('y.ts', "const fail = (t: string) => t\nfail('read -> refused', 'chat files')")).toEqual([])
  })

  test('route refusals have all six languages, each its own words, with the value filled in', () => {
    for (const [key, m] of Object.entries(ROUTE_MESSAGES)) for (const l of ['ko', 'id', 'ja', 'es', 'zh'] as const) expect({ key, l, same: (m[l] as string) === (m.en as string) }).toEqual({ key, l, same: false })
    expect(routeMsg('devPreviewPort', 'ja', { port: 3000 })).toBe('ポート3000はプレビューできません。')
    expect(routeMsg('autoModeOff', 'id')).toBe('Tim Anda tidak mengizinkan Anda memakai mode otomatis.')
  })
})
