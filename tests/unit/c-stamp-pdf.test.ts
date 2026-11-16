// stamp_pdf through the tool path (the MCP handler, as an engine calls it): an image (a seal) put on page 1 or the last
// page of an existing PDF and saved as a new file next to it, never over the original; where it lands in mm (also on a
// turned page and on a page that leaves its coordinates changed), a PNG's transparent parts see-through; a locked or
// broken PDF refused with a plain reason; the folder rules of every save (a read-only folder, someone else's file).
// The shared chat's read card for it: tests/unit/b-shared-chat-skill-stamp.test.ts "stamp_pdf in a shared chat".
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { makePagedPdf, writePdf } from '../lib/pdf'
import { pngRgbaOf } from '../lib/images'
import { imageSize, mmToPt, placeOnPage, ptToMm, shownRect } from '../../server/src/files/pdf-stamp'
import { STAMPED } from '../../server/src/tools/stamp-pdf'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { ROOM_FILE_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS } from '../../server/src/rooms/ai-tools'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-stamp-pdf') })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
let rpcId = 0
function turn(user: Person) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, A.turn(user, A.chat(user))))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
}
const stamped = (name: string) => `${name} (${STAMPED[teamDefaultLocale(A.ctx.db)]}).pdf`

/** A JPEG's header (start, JFIF, a baseline frame with the size, end): enough for a PDF, which keeps a JPEG as it is. */
const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
/** A red disc on a see-through square (100 x 100 px): the corners are transparent. */
const SEAL = pngRgbaOf(100, 100, (x, y) => ((x - 49.5) ** 2 + (y - 49.5) ** 2 < 45 ** 2 ? [220, 20, 20, 255] : [0, 0, 0, 0]))
/** A PDF whose page is all light blue, so a transparent part of the seal shows blue, not white. `extra` page entries. */
function bluePdf(pages: number, o: { extra?: string; before?: string } = {}): Uint8Array {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '']
  const kids: string[] = []
  for (let i = 0; i < pages; i++) {
    const s = `${o.before ?? ''}0.6 0.8 1 rg 0 0 595 842 re f\n`
    kids.push(`${objs.length + 1} 0 R`)
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]${o.extra ? ` ${o.extra}` : ''} /Contents ${objs.length + 2} 0 R >>`)
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`
  return writePdf(objs)
}

const pdftoppm = Bun.which('pdftoppm')
/** One page drawn at 72 dpi (1 px = 1 pt), as RGB. */
function render(rel: string, page: number): { w: number; h: number; at: (x: number, y: number) => [number, number, number] } {
  const p = Bun.spawnSync([pdftoppm!, '-r', '72', '-f', String(page), '-l', String(page), '-singlefile', file(rel)], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  const b = Buffer.from(p.stdout)
  // P6 <w> <h> 255\n<rgb>
  const head = b.subarray(0, 40).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/)!
  const off = head[0].length
  const w = +head[1]!, h = +head[2]!
  return { w, h, at: (x, y) => { const o = off + (Math.round(y) * w + Math.round(x)) * 3; return [b[o]!, b[o + 1]!, b[o + 2]!] } }
}
const red = (c: number[]) => c[0]! > 180 && c[1]! < 80 && c[2]! < 80
const blue = (c: number[]) => c[2]! > 200 && c[0]! < 190 && c[0]! > 120

