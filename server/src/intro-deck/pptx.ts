// The intro deck as a PowerPoint file (docs/DECISIONS.md "D2"), our own writer on files/zip-write.ts (no pptxgenjs:
// it writes the Chinese charset on Hangul runs, has no gradients, no line-break control and no font embedding). It
// draws only what the display list says (layout.ts): one master and one blank layout; one text box per paragraph
// (editable, as wide as its layout column, our line breaks as <a:br/>, exact line spacing so a substitute font's taller
// line box cannot push lines down, eaLnBrk="0" so an edit never splits a Hangul word); pictures with the layout's crop
// as srcRect; gradients as gradFill with alpha; hairlines as lines; the sources of each slide in its notes.
// Pretendard is embedded (the owner's decision 1, EMBED_FONTS): Regular and Bold as the family "Pretendard", ExtraBold
// as its own family, as Pretendard names them.
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'
import { writeZip, type ZipEntry } from '../files/zip-write'
import { eotOf, panoseHex } from './eot'
import { SLIDE_H, SLIDE_W, type DeckOut, type Fill, type Item, type SlideOut, type TextItem } from './layout'
import { gradientPng, recolorPng } from './png'

/** The owner's decision 1 (2026-11-06): Pretendard goes into the PowerPoint file. One constant to change. */
export const EMBED_FONTS = true
/** The bundled static Pretendard files (resources/fonts/pretendard/, or the server bundle's fonts/). */
export const PRETENDARD_FILES = { regular: 'Pretendard-Regular.ttf', bold: 'Pretendard-Bold.ttf', extrabold: 'Pretendard-ExtraBold.ttf' } as const

const EMU = 12192000 / SLIDE_W // 6350 per px
const e = (px: number) => Math.round(px * EMU)
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
// eslint-disable-next-line no-control-regex
export const x = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const LANG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', id: 'id-ID', ja: 'ja-JP', es: 'es-ES' }
/** The East Asian font charset of each language (Hangul 129, Shift-JIS 128 as signed bytes); 0 elsewhere. */
const EA_CHARSET: Record<Locale, number> = { ko: -127, ja: -128, en: 0, id: 0, es: 0 }

/** Where the first line's baseline sits in a PowerPoint text box with exact line spacing, as a share of the line
 * pitch (measured with LibreOffice and Quick Look; PowerPoint places it the same way within a pixel or two). */
export const PPT_BASELINE = 0.8

function color(hex: string): string {
  const v = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex)
  if (!v) return '<a:srgbClr val="000000"><a:alpha val="0"/></a:srgbClr>'
  const a = v[2] ? Math.round((Number.parseInt(v[2], 16) / 255) * 100000) : 100000
  return `<a:srgbClr val="${v[1]!.toUpperCase()}">${a < 100000 ? `<a:alpha val="${a}"/>` : ''}</a:srgbClr>`
}
function fill(f: Fill): string {
  if ('solid' in f) return `<a:solidFill>${color(f.solid)}</a:solidFill>`
  const gs = (stops: { at: number; color: string }[]) => `<a:gsLst>${stops.map((s) => `<a:gs pos="${Math.round(s.at * 100000)}">${color(s.color)}</a:gs>`).join('')}</a:gsLst>`
  if ('linear' in f) return `<a:gradFill rotWithShape="1">${gs(f.linear.stops)}<a:lin ang="${(((f.linear.angle - 90) % 360) + 360) % 360 * 60000}" scaled="0"/></a:gradFill>`
  return `<a:gradFill rotWithShape="1">${gs(f.radial.stops)}<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`
}
const xfrm = (px: number, py: number, w: number, h: number) => `<a:xfrm><a:off x="${e(px)}" y="${e(py)}"/><a:ext cx="${Math.max(0, e(w))}" cy="${Math.max(0, e(h))}"/></a:xfrm>`
const geom = (radius: number, w: number, h: number, ellipse = false) => ellipse ? '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
  : radius > 0 ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.min(50000, Math.round((radius / Math.max(1, Math.min(w, h))) * 100000))}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'

