// make_file pptx: the slide count and the speaker notes the user asked for (QA R2-GEN-03, B-W24-1, B-API-1).
// B-W24-1: "5 slides including the title, notes on each" came out as one slide with all five notes merged, and the AI
// said five. B-API-1: "5 slides" came out as a title slide plus five. Now the slide level is explicit, the .pptx is
// read back after the conversion, a deck that does not match expected_slides / expected_notes is a tool error (and
// nothing is saved), and the result always states the real counts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { deckMismatch, deckShape, readDeck } from '../../server/src/tools/pptx-check'
import { which } from '../../server/src/config'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)
const pandoc = which('pandoc')

let A: CApp
beforeAll(async () => { A = await makeCApp('c-make-file-pptx') })
afterAll(async () => { await A.close() })

let rpcId = 0
async function make(args: Record<string, unknown>) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'make_file', arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
/** slide and notes parts inside the zip, counted the way QA counted them */
function parts(rel: string) {
  const out = fs.mkdtempSync(path.join(A.data, 'unzip-'))
  Bun.spawnSync(['unzip', '-o', '-q', file(rel), '-d', out])
  const ls = (d: string, re: RegExp) => (fs.existsSync(path.join(out, d)) ? fs.readdirSync(path.join(out, d)).filter((f) => re.test(f)) : [])
  return { slides: ls('ppt/slides', /^slide\d+\.xml$/).length, notes: ls('ppt/notesSlides', /^notesSlide\d+\.xml$/).length }
}
const slide = (title: string, note?: string) => `## ${title}\n\n- ${title} 내용\n\n${note ? `::: notes\n${note}\n:::\n\n` : ''}`
const five = ['제목', '목적', '일정', '예산', '다음 단계']

describe.skipIf(!pandoc)('make_file pptx: slides and speaker notes', () => {
  test('5 slides with notes: exactly 5 slides and 5 notes, and the result states the real counts', async () => {
    const md = five.map((t, i) => slide(t, `메모 ${i + 1}`)).join('')
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/five.pptx', expected_slides: 5, expected_notes: 5 })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain("5 slides, 5 with speaker notes: 1 '제목', 2 '목적', 3 '일정', 4 '예산', 5 '다음 단계'")
    expect(parts('users/alice/deck/five.pptx')).toEqual({ slides: 5, notes: 5 })
    const deck = readDeck(file('users/alice/deck/five.pptx'))
    expect(deck.slides.map((s) => s.notes)).toEqual([true, true, true, true, true])
  })

  test('B-W24-1: the deck shape that became one slide is refused with the reason, and nothing is saved', async () => {
    // "# deck / a line / ## ..." : pandoc's own guess made this one slide holding everything (all notes merged)
    const md = '# 소개\n\n발표 원고\n\n' + five.slice(1).map((t, i) => slide(t, `메모 ${i + 2}`)).join('')
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/bug.pptx', expected_slides: 5, expected_notes: 5 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('nothing was saved')
    expect(r.text).toContain('made 6 slides, expected 5')
    expect(r.text).toContain("1 '# ' heading made section slides")
    expect(r.text).toContain("text directly under a '# ' heading made 1 slide with no title")
    expect(r.text).toContain('4 slides have speaker notes, expected 5')
    expect(r.text).toContain("Each slide starts with its own '## ' heading")
    expect(fs.existsSync(file('users/alice/deck/bug.pptx'))).toBe(false)
    // without an expectation it is saved, but the result tells the real structure: never "5 slides"
    const free = await make({ content: md, format: 'pptx', output: 'users/alice/deck/free.pptx' })
    expect(free.isError, free.text).toBe(false)
    expect(free.text).toContain('6 slides, 4 with speaker notes')
    const audit = A.ctx.db.query("SELECT summary FROM tool_events WHERE tool = 'make_file' ORDER BY id DESC LIMIT 1").get() as { summary: string }
    expect(audit.summary).toContain('6 slides 4 notes')
    // each note stays on its own slide (the bug merged them into notesSlide1)
    expect(parts('users/alice/deck/free.pptx')).toEqual({ slides: 6, notes: 4 })
  })

  test('B-API-1: "# Title" plus 5 slides is 6, not the 5 asked for', async () => {
    const md = '# 발표\n\n' + five.map((t) => slide(t)).join('')
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/six.pptx', expected_slides: 5 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('made 6 slides, expected 5')
    expect(r.text).toContain("'# ' heading made section slides")
    expect(fs.existsSync(file('users/alice/deck/six.pptx'))).toBe(false)
  })

  test('title slide: only from a YAML title, and it counts (title + 4 = 5, notes on the title slide too)', async () => {
    const md = '---\ntitle: 분기 보고\n---\n\n::: notes\n표지 메모\n:::\n\n' + five.slice(1).map((t, i) => slide(t, `메모 ${i + 2}`)).join('')
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/titled.pptx', expected_slides: 5, expected_notes: 5 })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain("5 slides, 5 with speaker notes: 1 '분기 보고', 2 '목적'")
    expect(parts('users/alice/deck/titled.pptx')).toEqual({ slides: 5, notes: 5 })
    // the same YAML title with 5 '## ' slides is 6, and the error names the title slide
    const over = await make({ content: '---\ntitle: 분기 보고\n---\n\n' + five.map((t) => slide(t)).join(''), format: 'pptx', output: 'users/alice/deck/over.pptx', expected_slides: 5 })
    expect(over.isError).toBe(true)
    expect(over.text).toContain('the YAML `title:` made a title slide (slide 1)')
  })

  test('missing notes and too few slides are named; expected_* is only for pptx', async () => {
    const md = five.map((t, i) => slide(t, i % 2 === 0 ? `메모 ${i + 1}` : undefined)).join('')
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/notes.pptx', expected_slides: 5, expected_notes: 5 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("3 slides have speaker notes, expected 5; slides without notes: 2 '목적', 4 '예산'")
    expect(r.text).not.toContain('made ')
    // no '## ' headings: each '# ' is one slide and the text under it stays there
    const one = await make({ content: '# A\n\n**목적** x\n\n**일정** y\n', format: 'pptx', output: 'users/alice/deck/one.pptx', expected_slides: 3 })
    expect(one.isError).toBe(true)
    expect(one.text).toContain("made 1 slide, expected 3 (the document has no '## ' headings")
    const h1 = await make({ content: '# A\n\nx\n\n# B\n\ny\n', format: 'pptx', output: 'users/alice/deck/h1.pptx', expected_slides: 2 })
    expect(h1.isError, h1.text).toBe(false)
    const docx = await make({ content: '# A\n', format: 'docx', output: 'users/alice/deck/a.docx', expected_slides: 1 })
    expect(docx.isError).toBe(true)
    expect(docx.text).toContain('only for format "pptx"')
  })

  test('slides are read in number order past 9, notes through each slide\'s own relations', async () => {
    const titles = Array.from({ length: 12 }, (_, i) => `S${i + 1}`)
    const md = titles.map((t, i) => slide(t, i === 10 ? 'only eleven' : undefined)).join('')
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/twelve.pptx', expected_slides: 12, expected_notes: 1 })
    expect(r.isError, r.text).toBe(false)
    const deck = readDeck(file('users/alice/deck/twelve.pptx'))
    expect(deck.slides.map((s) => s.title)).toEqual(titles)
    expect(deck.slides.findIndex((s) => s.notes)).toBe(10)
  })
  // review: a deck with no '## ' heading must not get --slide-level=1 (one slide, the B-W24-1 merge) when its slides
  // use '### '; without expected_slides nothing else would catch it
  test("'###'-only deck: one slide per '### ', also without expected_slides", async () => {
    const md = ['A', 'B', 'C'].map((t) => `### ${t}\n\n- ${t} text\n\n::: notes\nnote ${t}\n:::\n\n`).join('')
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/h3.pptx' })
    expect(r.isError, r.text).toBe(false)
    expect(parts('users/alice/deck/h3.pptx')).toEqual({ slides: 3, notes: 3 })
    expect(readDeck(file('users/alice/deck/h3.pptx')).slides.map((s) => s.title)).toEqual(['A', 'B', 'C'])
  })
  test("'# ' + '###' deck: the '# ' heading is a section slide and each '### ' is a slide", async () => {
    const md = '# Deck\n\n### A\n\n- a\n\n### B\n\n- b\n'
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/h1h3.pptx', expected_slides: 3 })
    expect(r.isError, r.text).toBe(false)
    expect(readDeck(file('users/alice/deck/h1h3.pptx')).slides.map((s) => s.title)).toEqual(['Deck', 'A', 'B'])
  })
})