describe('the maths: mm and points, where on the page', () => {
  test('mm and points: 25.4 mm is 72 pt; A4 is 595.3 x 841.9 pt', () => {
    expect(mmToPt(25.4)).toBeCloseTo(72, 9)
    expect(mmToPt(210)).toBeCloseTo(595.28, 2)
    expect(ptToMm(841.89)).toBeCloseTo(297, 2)
    expect(ptToMm(mmToPt(37.5))).toBeCloseTo(37.5, 9)
  })
  test('presets keep the margin to the edges; x/y is the top-left corner from the top-left', () => {
    const W = 595, H = 842, iw = 85, ih = 85, m = 15
    const mp = mmToPt(m)
    expect(shownRect('top-left', W, H, iw, ih, m)).toEqual({ u: mp, v: mp })
    expect(shownRect('bottom-right', W, H, iw, ih, m)).toEqual({ u: W - mp - iw, v: H - mp - ih })
    expect(shownRect('center', W, H, iw, ih, m)).toEqual({ u: (W - iw) / 2, v: (H - ih) / 2 })
    const xy = shownRect({ x_mm: 40, y_mm: 30 }, W, H, iw, ih, m)
    expect(xy.u).toBeCloseTo(113.39, 2)
    expect(xy.v).toBeCloseTo(85.04, 2)
  })
  test('the page as shown, turned or not: the image\'s top-left lands where it was asked for', () => {
    const box = { x: 10, y: 20, width: 600, height: 800 }
    // an unturned page: top-left (u, v) is (x, y + height - v - ih) in PDF space
    expect(placeOnPage(box, 0, 50, 100, 80, 40)).toEqual({ x: 60, y: 20 + 800 - 140, width: 80, height: 40, rotate: 0 })
    // a page turned 90 degrees clockwise when shown: the shown width is the box's height; the image turns back
    expect(placeOnPage(box, 90, 50, 100, 80, 40)).toEqual({ x: 10 + 140, y: 20 + 50, width: 80, height: 40, rotate: 90 })
    expect(placeOnPage(box, 180, 50, 100, 80, 40)).toEqual({ x: 10 + 550, y: 20 + 140, width: 80, height: 40, rotate: 180 })
    expect(placeOnPage(box, 270, 50, 100, 80, 40)).toEqual({ x: 10 + 600 - 140, y: 20 + 800 - 50, width: 80, height: 40, rotate: 270 })
    expect(placeOnPage(box, -90, 50, 100, 80, 40).rotate).toBe(270)
  })
  test('image sizes from their headers', () => {
    expect(imageSize(SEAL, 'png')).toEqual({ width: 100, height: 100 })
    expect(imageSize(jpeg(320, 200), 'jpg')).toEqual({ width: 320, height: 200 })
  })
})