/** A run's fonts: Regular and Bold are "Pretendard" (bold by b="1"), ExtraBold its own family. */
function rPr(lang: Locale, size: number, weight: number, tracking: number, c: string, tag = 'a:rPr'): string {
  const face = weight >= 800 ? 'Pretendard ExtraBold' : 'Pretendard'
  const b = weight >= 600 && weight < 800 ? ' b="1"' : ' b="0"'
  const spc = Math.round(tracking * size * 50)
  const ea = EA_CHARSET[lang]
  return `<${tag} lang="${LANG[lang]}" altLang="en-US" sz="${Math.round(size * 50)}"${b}${spc ? ` spc="${spc}"` : ''} dirty="0"><a:solidFill>${color(c)}</a:solidFill><a:latin typeface="${face}" pitchFamily="34" charset="0"/><a:ea typeface="${face}" pitchFamily="34" charset="${ea}"/><a:cs typeface="${face}" pitchFamily="34" charset="0"/></${tag}>`
}

/** text roles that are one line by design */
const SINGLE = new Set(['eyebrow', 'label', 'footer', 'numeral', 'stat', 'offer', 'website', 'company', 'arrow', 'who', 'note'])

interface Ctx { lang: Locale; id: number; rels: { id: string; type: string; target: string }[]; media: (key: string, bytes: Uint8Array, ext: string) => string }