describe('pptx-check helpers', () => {
  test('deckShape: level 2 when a "## " heading exists, sections and text under them counted', () => {
    const h = (l: number) => ({ t: 'Header', c: [l, ['', [], []], []] })
    const p = { t: 'Para', c: [] }
    const notes = { t: 'Div', c: [['', ['notes'], []], []] }
    expect(deckShape({ meta: {}, blocks: [h(1), p, h(2), p, { t: 'HorizontalRule' }] })).toEqual({ level: 2, metaTitle: false, sections: 1, textUnderSection: 1, rules: 1 })
    expect(deckShape({ meta: { title: {} }, blocks: [h(1), notes, h(2)] })).toEqual({ level: 2, metaTitle: true, sections: 1, textUnderSection: 0, rules: 0 })
    expect(deckShape({ blocks: [h(1), p, h(1)] }).level).toBe(1)
    // no '## ': the smallest heading level below '# ' that is used, so '###' decks keep their slides
    expect(deckShape({ blocks: [h(3), p, h(3), p] }).level).toBe(3)
    expect(deckShape({ blocks: [h(1), h(3), p, h(4), p, h(3)] })).toEqual({ level: 3, metaTitle: false, sections: 1, textUnderSection: 0, rules: 0 })
    expect(deckShape({ blocks: [h(1), p, h(3), p] })).toEqual({ level: 3, metaTitle: false, sections: 1, textUnderSection: 1, rules: 0 })
    expect(deckShape({ blocks: [h(1), h(2), h(3)] }).level).toBe(2)
  })
  test('deckMismatch: null when it matches or nothing is expected', () => {
    const d = { slides: [{ title: 'a', notes: true }], notes: 1 }
    const shape = { level: 2 as const, metaTitle: false, sections: 0, textUnderSection: 0, rules: 0 }
    expect(deckMismatch(d, shape, {})).toBeNull()
    expect(deckMismatch(d, shape, { slides: 1, notes: 1 })).toBeNull()
    expect(deckMismatch(d, shape, { slides: 2 })).toContain('made 1 slide, expected 2')
  })
})