describe('stamping', () => {
  test('the last page by default, bottom right, as a new file next to the original; the original unchanged', async () => {
    const rel = 'groups/marketing/quotes/quote-acme.pdf'
    put(rel, bluePdf(3))
    put('groups/marketing/seal.png', SEAL)
    const before = fs.readFileSync(file(rel))
    const call = turn('alice')
    const r = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png' })
    expect(r.isError, r.text).toBe(false)
    const out = `groups/marketing/quotes/${stamped('quote-acme')}`
    expect(r.text).toContain(`Saved ${out}; ${rel} is unchanged.`)
    expect(r.text).toContain('The image is on page 3 of 3: 30 x 30 mm')
    expect(r.text).toContain(`read '${out}' with pages: "3" and as_images: true`)
    expect(fs.readFileSync(file(rel)).equals(before)).toBe(true)
    expect(fs.readFileSync(file(out)).subarray(0, 5).toString()).toBe('%PDF-')
    const ev = A.ctx.db.query('SELECT action, user_id, detail FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1').get(out) as { action: string; user_id: string; detail: string }
    expect([ev.action, ev.user_id, JSON.parse(ev.detail).tool]).toEqual(['create', 'alice', 'stamp_pdf'])
    if (pdftoppm) {
      const pg = render(out, 3)
      // 30 mm = 85 pt; 15 mm margin = 42.5 pt: the disc's middle at (595 - 42.5 - 42.5, 842 - 42.5 - 42.5)
      expect(red(pg.at(595 - 85, 842 - 85))).toBe(true)
      // PNG alpha: a transparent corner of the image shows the blue page, not white or black
      expect(blue(pg.at(595 - 42.5 - 83, 842 - 42.5 - 83))).toBe(true)
      // the first page has no seal
      expect(red(render(out, 1).at(595 - 85, 842 - 85))).toBe(false)
    }
    // again: never over the first one
    const again = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png' })
    expect(again.isError, again.text).toBe(false)
    expect(again.text).toContain(`Saved groups/marketing/quotes/${stamped('quote-acme').replace(/\.pdf$/, ' (2).pdf')};`)
  })

  test('page 1 at x/y in mm from the top-left, 25 mm wide', async () => {
    const rel = 'groups/marketing/quotes/quote-page1.pdf'
    put(rel, bluePdf(2))
    const r = await turn('alice')('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png', page: 1, position: { x_mm: 40, y_mm: 30 }, width_mm: 25, output: 'groups/marketing/quotes/page1-sealed' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('Saved groups/marketing/quotes/page1-sealed.pdf;')
    expect(r.text).toContain('on page 1 of 2: 25 x 25 mm, 40 mm from the left and 30 mm from the top (the page is 209.9 x 297 mm)')
    if (pdftoppm) {
      const pg = render('groups/marketing/quotes/page1-sealed.pdf', 1)
      const c = mmToPt(25) / 2
      expect(red(pg.at(mmToPt(40) + c, mmToPt(30) + c))).toBe(true)
      expect(red(pg.at(mmToPt(40) - 5, mmToPt(30) + c))).toBe(false)
    }
  })

  test('a turned page and a page that leaves its coordinates changed: the seal still lands bottom right as shown', async () => {
    put('groups/marketing/quotes/turned.pdf', bluePdf(1, { extra: '/Rotate 90' }))
    // a page that flips its coordinates and never puts them back (no q … Q), as some generators write
    put('groups/marketing/quotes/flipped.pdf', bluePdf(1, { before: '1 0 0 -1 0 842 cm\n' }))
    const call = turn('alice')
    for (const name of ['turned', 'flipped']) {
      const r = await call('stamp_pdf', { file_path: `groups/marketing/quotes/${name}.pdf`, image: 'groups/marketing/seal.png', output: `groups/marketing/quotes/${name}-out.pdf` })
      expect(r.isError, r.text).toBe(false)
      if (!pdftoppm) continue
      const pg = render(`groups/marketing/quotes/${name}-out.pdf`, 1)
      expect([pg.w, pg.h]).toEqual(name === 'turned' ? [842, 595] : [595, 842])
      expect(red(pg.at(pg.w - 85, pg.h - 85)), name).toBe(true)
      expect(red(pg.at(85, 85)), name).toBe(false)
    }
  })

  test('a JPG works too; a picture that does not fit, a page that is not there, and a file that is not an image: refused', async () => {
    const rel = 'groups/marketing/quotes/quote-jpg.pdf'
    put(rel, makePagedPdf([['Quote'], ['Terms']]))
    put('groups/marketing/logo.jpg', jpeg(200, 100))
    put('groups/marketing/not-an-image.png', 'just text\n')
    const call = turn('alice')
    const ok = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/logo.jpg', position: 'top-left', width_mm: 40 })
    expect(ok.isError, ok.text).toBe(false)
    expect(ok.text).toContain('40 x 20 mm, 15 mm from the left and 15 mm from the top')
    const big = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png', width_mm: 300 })
    expect(big.isError).toBe(true)
    expect(big.text).toContain('the image would not fit on the page there')
    const page = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png', page: 5 })
    expect(page.isError).toBe(true)
    expect(page.text).toContain('the PDF has 2 pages, so there is no page 5; nothing was saved')
    const notImage = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/not-an-image.png' })
    expect(notImage.isError).toBe(true)
    expect(notImage.text).toContain('is not a PNG or JPG picture')
    expect(fs.readdirSync(file('groups/marketing/quotes')).filter((n) => n.startsWith('quote-jpg')).sort()).toEqual([stamped('quote-jpg'), 'quote-jpg.pdf'].sort())
  })

  test('a PDF locked with a password, and a broken PDF: a plain reason, nothing saved', async () => {
    const locked = makePagedPdf([['Quote']])
    // an /Encrypt entry in the trailer, as a password-protected PDF has
    put('groups/marketing/quotes/locked.pdf', writePdfWith(locked, '/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>'))
    put('groups/marketing/quotes/broken.pdf', 'this is not a pdf at all\n')
    const call = turn('alice')
    const a = await call('stamp_pdf', { file_path: 'groups/marketing/quotes/locked.pdf', image: 'groups/marketing/seal.png' })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('the PDF is locked with a password or protected against changes, so nothing can be put on it; nothing was saved')
    const b = await call('stamp_pdf', { file_path: 'groups/marketing/quotes/broken.pdf', image: 'groups/marketing/seal.png' })
    expect(b.isError).toBe(true)
    expect(b.text).toContain('the file could not be opened as a PDF (it is damaged or not a PDF); nothing was saved')
    const names = fs.readdirSync(file('groups/marketing/quotes'))
    expect(names.filter((n) => n.startsWith('locked') || n.startsWith('broken')).sort()).toEqual(['broken.pdf', 'locked.pdf'])
    // never in the server's words: no stack, no library name
    for (const t of [a.text, b.text]) expect(t).not.toMatch(/pdf-lib|EncryptedPDFError|at .*\.ts|stack/i)
  })
})

/** `pdf` again with more trailer entries (its objects re-read from the file: they are plain text). */
function writePdfWith(pdf: Uint8Array, trailer: string): Uint8Array {
  const s = Buffer.from(pdf).toString('latin1')
  const objs = [...s.matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/g)].map((m) => m[1]!)
  return writePdf(objs, trailer)
}

