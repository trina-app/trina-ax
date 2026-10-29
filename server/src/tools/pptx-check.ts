// make_file pptx: a fixed Markdown -> slide mapping, and a check of the slides pandoc really made (QA R2-GEN-03,
// B-W24-1, B-API-1). pandoc's default slide level depends on the document shape: "# Deck / text / ## A ... ## E"
// came out as one slide with every note merged, "# Title + 5 x ##" as six. Now:
// - the slide level is chosen from the headings: 2 when the document has a `## ` heading, else the smallest
//   heading level below `# ` that is present ('###'-only decks keep one slide per '###'), and 1 only when the
//   document has no headings except `# `
// - after the conversion the .pptx itself is read (ppt/slides/slideN.xml, their notes through the slide rels) and
//   compared with what the AI said the user asked for (`expected_slides`, `expected_notes`); a mismatch is a tool
//   error that says what is wrong and how to write it, and nothing is saved
// - the real counts and slide titles are always in the result, so the AI cannot claim a structure it did not make
import fs from 'node:fs'
import * as XLSX from 'xlsx'

export interface DeckSlide { title: string; notes: boolean }
export interface Deck { slides: DeckSlide[]; notes: number }
/** what the Markdown tree holds that changes the slide count (for the hint in the error) */
export type SlideLevel = 1 | 2 | 3 | 4 | 5 | 6
export interface DeckShape { level: SlideLevel; metaTitle: boolean; sections: number; textUnderSection: number; rules: number }

type Node = { t?: string; c?: unknown }

/** The shape of the document tree (pandoc JSON) that decides how many slides pandoc makes. */
export function deckShape(ast: { meta?: Record<string, unknown>; blocks?: Node[] }): DeckShape {
  const blocks = Array.isArray(ast.blocks) ? ast.blocks : []
  const level = (b: Node) => (b.t === 'Header' && Array.isArray(b.c) ? Number(b.c[0]) : 0)
  // the smallest heading level above 1 that is present (2 when a '## ' exists); 1 when only '# ' headings exist
  const below = blocks.map(level).filter((l) => l >= 2 && l <= 6)
  const slideLevel = (below.length ? Math.min(...below) : 1) as SlideLevel
  let sections = 0, textUnderSection = 0, rules = 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (b.t === 'HorizontalRule') rules++
    // a heading above the slide level is a section slide of its own
    if (level(b) >= 1 && level(b) < slideLevel) {
      sections++
      // pandoc puts content between a section heading and the next heading on a slide of its own (no title);
      // speaker notes alone stay with the section slide
      const next = blocks[i + 1]
      if (next && level(next) === 0 && !isNotes(next)) textUnderSection++
    }
  }
  return { level: slideLevel, metaTitle: ast.meta?.title !== undefined, sections, textUnderSection, rules }
}
const isNotes = (b: Node) => b.t === 'Div' && Array.isArray(b.c) && Array.isArray((b.c[0] as unknown[])?.[1]) && ((b.c[0] as unknown[])[1] as string[]).includes('notes')

const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unxml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e.toLowerCase()] ?? m)
const runs = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unxml(m[1]!)).join('').trim()
/** the text of the shapes whose placeholder type matches `type` */
function placeholderText(xml: string, type: RegExp): string {
  return xml.split(/<p:sp>/).slice(1).filter((sp) => type.test(/<p:ph\b[^>]*>/.exec(sp)?.[0] ?? '')).map(runs).join(' ').trim()
}

