// No Korean words in the web app's and the phone app's code outside the dictionaries (QA 11-27: a person on Bahasa Indonesia saw Korean).
// Words a person reads go to web/src/i18n/en.ts (and the other five), or a table with all six languages (ko, en, id,
// ja, es, zh; bun run check:i18n checks it), never a Korean string in code. This scan reads every string, template and
// JSX text in the app's code (TypeScript syntax, so comments never count) and fails when a file has more Korean strings
// than ALLOWED says. What is not counted, because it is not screen text:
//   - the dictionaries: web/src/i18n/<language>.ts and any `const ko = { … }` table (desktop/src/common/i18n.ts,
//     mobile/src/strings.ts);
//   - a `ko:` entry of an object that also has `en` (a locale table), and the first argument of a `t('…', 'English', …)`
//     helper call;
//   - regular expressions, and strings that are only compared or searched for (===, case, .includes, .startsWith,
//     .test, new RegExp …): matching what people type;
//   - lists of three or more single Korean words (no spaces): matching vocabularies (search words, honorifics).
// A new Korean screen text fails here: move it to en.ts and the other languages. A Korean string that has to stay
// (matching data, a Hangul-document feature, an example in an instruction to the AI) goes in ALLOWED with its reason;
// when a count drops, lower it here so the room is not left for a new one.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dir, '..', '..')
// server/src, desktop/src, relay/src and shared/src have their own guard, by file (tests/unit/i18n-languages.test.ts "no
// Korean screen text outside the language tables"); this one covers the web app and the phone app, string by string
const DIRS = ['web/src', 'mobile/src', 'mobile/App.tsx']
const HANGUL = /[가-힣]/
const LOCALES = new Set(['ko', 'en', 'id', 'ja', 'es', 'zh'])
const MATCH_CALLS = new Set(['includes', 'startsWith', 'endsWith', 'test', 'indexOf', 'lastIndexOf', 'split', 'replace', 'replaceAll', 'has', 'match', 'matchAll', 'search'])

/** Files that keep Korean strings on purpose: how many, and why. */
const ALLOWED: Record<string, { n: number; why: string }> = {
  'web/src/lib/teamGoal.ts': { n: 4, why: 'Korean particles stripped from a typed goal' },
  'web/src/i18n/index.ts': { n: 2, why: 'Korean particle marks filled in after a value (ko only)' },
  'web/src/components/skills/SkillExampleViewer.tsx': { n: 1, why: 'Korean particle after a value (ko only)' },
  'web/src/lib/time-zones.ts': { n: 16, why: 'city names, the ko column of a per-language table' },
}

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [rel]
  return fs.readdirSync(abs, { recursive: true }).map(String)
    .filter((f) => /\.(tsx?|js|mjs)$/.test(f) && !f.endsWith('.d.ts') && !/(^|[/\\])(node_modules|test|tests|__tests__)[/\\]/.test(f) && !/\.test\.[jt]sx?$/.test(f))
    .map((f) => `${rel}/${f.split(path.sep).join('/')}`)
}

const nameOf = (n: ts.PropertyName | undefined) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : '')