describe('the folder rules', () => {
  test('a folder the person may only read: refused before any work; their own folder works', async () => {
    // projects/falcon: alice writes, the finance group (bob) only reads
    put('projects/falcon/quote-falcon.pdf', bluePdf(1))
    put('users/bob/seal.png', SEAL)
    const call = turn('bob')
    const r = await call('stamp_pdf', { file_path: 'projects/falcon/quote-falcon.pdf', image: 'users/bob/seal.png' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('read-only')
    expect(fs.readdirSync(file('projects/falcon')).filter((n) => n.endsWith('.pdf')).sort()).toEqual(['quote-falcon.pdf'])
    const mine = await call('stamp_pdf', { file_path: 'projects/falcon/quote-falcon.pdf', image: 'users/bob/seal.png', output: 'users/bob/quote-falcon-sealed.pdf' })
    expect(mine.isError, mine.text).toBe(false)
    expect(fs.existsSync(file('users/bob/quote-falcon-sealed.pdf'))).toBe(true)
  })

  test('someone else\'s PDF or seal: the same "not found or no access" answer, nothing saved', async () => {
    put('users/bob/private-quote.pdf', bluePdf(1))
    const call = turn('alice')
    const a = await call('stamp_pdf', { file_path: 'users/bob/private-quote.pdf', image: 'groups/marketing/seal.png' })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('not found or no access')
    const b = await call('stamp_pdf', { file_path: 'groups/marketing/quotes/quote-page1.pdf', image: 'users/bob/seal.png' })
    expect(b.isError).toBe(true)
    expect(b.text).toContain('not found or no access')
    expect(fs.readdirSync(file('users/bob')).filter((n) => n.includes('private-quote'))).toEqual(['private-quote.pdf'])
  })

  test('the original is never written over unless it was read in this turn; never into a skill folder', async () => {
    const rel = 'groups/marketing/quotes/over.pdf'
    put(rel, bluePdf(1))
    const before = fs.readFileSync(file(rel))
    const call = turn('alice')
    const r = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png', output: rel })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('read it in this turn first')
    expect(fs.readFileSync(file(rel)).equals(before)).toBe(true)
    // read first: a new version, the old one in its history
    expect((await call('read', { file_path: rel, pages: '1' })).isError).toBe(false)
    const again = await call('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png', output: rel })
    expect(again.isError, again.text).toBe(false)
    expect(again.text).toContain(`Saved a new version of ${rel} with the image on it`)
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(rel) as { n: number }).n).toBe(1)
    // over the original read in this turn: the seal's bytes still go through the wider-audience check (a chat turn
    // asks; with no chat turn to ask, refused)
    const shared = 'shared/quotes/over-shared.pdf'
    put(shared, bluePdf(1))
    put('users/alice/private-seal.png', SEAL)
    expect((await call('read', { file_path: shared, pages: '1' })).isError).toBe(false)
    const wider = await call('stamp_pdf', { file_path: shared, image: 'users/alice/private-seal.png', output: shared })
    expect(wider.isError).toBe(true)
    expect(wider.text).toContain('more people can read')
    const skill = await turn('carol')('stamp_pdf', { file_path: rel, image: 'groups/marketing/seal.png', output: 'skills/quote/seal.pdf' })
    expect(skill.isError).toBe(true)
    expect(skill.text).toContain('not saved in a skill folder')
  })
})

describe('where the tool is offered', () => {
  test('a shared chat and a room may use it; its output is where it writes', () => {
    expect(SHARED_TOOLS.has('stamp_pdf')).toBe(true)
    expect(ROOM_FILE_TOOLS.has('stamp_pdf')).toBe(true)
    expect(WRITE_TARGET_ARGS.stamp_pdf).toEqual(['output'])
  })
})