function textBox(c: Ctx, t: TextItem): string {
  const id = ++c.id
  // the box's top so that its first baseline lands where the layout puts it
  const base = t.y + (t.lh - 1.193 * t.size) / 2 + 0.952 * t.size
  const top = base - PPT_BASELINE * t.lh
  const algn = t.align === 'r' ? 'r' : t.align === 'c' ? 'ctr' : 'l'
  const lines = t.lines.map((runs) => runs.map((r) => `<a:r>${rPr(c.lang, r.size ?? t.size, r.weight ?? t.weight, t.tracking, r.color)}<a:t>${x(r.text)}</a:t></a:r>`).join(''))
  const first = t.lines[0]?.[0]
  const br = first ? `<a:br>${rPr(c.lang, t.size, t.weight, t.tracking, first.color)}</a:br>` : '<a:br/>'
  const end = first ? rPr(c.lang, t.size, t.weight, t.tracking, first.color, 'a:endParaRPr') : ''
  // wider than its column by up to 12 %, into the gutter: a viewer without Pretendard (Keynote, Quick Look, Google
  // Slides) sets a wider face, and a line that would not fit there would break inside a Hangul word; the box has no
  // fill, so the extra width shows nowhere (the layout's 10 % slack stays inside the column)
  const room = t.align === 'l' ? SLIDE_W - 40 - (t.x + t.w) : t.align === 'r' ? t.x - 40 : Math.min(t.x - 40, SLIDE_W - 40 - (t.x + t.w)) * 2
  const grow = Math.max(4, Math.min(t.w * 0.12, room))
  const w = t.w + grow
  const left = t.align === 'r' ? t.x - grow : t.align === 'c' ? t.x - grow / 2 : t.x
  // one-line labels (eyebrows, numbers, page numbers, the offer) never wrap, whatever font the viewer sets them in;
  // paragraphs wrap in their column when someone edits them
  const wrap = t.lines.length === 1 && SINGLE.has(t.role) ? 'none' : 'square'
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(left, top, w, t.lh * t.lines.length + 8)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="${wrap}" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr algn="${algn}" eaLnBrk="0" latinLnBrk="0"><a:lnSpc><a:spcPts val="${Math.round(t.lh * 50)}"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr>`
    + lines.join(br) + end + '</a:p></p:txBody></p:sp>'
}

function item(c: Ctx, it: Item, read: (src: string) => Uint8Array | null): string {
  if (it.t === 'text') return textBox(c, it)
  if (it.t === 'rect' && !('solid' in it.fill)) {
    // a gradient (photo scrims, the ink glow) as a picture with alpha: the same in PowerPoint, Keynote and Quick Look
    const f = it.fill
    const dir = 'radial' in f ? 'radial' : ({ 0: 'up', 90: 'right', 180: 'down', 270: 'left' } as Record<number, 'up' | 'right' | 'down' | 'left'>)[((f.linear.angle % 360) + 360) % 360] ?? 'up'
    const stops = 'radial' in f ? f.radial.stops : f.linear.stops
    const rid = c.media(`gradient|${dir}|${JSON.stringify(stops)}`, gradientPng(stops, dir), 'png')
    const id = ++c.id
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Shade ${id}" descr=""/><p:cNvPicPr><a:picLocks noChangeAspect="0"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(it.x, it.y, it.w, it.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  }
  if (it.t === 'rect') {
    const id = ++c.id
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(it.x, it.y, it.w, it.h)}${geom(it.radius, it.w, it.h, it.ellipse)}${fill(it.fill)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
  }
  if (it.t === 'line') {
    const id = ++c.id
    const x0 = Math.min(it.x1, it.x2), y0 = Math.min(it.y1, it.y2)
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Line ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(x0, y0, Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1))}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${e(it.width)}"><a:solidFill>${color(it.color)}</a:solidFill></a:ln></p:spPr></p:cxnSp>`
  }
  const src = read(it.src)
  if (!src) return ''
  let bytes: Uint8Array = src
  let ext = extOf(src)
  if (!ext) return ''
  if (it.recolor) {
    const p = recolorPng(src, it.recolor)
    if (!p) return ''
    bytes = p
    ext = 'png'
  }
  const rid = c.media(`${it.src}|${it.recolor ?? ''}`, bytes, ext)
  const id = ++c.id
  const n = it.natural
  const pct = (v: number, of: number) => Math.round((v / of) * 100000)
  const src_ = `<a:srcRect l="${pct(it.crop.x, n.width)}" t="${pct(it.crop.y, n.height)}" r="${pct(n.width - it.crop.x - it.crop.w, n.width)}" b="${pct(n.height - it.crop.y - it.crop.h, n.height)}"/>`
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr=""/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/>${src_}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(it.x, it.y, it.w, it.h)}${geom(it.radius, it.w, it.h)}</p:spPr></p:pic>`
}

/** png, jpeg, gif or webp by the bytes */
export function extOf(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif'
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

/** Malgun Gothic, the Hangul fallback PowerPoint for Windows uses when Pretendard is missing */
const MALGUN = '\uB9D1\uC740 \uACE0\uB515'
const THEME = (name: string) => `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${x(name)}"><a:themeElements><a:clrScheme name="Deck"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="141414"/></a:dk2><a:lt2><a:srgbClr val="F7F6F2"/></a:lt2><a:accent1><a:srgbClr val="2B2B2B"/></a:accent1><a:accent2><a:srgbClr val="555555"/></a:accent2><a:accent3><a:srgbClr val="8A8A8A"/></a:accent3><a:accent4><a:srgbClr val="B5B5B5"/></a:accent4><a:accent5><a:srgbClr val="DCDAD4"/></a:accent5><a:accent6><a:srgbClr val="EFEEEA"/></a:accent6><a:hlink><a:srgbClr val="2B2B2B"/></a:hlink><a:folHlink><a:srgbClr val="555555"/></a:folHlink></a:clrScheme>`
  + `<a:fontScheme name="Pretendard"><a:majorFont><a:latin typeface="Pretendard"/><a:ea typeface="Pretendard"/><a:cs typeface=""/><a:font script="Hang" typeface="${MALGUN}"/><a:font script="Jpan" typeface="Yu Gothic"/></a:majorFont><a:minorFont><a:latin typeface="Pretendard"/><a:ea typeface="Pretendard"/><a:cs typeface=""/><a:font script="Hang" typeface="${MALGUN}"/><a:font script="Jpan" typeface="Yu Gothic"/></a:minorFont></a:fontScheme>`
  + '<a:fmtScheme name="Deck"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'

