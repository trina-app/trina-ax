// The intro deck's example (examples/data/soopteum/README.md): the slides filled from the fictional company's intro
// (`<locale>/intro-deck.json`, what the skill's AI fills in the tool's slots) checked against the tool's schema and
// laid out by the same code the server uses (layout2.ts), written as the artifact HTML a chat would get. Then
// web/scripts/skill-examples.ts takes its picture:
//
//   bun scripts/intro-deck-example.ts <ko|en> <out.html>
//   cd web && bun scripts/skill-examples.ts intro-deck <out.html> <ko|en> public/skill-examples/<ko|en>/intro-deck.webp
//
// Every number in the slides must be written in the intro (`회사 소개.md` / `Company intro.md`), as the tool demands.
import { DeckSlide2, type DeckTheme, type DeckPattern } from '../shared/src/api'
import fs from 'node:fs'
import path from 'node:path'
import { slideTexts2 } from '../server/src/intro-deck/spec2'
import { deckHtml } from '../server/src/intro-deck/html'
import { layoutDeck2, type DeckDoc2 } from '../server/src/intro-deck/layout2'
import { DECK_FONT_CSS } from '../server/src/intro-deck/theme'

const [locale, out] = process.argv.slice(2) as ['ko' | 'en', string]
if (!(locale === 'ko' || locale === 'en') || !out?.endsWith('.html')) {
  console.error('usage: bun scripts/intro-deck-example.ts <ko|en> <out.html>')
  process.exit(2)
}
const dir = path.resolve(import.meta.dir, '..', 'examples', 'data', 'soopteum', locale)
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'intro-deck.json'), 'utf8')) as {
  title: string; company: string; website: string | null; brand: string | null; theme: DeckTheme; pattern: DeckPattern; sections: string[]; slides: unknown[]
}
const intro = fs.readFileSync(path.join(dir, locale === 'ko' ? '회사 소개.md' : 'Company intro.md'), 'utf8').normalize('NFKC')
const slides = spec.slides.map((s, i) => {
  const r = DeckSlide2.safeParse(s)
  if (!r.success) throw new Error(`slides[${i}]: ${r.error.message}`)
  return r.data
})
const problems: string[] = []
slides.forEach((s, i) => {
  for (const [slot, text] of slideTexts2(s)) for (const n of text.normalize('NFKC').match(/\d[\d,.]*/g) ?? []) if (!intro.includes(n.replace(/[.,]$/, ''))) problems.push(`slides[${i}] ${slot}: "${n}" is not in the intro`)
})
const doc: DeckDoc2 = {
  v: 2, theme: spec.theme, lang: locale, title: spec.title, company: spec.company, website: spec.website, brand: spec.brand, sampled: null, logo: null,
  pattern: spec.pattern, seed: 7, slides, sections: spec.sections, pics: {}, picNotes: {}, accents: {}, treat: {}, notes: slides.map(() => []),
}
const deck = layoutDeck2(doc)
problems.push(...deck.problems)
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
fs.writeFileSync(out, deckHtml(deck, { fontCss: DECK_FONT_CSS, lang: locale, title: spec.title }))
console.log(`${out}: ${slides.length} slides`)
