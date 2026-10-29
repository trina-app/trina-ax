/** Lists every missing translation or placeholder/plural mismatch; never fills with English. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { DICTS, placeholdersOf } from '../web/src/i18n'
import { STRINGS } from '../desktop/src/common/i18n'

const locales = ['ko', 'en', 'id', 'ja', 'es'] as const
const root = path.resolve(import.meta.dir, '..')
const pluralForms = (s: string) => [...s.matchAll(/\{(\w+), plural,((?:\s*(?:zero|one|two|few|many|other)\s*\{[^{}]*\})+)\s*\}/g)]
  .map(m => `${m[1]}:${[...m[2]!.matchAll(/(zero|one|two|few|many|other)\s*\{/g)].map(f => f[1]).sort().join(',')}`).sort()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function auditI18n() {
  const problems: string[] = []
  const counts: Record<string, number> = {}
  for (const [name, dictionaries] of [['web', DICTS], ['desktop', STRINGS]] as const) {
    const english = dictionaries.en
    for (const locale of locales) {
      const dictionary = dictionaries[locale] as Record<string, string>
      counts[`${name}.${locale}`] = Object.keys(dictionary).length
      for (const [key, value] of Object.entries(english)) {
        const translated = dictionary[key]
        if (!translated?.trim()) problems.push(`${name}.${locale}.${key}: missing translation`)
        else if (!same(placeholdersOf(value), placeholdersOf(translated))) problems.push(`${name}.${locale}.${key}: placeholder mismatch with en`)
        // Korean/Indonesian historically use simple count placeholders. New locales preserve English ICU forms.
        else if ((locale === 'ja' || locale === 'es') && !same(pluralForms(value), pluralForms(translated))) problems.push(`${name}.${locale}.${key}: plural forms differ from en`)
      }
      for (const key of Object.keys(dictionary)) if (!(key in english)) problems.push(`${name}.${locale}.${key}: unknown key`)
    }
  }
  let tables = 0
  let helperCalls = 0
  const propertyName = (n: ts.PropertyName) => ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : undefined
  for (const dir of ['shared/src', 'server/src', 'relay/src', 'web/src', 'desktop/src']) {
    for (const file of fs.readdirSync(path.join(root, dir), { recursive: true }).map(String).filter(f => /\.tsx?$/.test(f))) {
      const relative = `${dir}/${file}`
      const source = ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'), ts.ScriptTarget.Latest, true)
      const checkValues = (values: Map<string | undefined, ts.Expression>, location: string) => {
        const reference = values.get('en')
        if (!reference) return
        const signature = (expression: ts.Node) => {
          const variables = new Set<string>()
          const strings: string[] = []
          const visitExpression = (n: ts.Node) => {
            if (ts.isStringLiteralLike(n)) strings.push(n.text)
            if (ts.isTemplateExpression(n)) {
              strings.push(n.head.text, ...n.templateSpans.map(span => span.literal.text))
              const ids = (e: ts.Node) => {
                if (ts.isIdentifier(e) && !['enPlural', 'String'].includes(e.text)
                  && !(ts.isPropertyAccessExpression(e.parent) && e.parent.name === e)) variables.add(e.text)
                ts.forEachChild(e, ids)
              }
              for (const span of n.templateSpans) ids(span.expression)
              return
            }
            ts.forEachChild(n, visitExpression)
          }
          visitExpression(expression)
          return { variables: [...variables].sort(), placeholders: [...new Set(strings.flatMap(placeholdersOf))].sort() }
        }
        const expected = signature(reference)
        for (const locale of ['ja', 'es']) {
          const value = values.get(locale)
          if (value && !same(expected, signature(value))) problems.push(`${location}: ${locale} substitutions differ from en`)
        }
      }
      // The small t()/fail() helpers have the same five-argument contract as literal tables.
      const helpers = new Set<string>()
      const findHelpers = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer)) {
          const names = node.initializer.parameters.map(p => p.name.getText(source))
          if (['ko', 'en', 'id'].every((l, i) => names[i] === l)) helpers.add(node.name.text)
        }
        ts.forEachChild(node, findHelpers)
      }
      findHelpers(source)
      // Voice helpers are also imported by jobs/openrouter-stt.ts.
      if (relative === 'server/src/jobs/openrouter-stt.ts') helpers.add('fail')
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
          helperCalls++
          const location = `${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
          const values = new Map(locales.map((l, i) => [l, node.arguments[i]]).filter((entry): entry is [typeof locales[number], ts.Expression] => !!entry[1]))
          for (const locale of locales) if (!values.has(locale)) problems.push(`${location}: missing ${locale}`)
          checkValues(values, location)
        }
        if (ts.isObjectLiteralExpression(node)) {
          const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map(p => [propertyName(p.name), p.initializer]))
          if (['ko', 'en', 'id'].every(l => properties.has(l))) {
            tables++
            const location = `${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
            for (const locale of locales) if (!properties.has(locale)) problems.push(`${location}: missing ${locale}`)
            checkValues(properties, location)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  counts.localeTables = tables
  counts.localeHelperCalls = helperCalls
  return { problems, counts }
}

if (import.meta.main) {
  const { problems, counts } = auditI18n()
  console.log(JSON.stringify(counts, null, 2))
  for (const problem of problems) console.error(problem)
  console.log(`${problems.length} i18n issue(s)`)
  process.exitCode = problems.length ? 1 : 0
}
