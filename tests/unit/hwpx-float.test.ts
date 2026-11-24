// QA TC-8832: a picture floating behind the text, placed from its paragraph (vertRelTo="PARA"), in a paragraph without
// Hangul's stored layout must not change the text flow in the HWP preview, whatever its offset (files/hwpx-float.ts).
// The pinned renderer lays such a paragraph out zero lines tall; the preview driver lays a probe out (the pictures in
// front: the same flow) and pins each picture to the paper where it was drawn. Without the renderer in this checkout
// only the model tests run.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { floatPin, floatProbe, paragraphTops } from '../../server/src/files/hwpx-float'
import { NativeHwpEngine, localHwpAssets } from '../../server/src/files/hwp-engine'
import { hwpxDoc, hwpxParts, para } from '../lib/hwpx'

const SEAL = new Uint8Array(fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp/seal.png')))
const ITEM = '<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/>'

let ids = 100
/** a floating picture as edit_hwp (and Hangul) writes one */
function pic(o: { wrap?: string; rel?: string; off?: number; x?: number; size?: number; asChar?: boolean } = {}): string {
  const id = ids++, s = o.size ?? 4252
  return `<hp:pic id="${id}" zOrder="${id}" numberingType="NONE" textWrap="${o.wrap ?? 'BEHIND_TEXT'}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" reverse="0">` +
    `<hp:offset x="0" y="0"/><hp:orgSz width="${s}" height="${s}"/><hp:curSz width="${s}" height="${s}"/><hp:flip horizontal="0" vertical="0"/>` +
    `<hp:rotationInfo angle="0" centerX="${s >> 1}" centerY="${s >> 1}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
    `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${s}" y="0"/><hc:pt2 x="${s}" y="${s}"/><hc:pt3 x="0" y="${s}"/></hp:imgRect>` +
    `<hp:imgClip left="0" right="9000" top="0" bottom="9000"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="9000" dimheight="9000"/>` +
    `<hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>` +
    `<hp:sz width="${s}" widthRelTo="ABSOLUTE" height="${s}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="${o.asChar ? 1 : 0}" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="${o.rel ?? 'PARA'}" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="${(o.off ?? 0) >>> 0}" horzOffset="${o.x ?? 25000}"/>` +
    '<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>'
}
/** a body paragraph without stored layout (as Hancom Docs and other writers save), pictures at the end of its run */
const line = (text: string, pics: string[] = [], cache = false, vert = 0) =>
  para([], { cache, vert, raw: `<hp:run charPrIDRef="0"><hp:t>${text}</hp:t>${pics.join('')}</hp:run>` })
const LINES = ['업무 협약서 (안)', '갑: 가나다테스트 주식회사 / 을: 라마바테스트 상사', '제1조(목적) 이 협약은 갑과 을이 공동 마케팅을 하는 데 필요한 사항을 정한다.', '2026년 10월 29일']
/** a made-up agreement whose 갑 signature line holds `pics`; the same without them is the reference */
function agreement(pics: string[], o: { cache?: boolean; firstPics?: string[]; alone?: string[] } = {}): Uint8Array {
  // stored layout as Hangul saves it: each one-line paragraph 1600 units below the one before
  const texts = [...LINES, '갑 (서명): ______________________  (인)', '을 (서명): ______________________  (인)', '끝.', ...(o.alone ? [''] : [])]
  const body = texts.map((t, i) => line(t, i === LINES.length ? pics : i === LINES.length + 3 ? o.alone ?? [] : [], o.cache, 1600 * (i + 1)))
  const used = pics.length || o.firstPics?.length || o.alone?.length
  return hwpxDoc([body.join('')], {
    manifest: used ? ITEM : '', extra: used ? { 'BinData/image1.png': SEAL } : {},
    ...(o.firstPics ? { firstPara: `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${hwpxParts(hwpxDoc([''])).get('Contents/section0.xml')!.match(/<hp:secPr[\s\S]*?<\/hp:secPr>/)![0]}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl><hp:t>머리말</hp:t>${o.firstPics.join('')}</hp:run></hp:p>` } : {}),
  })
}
const section = (b: Uint8Array) => hwpxParts(b).get('Contents/section0.xml')!

describe('the probe and the pins (model)', () => {
  test('the probe leaves out the pictures behind or in front of the text placed from their paragraph, nothing else', () => {
    const doc = agreement([pic({ off: -1628 }), pic({ wrap: 'IN_FRONT_OF_TEXT' }), pic({ rel: 'PAPER', off: 30000 }), pic({ wrap: 'SQUARE' }), pic({ asChar: true }), pic().replace('vertAlign="TOP"', 'vertAlign="CENTER"')])
    const probe = floatProbe(doc)!
    expect(probe).not.toBeNull()
    const kept = (b: Uint8Array) => [...section(b).matchAll(/<hp:pic [^>]*textWrap="([A-Z_]+)"[\s\S]*?vertRelTo="([A-Z]+)" [^>]*vertAlign="([A-Z]+)"/g)].map((m) => m.slice(1).join(' '))
    expect(kept(doc)).toEqual(['BEHIND_TEXT PARA TOP', 'IN_FRONT_OF_TEXT PARA TOP', 'BEHIND_TEXT PAPER TOP', 'SQUARE PARA TOP', 'BEHIND_TEXT PARA TOP', 'BEHIND_TEXT PARA CENTER'])
    expect(kept(probe)).toEqual(['BEHIND_TEXT PAPER TOP', 'SQUARE PARA TOP', 'BEHIND_TEXT PARA TOP', 'BEHIND_TEXT PARA CENTER'])
    // the text and every other part as they were
    expect(section(probe).replace(/<[^>]+>/g, '')).toBe(section(doc).replace(/<[^>]+>/g, ''))
    const a = hwpxParts(doc), b = hwpxParts(probe)
    for (const [k, v] of a) if (k !== 'Contents/section0.xml') expect(b.get(k)).toBe(v)
  })

  test('nothing to do: no pictures, a place from the paper, a wrapping picture, a picture in a table cell', () => {
    expect(floatProbe(agreement([]))).toBeNull()
    expect(floatProbe(agreement([pic({ rel: 'PAPER', off: 30000 })]))).toBeNull()
    expect(floatProbe(agreement([pic({ wrap: 'TOP_AND_BOTTOM' })]))).toBeNull()
    const cell = `<hp:p id="9" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:sz width="20000" widthRelTo="ABSOLUTE" height="2000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:tr><hp:tc><hp:subList><hp:p id="10" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>칸</hp:t>${pic()}</hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>`
    expect(floatProbe(hwpxDoc([cell], { manifest: ITEM, extra: { 'BinData/image1.png': SEAL } }))).toBeNull()
  })

  test('paragraph tops: the first body line of each section and paragraph in page order; tables, headers and bad nodes left out', () => {
    const tl = (pi: unknown, y: unknown) => ({ type: 'TextLine', bbox: { x: 113, y, w: 500, h: 13.3 }, pi, children: [] })
    const page = (...kids: unknown[]) => ({ type: 'Page', bbox: { x: 0, y: 0, w: 793.7, h: 1122.5 }, children: [{ type: 'Body', bbox: { x: 0, y: 0, w: 1, h: 1 }, children: [{ type: 'Column', bbox: { x: 0, y: 0, w: 1, h: 1 }, children: kids }] }] })
    const tops = paragraphTops([
      page({ type: 'Header', children: [tl(1, 5)] }, tl(1, 100), tl(1, 121), { type: 'Table', children: [{ type: 'Cell', children: [tl(2, 7)] }] }, tl(3, 300), tl('x', 1), tl(4, NaN)),
      page(tl(3, 40), tl(0, 60)),
      page(tl(1, 80)),
    ], [0, 0, 1])
    expect(tops.map((t) => [t.section, t.para, t.y])).toEqual([[0, 1, 100], [0, 3, 300], [0, 0, 60], [1, 1, 80]])
    expect(paragraphTops([null, 'x', { type: 'Page', children: 5 }], [0, 0, 0])).toEqual([])
  })

  test('pinned: from the paper at the paragraph top plus the picture\'s own offset, the layer kept; no top, no change', () => {
    const doc = agreement([pic({ off: -1628 }), pic({ wrap: 'IN_FRONT_OF_TEXT', off: 900 })])
    const fixed = section(floatPin(doc, [{ section: 0, para: 5, y: 366.9 }, { section: 0, para: 6, y: 388.3 }]))
    const pos = [...fixed.matchAll(/<hp:pos [^>]*>/g)].map((m) => m[0])
    expect([...fixed.matchAll(/textWrap="([A-Z_]+)"/g)].map((m) => m[1])).toEqual(['BEHIND_TEXT', 'IN_FRONT_OF_TEXT'])
    expect(pos[0]).toContain('vertRelTo="PAPER"')
    expect(pos[0]).toContain(`vertOffset="${Math.round(366.9 * 75) - 1628}"`)
    expect(pos[1]).toContain(`vertOffset="${Math.round(366.9 * 75) + 900}"`)
    expect(pos[0]).toContain('horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT"')
    expect(pos[0]).toContain('horzOffset="25000"')
    // a picture above the top of the paper, written as Hangul writes a negative offset
    expect(section(floatPin(doc, [{ section: 0, para: 5, y: 10 }]))).toContain(`vertOffset="${(750 - 1628) >>> 0}"`)
    expect(section(floatPin(doc, []))).toBe(section(doc))
    expect(section(floatPin(doc, [{ section: 1, para: 5, y: 10 }]))).toBe(section(doc))
  })
})

// ---------------------------------------------------------------- with the pinned renderer
const RHWP = fs.existsSync(localHwpAssets().bin)
if (!RHWP) test('HWP Preview renderer not in this checkout: float rendering skipped', () => { console.log(`skipped: no ${localHwpAssets().bin}`) })
else describe('drawn by the pinned renderer: floating pictures never move the text', () => {
  const engine = new NativeHwpEngine()
  /** the text lines as drawn (an empty paragraph that holds a picture has no empty line in the render tree) */
  const lines = async (b: Uint8Array) => (await engine.layout(Buffer.from(b), 'hwpx')).pages.flatMap((p) => p.lines.filter((l) => l.text).map((l) => `${l.text}@${l.y.toFixed(1)}`))
  const reference = agreement([])
  const cases: [string, string[], { firstPics?: string[]; alone?: string[] }?][] = [
    ['a seal above its line (negative offset, as placement writes it)', [pic({ off: -1628 })]],
    ['offset 0', [pic({ off: 0 })]],
    ['below its line (positive offset)', [pic({ off: 3000 })]],
    ['two seals in one paragraph', [pic({ off: -1628, x: 20000 }), pic({ off: 500, x: 32000 })]],
    ['behind and in front in one paragraph', [pic({ off: -1628 }), pic({ wrap: 'IN_FRONT_OF_TEXT', off: -800, x: 40000 })]],
    ['a small one and a large one', [pic({ off: -300, size: 1500 }), pic({ off: -6000, size: 9000, x: 9000 })]],
    ['in the paragraph that holds the page setup', [], { firstPics: [pic({ off: 500 })] }],
    ['alone in an empty paragraph after the text', [], { alone: [pic({ off: -3000 }), pic({ wrap: 'IN_FRONT_OF_TEXT', off: -1500, x: 40000 })] }],
  ]
  for (const [name, pics, o] of cases) test(name, async () => {
    const doc = agreement(pics, o)
    expect(floatProbe(doc)).not.toBeNull()
    const want = o ? await lines(agreement([], { firstPics: o.firstPics && [], alone: o.alone && [] })) : await lines(reference)
    expect(await lines(doc)).toEqual(want)
    // drawn: only the pictures' rows differ from the document without them
    if (o?.firstPics) return
    const a = decodePng((await engine.render(Buffer.from(o ? agreement([], { alone: [] }) : reference), 'hwpx', 1)).bytes), b = decodePng((await engine.render(Buffer.from(doc), 'hwpx', 1)).bytes)
    const rows: number[] = []
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) { const k = (y * a.w + x) * 4; if ([0, 1, 2].some((c) => Math.abs(a.d[k + c]! - b.d[k + c]!) > 40)) { rows.push(y); break } }
    expect(rows.length).toBeGreaterThan(0)
    // the 갑 line is at about y 260 px and the empty last paragraph at 367: every picture here is drawn between 140 and 440
    expect(rows.filter((y) => y < 140 || y > 440)).toEqual([])
  }, 60_000)

  test('a document with Hangul\'s stored layout too', async () => {
    const doc = agreement([pic({ off: -1628 })], { cache: true })
    expect(await lines(doc)).toEqual(await lines(agreement([], { cache: true })))
  }, 60_000)
})

/** RGBA pixels of a PNG the renderer drew (8-bit, colour type 2 or 6, no interlace) */
function decodePng(b: Buffer): { w: number; h: number; d: Uint8Array } {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), ch = b[25] === 6 ? 4 : 3
  const idat: Buffer[] = []
  for (let p = 8; p < b.length;) { const n = b.readUInt32BE(p); if (b.toString('ascii', p + 4, p + 8) === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + n)); p += 12 + n }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(w * h * 4), stride = w * ch
  let prev = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= ch ? cur[x - ch]! : 0, up = prev[x]!, ul = x >= ch ? prev[x - ch]! : 0
      const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul)
      const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      cur[x] = (row[x]! + pred) & 0xff
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < ch ? cur[x * ch + k]! : 255
    prev = cur
  }
  return { w, h, d: out }
}