/** The Korean strings of one file that count (see the top). */
export function koreanStrings(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(rel) ? ts.ScriptKind.TSX : rel.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const found: string[] = []
  const inTable = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if (ts.isPropertyAssignment(p) && nameOf(p.name) === 'ko' && ts.isObjectLiteralExpression(p.parent) && p.parent.properties.some((q) => nameOf(q.name) === 'en')) return true
      if (ts.isCallExpression(p) && p.arguments.length >= 5) {
        const [first, second] = p.arguments
        if (first && n.pos >= first.pos && n.end <= first.end && second && (ts.isTemplateLiteral(second) || (ts.isStringLiteralLike(second) && !HANGUL.test(second.text)))) return true
      }
    }
    return false
  }
  const matching = (n: ts.Node) => {
    const p = n.parent
    if (!p) return false
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true
    if (ts.isCaseClause(p)) return true
    // what is searched for, never a replacement ("s.replace(x, '저장됨')" counts)
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && MATCH_CALLS.has(p.expression.name.text)) return p.arguments[0] === n
    return ts.isNewExpression(p) && p.expression.getText(sf) === 'RegExp'
  }
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && LOCALES.has(n.name.text) && n.initializer) {
      const init = ts.isAsExpression(n.initializer) || ts.isSatisfiesExpression(n.initializer) ? n.initializer.expression : n.initializer
      // a dictionary: every value is a text (not any object that happens to be called `id`)
      if (ts.isObjectLiteralExpression(init) && init.properties.length > 0 && init.properties.every((q) => ts.isPropertyAssignment(q) && (ts.isStringLiteralLike(q.initializer) || ts.isTemplateExpression(q.initializer)))) return
    }
    if (ts.isArrayLiteralExpression(n)) {
      const words = n.elements.filter((e): e is ts.StringLiteral => ts.isStringLiteralLike(e) && HANGUL.test(e.text))
      if (words.length >= 3 && words.every((w) => !/\s/.test(w.text) && w.text.length <= 15)) return
    }
    const s = ts.isStringLiteralLike(n) || ts.isJsxText(n) ? n.text : ts.isTemplateExpression(n) ? n.getText(sf) : null
    if (s !== null && HANGUL.test(s) && !inTable(n) && !matching(n)) {
      found.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${s.replace(/\s+/g, ' ').slice(0, 100)}`)
      if (ts.isTemplateExpression(n)) return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

describe('no Korean strings in user-visible code', () => {
  // parsing every file with Korean in it takes a few seconds (more than bun's 5 s default on a busy CI runner)
  test('every Korean string outside the dictionaries is allowed, with its reason', () => {
    const byFile = new Map<string, string[]>()
    for (const dir of DIRS) {
      for (const rel of files(dir)) {
        if (/^web\/src\/i18n\/(ko|en|id|ja|es|zh)\.ts$/.test(rel)) continue
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        if (!HANGUL.test(text)) continue
        const found = koreanStrings(rel, text)
        if (found.length) byFile.set(rel, found)
      }
    }
    const problems: string[] = []
    for (const [rel, found] of byFile) {
      const allowed = ALLOWED[rel]?.n ?? 0
      if (found.length > allowed) problems.push(`${rel}: ${found.length} Korean strings, ${allowed} allowed. Move screen text to web/src/i18n/en.ts (and the other languages) or a six-language table:\n  ${found.join('\n  ')}`)
      else if (found.length < allowed) problems.push(`${rel}: ${found.length} Korean strings, ALLOWED says ${allowed}: lower it`)
    }
    for (const rel of Object.keys(ALLOWED)) if (!byFile.has(rel)) problems.push(`${rel}: no Korean strings any more: take it out of ALLOWED`)
    expect(problems).toEqual([])
  }, 60_000)

  test('the scan sees a Korean screen text and skips tables, matching and comments', () => {
    const src = [
      "// 주석은 세지 않아요",
      "const a = '저장했어요'",
      "const b = { ko: '저장', en: 'Save', id: 'Simpan' }",
      "const c = t('저장', 'Save', 'Simpan', '保存', 'Guardar', '保存')",
      "if (x === '전체') go()",
      "const d = ['급여', '연봉', '이력서']",
      "const e = <p>안녕하세요</p>",
      "const id = { label: '저장', n: 1 }",
      "const f = s.replace(x, '저장됨')",
      "alert('저장했어요', '', x)",
      "const ko = { save: '저장', cancel: '취소' }",
    ].join('\n')
    expect(koreanStrings('x.tsx', src).map((s) => s.split(' ')[0])).toEqual(['x.tsx:2', 'x.tsx:7', 'x.tsx:8', 'x.tsx:9', 'x.tsx:10'])
  })
})