/** The slides and speaker notes of a .pptx, in slide order. */
export function readDeck(file: string): Deck {
  const zip: { FullPaths: string[]; FileIndex: { content?: unknown }[] } = XLSX.CFB.read(fs.readFileSync(file), { type: 'buffer' })
  const part = (p: string): string | null => {
    const i = zip.FullPaths.findIndex((f) => f.replace(/^Root Entry\//, '') === p)
    const c = i < 0 ? null : zip.FileIndex[i]?.content
    return c ? Buffer.from(c as Uint8Array).toString('utf8') : null
  }
  const nums = zip.FullPaths.map((f) => /^Root Entry\/ppt\/slides\/slide(\d+)\.xml$/.exec(f)?.[1]).filter((n): n is string => !!n).map(Number).sort((a, b) => a - b)
  const slides = nums.map((n) => {
    const xml = part(`ppt/slides/slide${n}.xml`) ?? ''
    const title = placeholderText(xml, /type="(title|ctrTitle)"/) || runs(xml)
    const rels = part(`ppt/slides/_rels/slide${n}.xml.rels`) ?? ''
    const target = /Target="\.\.\/notesSlides\/([^"]+)"/.exec(rels)?.[1]
    const notesXml = target ? part(`ppt/notesSlides/${target}`) : null
    return { title: title.slice(0, 60), notes: !!notesXml && placeholderText(notesXml, /type="body"/) !== '' }
  })
  return { slides, notes: slides.filter((s) => s.notes).length }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const list = (slides: DeckSlide[], pick: (s: DeckSlide) => boolean = () => true) => {
  const all = slides.map((s, i) => ({ s, i })).filter(({ s }) => pick(s))
  return all.slice(0, 20).map(({ s, i }) => `${i + 1} '${s.title || '(no title)'}'`).join(', ') + (all.length > 20 ? `, … (${all.length - 20} more)` : '')
}

/** One line for the tool result: the real counts and the slide titles. */
export function deckSummary(d: Deck): string {
  return `${plural(d.slides.length, 'slide')}, ${d.notes} with speaker notes: ${list(d.slides)}`
}

export const PPTX_FORMAT_HINT = "Each slide starts with its own '## ' heading; '###' and smaller headings stay inside the slide " +
  "(only in a deck with no '## ' heading, the next heading level that is used, for example '### ', starts each slide). " +
  "A '# ' heading is a separate section slide and counts, and text directly under a '# ' heading becomes one more slide with no title. " +
  "A YAML `title:` block adds a title slide that counts (for a title slide without YAML, use a '## ' slide). '---' starts a new slide. " +
  'Speaker notes: a `::: notes` … `:::` block under the heading of the slide they belong to.'

/** null when the deck matches what was asked; otherwise the error for the AI (nothing is saved). */
export function deckMismatch(d: Deck, shape: DeckShape, want: { slides?: number; notes?: number }): string | null {
  const problems: string[] = []
  const n = d.slides.length
  if (want.slides !== undefined && n !== want.slides) {
    let why = ''
    if (n > want.slides) {
      const extra: string[] = []
      if (shape.metaTitle) extra.push('the YAML `title:` made a title slide (slide 1)')
      if (shape.sections) extra.push(`${plural(shape.sections, "'# ' heading")} made section slides`)
      if (shape.textUnderSection) extra.push(`text directly under a '# ' heading made ${plural(shape.textUnderSection, 'slide')} with no title`)
      if (shape.rules) extra.push(`${plural(shape.rules, "'---' rule")} split slides`)
      if (extra.length) why = ` (${extra.join('; ')})`
    } else if (shape.level === 1) why = " (the document has no '## ' headings, so each '# ' heading is one slide and everything under it stays on that slide)"
    else if (shape.level > 2) why = ` (the document has no '## ' headings, so each '${'#'.repeat(shape.level)} ' heading is one slide and everything under it stays on that slide)`
    problems.push(`made ${plural(n, 'slide')}, expected ${want.slides}${why}`)
  }
  if (want.notes !== undefined && d.notes !== want.notes) {
    const missing = d.slides.some((s) => !s.notes) ? `; slides without notes: ${list(d.slides, (s) => !s.notes)}` : ''
    problems.push(`${plural(d.notes, 'slide')} ${d.notes === 1 ? 'has' : 'have'} speaker notes, expected ${want.notes}${missing}`)
  }
  if (!problems.length) return null
  return `the PowerPoint does not match the request, so nothing was saved: ${problems.join('; ')}. ` +
    `Slides made: ${list(d.slides)}. ${PPTX_FORMAT_HINT} Fix the Markdown and call make_file again.`
}