const SP_TREE_START = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
const LVL1 = (sz: number) => `<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="0" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="${sz}" kern="0"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>`
const CLRMAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

export interface PptxOptions {
  title: string
  lang: Locale
  /** a picture's bytes by its team path (null: not readable now; the layout made that slide type-only already) */
  read: (src: string) => Uint8Array | null
  /** the folder of the static Pretendard TTFs (null: none here) */
  fonts: string | null
  embed?: boolean
  /** the document's date (the deck's own), so the same deck gives the same bytes every time */
  created?: string
}

export function buildPptx(deck: DeckOut, o: PptxOptions): Uint8Array {
  const files: ZipEntry[] = []
  const put = (name: string, s: string) => files.push({ name, data: Buffer.from(s, 'utf8') })
  const media = new Map<string, string>()
  const mediaFiles: { name: string; bytes: Uint8Array }[] = []
  const exts = new Set<string>()
  const N = deck.slides.length

  deck.slides.forEach((s: SlideOut, i) => {
    const rels: Ctx['rels'] = [{ id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: `${REL}/notesSlide`, target: `../notesSlides/notesSlide${i + 1}.xml` }]
    const local = new Map<string, string>()
    const c: Ctx = {
      lang: o.lang, id: 1, rels,
      media: (key, bytes, ext) => {
        let name = media.get(key)
        if (!name) { name = `image${media.size + 1}.${ext}`; media.set(key, name); mediaFiles.push({ name, bytes }); exts.add(ext) }
        let rid = local.get(name)
        if (!rid) { rid = `rId${rels.length + 1}`; rels.push({ id: rid, type: `${REL}/image`, target: `../media/${name}` }); local.set(name, rid) }
        return rid
      },
    }
    const shapes = s.items.map((it) => item(c, it, o.read)).join('')
    put(`ppt/slides/slide${i + 1}.xml`, `${XML}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill>${color(s.ground)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>${SP_TREE_START}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
    put(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`)
    const notes = s.notes.length ? s.notes : ['']
    const paras = notes.map((l) => `<a:p><a:r><a:rPr lang="${LANG[o.lang]}" altLang="en-US" dirty="0"/><a:t>${x(l)}</a:t></a:r></a:p>`).join('')
    put(`ppt/notesSlides/notesSlide${i + 1}.xml`, `${XML}<p:notes ${NS}><p:cSld>${SP_TREE_START}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`)
    put(`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${i + 1}.xml"/></Relationships>`)
  })

  // the fonts: Regular and Bold of "Pretendard", Regular of "Pretendard ExtraBold"
  const fonts: { face: string; regular: string; bold?: string; panose: string }[] = []
  const fontFiles: { name: string; bytes: Uint8Array }[] = []
  if ((o.embed ?? EMBED_FONTS) && o.fonts) {
    try {
      const read = (f: string) => new Uint8Array(fs.readFileSync(path.join(o.fonts!, f)))
      const reg = read(PRETENDARD_FILES.regular), bold = read(PRETENDARD_FILES.bold), xb = read(PRETENDARD_FILES.extrabold)
      fontFiles.push({ name: 'font1.fntdata', bytes: eotOf(reg) }, { name: 'font2.fntdata', bytes: eotOf(bold) }, { name: 'font3.fntdata', bytes: eotOf(xb) })
      fonts.push({ face: 'Pretendard', regular: 'font1.fntdata', bold: 'font2.fntdata', panose: panoseHex(reg) }, { face: 'Pretendard ExtraBold', regular: 'font3.fntdata', panose: panoseHex(xb) })
    } catch { fontFiles.length = 0; fonts.length = 0 }
  }

  const presRels: { id: string; type: string; target: string }[] = [
    { id: 'rId1', type: `${REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: `${REL}/notesMaster`, target: 'notesMasters/notesMaster1.xml' },
    { id: 'rId3', type: `${REL}/theme`, target: 'theme/theme1.xml' },
    { id: 'rId4', type: `${REL}/presProps`, target: 'presProps.xml' },
    { id: 'rId5', type: `${REL}/viewProps`, target: 'viewProps.xml' },
    { id: 'rId6', type: `${REL}/tableStyles`, target: 'tableStyles.xml' },
  ]
  const slideRid = (i: number) => `rId${10 + i}`
  deck.slides.forEach((_, i) => presRels.push({ id: slideRid(i), type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` }))
  const fontRid = new Map<string, string>()
  fontFiles.forEach((f, i) => { const id = `rId${100 + i}`; fontRid.set(f.name, id); presRels.push({ id, type: `${REL}/font`, target: `fonts/${f.name}` }) })
  const embedded = fonts.length ? `<p:embeddedFontLst>${fonts.map((f) => `<p:embeddedFont><p:font typeface="${x(f.face)}" panose="${f.panose}" pitchFamily="34" charset="0"/><p:regular r:id="${fontRid.get(f.regular)}"/>${f.bold ? `<p:bold r:id="${fontRid.get(f.bold)}"/>` : ''}</p:embeddedFont>`).join('')}</p:embeddedFontLst>` : ''
  put('ppt/presentation.xml', `${XML}<p:presentation ${NS}${fonts.length ? ' embedTrueTypeFonts="1"' : ''} saveSubsetFonts="0" autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="${slideRid(i)}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>${embedded}<p:defaultTextStyle>${LVL1(1800)}</p:defaultTextStyle></p:presentation>`)
  put('ppt/_rels/presentation.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`)
  put('ppt/presProps.xml', `${XML}<p:presentationPr ${NS}/>`)
  put('ppt/viewProps.xml', `${XML}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`)
  put('ppt/tableStyles.xml', `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)
  put('ppt/theme/theme1.xml', THEME('Deck'))
  put('ppt/theme/theme2.xml', THEME('Notes'))
  put('ppt/slideMasters/slideMaster1.xml', `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${SP_TREE_START}</p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${LVL1(4400)}</p:titleStyle><p:bodyStyle>${LVL1(2000)}</p:bodyStyle><p:otherStyle>${LVL1(1800)}</p:otherStyle></p:txStyles></p:sldMaster>`)
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`)
  put('ppt/slideLayouts/slideLayout1.xml', `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${SP_TREE_START}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`)
  put('ppt/notesMasters/notesMaster1.xml', `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${SP_TREE_START}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="${LANG[o.lang]}"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:notesStyle>${LVL1(1200)}</p:notesStyle></p:notesMaster>`)
  put('ppt/notesMasters/_rels/notesMaster1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/></Relationships>`)
  for (const m of mediaFiles) files.push({ name: `ppt/media/${m.name}`, data: m.bytes, store: m.name.endsWith('.jpeg') })
  for (const f of fontFiles) files.push({ name: `ppt/fonts/${f.name}`, data: f.bytes })
  const now = (o.created ? new Date(o.created) : new Date(0)).toISOString().replace(/\.\d+Z$/, 'Z')
  put('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(o.title)}</dc:title><dc:language>${LANG[o.lang]}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`)
  put('docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${N}</Slides><Notes>${N}</Notes></Properties>`)
  put('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  const ct = 'application/vnd.openxmlformats-officedocument.presentationml'
  const types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + [...exts].map((ex) => `<Default Extension="${ex}" ContentType="image/${ex}"/>`).join('')
    + (fontFiles.length ? '<Default Extension="fntdata" ContentType="application/x-fontdata"/>' : '')
    + `<Override PartName="/ppt/presentation.xml" ContentType="${ct}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${ct}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${ct}.slideLayout+xml"/><Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${ct}.notesMaster+xml"/>`
    + `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="${ct}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${ct}.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="${ct}.tableStyles+xml"/>`
    + deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${ct}.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="${ct}.notesSlide+xml"/>`).join('')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'
  return writeZip([{ name: '[Content_Types].xml', data: Buffer.from(types, 'utf8') }, ...files])
}
