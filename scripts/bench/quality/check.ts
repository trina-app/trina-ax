// Checks questions.json against the made-up documents' text, without any search (README.md):
// - ids unique, types and languages known, at least 15 questions of each type, 100–150 in all
// - every expected file exists
// - paraphrase: no word of the question (as the AI's lookup takes them, questionTerms) is in an expected document, as
//   the index matches words (a part of a word counts: "pay" in "payment")
// - cross: a Korean question expects documents that are mostly not Korean, an English question mostly Korean ones
// Exit code 1 on an error; warnings only print.
//
//   bun scripts/bench/quality/check.ts
import fs from 'node:fs'
import { norm, queryTerms } from '../../../server/src/knowledge-graph/documents/text'
import { questionTerms } from '../../../server/src/knowledge-graph/documents/index'
import { loadQuestions, targetFiles, textOf, TYPES } from './lib'

const qs = loadQuestions()
const targets = new Map(targetFiles().map((t) => [t.name, t]))
const errors: string[] = []
const warnings: string[] = []

const texts = new Map<string, string>()
for (const t of targets.values()) texts.set(t.name, norm(await textOf(t.name, new Uint8Array(fs.readFileSync(t.abs)))))
const hangulShare = (s: string) => {
  const letters = [...s].filter((c) => /\p{L}/u.test(c))
  return letters.length ? letters.filter((c) => /[가-힣]/.test(c)).length / letters.length : 0
}

const ids = new Set<string>()
for (const q of qs) {
  if (ids.has(q.id)) errors.push(`${q.id}: id used twice`)
  ids.add(q.id)
  if (!(TYPES as readonly string[]).includes(q.type)) errors.push(`${q.id}: unknown type ${q.type}`)
  if (q.lang !== 'ko' && q.lang !== 'en') errors.push(`${q.id}: unknown lang ${q.lang}`)
  if (!q.q?.trim()) errors.push(`${q.id}: empty question`)
  if (!q.expectFiles?.length) errors.push(`${q.id}: no expected file`)
  for (const f of q.expectFiles ?? []) if (!targets.has(f)) errors.push(`${q.id}: expected file ${f} is not a target document`)
  const found = (q.expectFiles ?? []).filter((f) => texts.has(f))
  if (q.type === 'paraphrase') {
    for (const f of found) {
      const inDoc = questionTerms(q.q).filter((t) => texts.get(f)!.includes(t))
      if (inDoc.length) errors.push(`${q.id}: paraphrase shares ${JSON.stringify(inDoc)} with ${f}`)
      const typed = queryTerms(q.q).filter((t) => t.length >= 2 && texts.get(f)!.includes(t))
      if (typed.length) warnings.push(`${q.id}: as typed into a search box it shares ${JSON.stringify(typed)} with ${f}`)
    }
  }
  if (q.type === 'cross') {
    for (const f of found) {
      const share = hangulShare(texts.get(f)!)
      if (q.lang === 'ko' && share > 0.2) errors.push(`${q.id}: Korean question, but ${f} is ${Math.round(share * 100)}% Hangul`)
      if (q.lang === 'en' && share < 0.5) errors.push(`${q.id}: English question, but ${f} is only ${Math.round(share * 100)}% Hangul`)
    }
  }
}

const count = (f: (q: (typeof qs)[number]) => boolean) => qs.filter(f).length
console.log(`questions: ${qs.length} (ko ${count((q) => q.lang === 'ko')}, en ${count((q) => q.lang === 'en')})`)
for (const t of TYPES) {
  const n = count((q) => q.type === t)
  console.log(`  ${t.padEnd(10)} ${n} (ko ${count((q) => q.type === t && q.lang === 'ko')}, en ${count((q) => q.type === t && q.lang === 'en')})`)
  if (n < 15) errors.push(`type ${t}: ${n} questions, at least 15 needed`)
}
if (qs.length < 100 || qs.length > 150) errors.push(`${qs.length} questions; 100–150 wanted`)
const used = new Set(qs.flatMap((q) => q.expectFiles))
console.log(`target documents: ${targets.size} (${used.size} expected by some question)`)
for (const w of warnings) console.log('warning: ' + w)
for (const e of errors) console.log('ERROR: ' + e)
process.exit(errors.length ? 1 : 0)
