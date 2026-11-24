// edit_office for a .pptx (office-edit.ts holds what the three editors share). Slides are numbered in show order (the
// presentation's slide list, as read shows them); every change names the slides as the AI read them:
// - { find, replace, slide? }: exact text inside one paragraph of a shape (a title, a text box, a table cell, a shape in
//   a group); the new text takes the formatting of the first run it touches.
// - { shape_text: { slide, shape, text } }: the whole text of one shape, by "title", "subtitle", "body", its name, or
//   its number among the slide's text shapes; each line is a paragraph in the look of the shape's first paragraph.
// - { duplicate_slide: { slide, after? } }: a copy of the slide (same layout, same pictures; no speaker notes or
//   comments), placed after the slide (or after slide `after`, 0 = first).
// - { add_slide: { layout, after?, title?, body? } }: a new slide from one of the deck's layouts, by name.
// - { replace_picture: { slide, picture, image } }: the picture (by name or its number on the slide) shows a new image
//   (PNG, JPEG or GIF), fitted into the old picture's frame; the old image part stays for other slides that use it.
// - { insert_picture: { image, slide, x_mm?, y_mm?, center?, width_mm?, height_mm? } }: a new picture on the slide (no
//   position: centred). { move_picture: { slide, picture, x_mm?, y_mm?, center?, width_mm?, height_mm? } }: moves or
//   resizes a picture of the slide as read, in slide millimetres also when it is inside a group.
// Kept: masters, layouts, themes, notes, animations, transitions, charts and every other slide byte for byte.
import {
  addRel, applySplices, attrOf, ensureContentType, escAttr, escText, find, findAll, kid, kidsNamed, mainPart, matchesOf, paragraphs, pick,
  readRels, refuse, relId, relIdPrefix, registerEditor, registerLister, slice, textSplices, withAttr, without, xmlTree, A,
  type EditNote, type Para, type Pkg, type Splice, type XNode,
} from './office-edit'
import type { PlacedPicture } from './office-edit-check'
import { emuToMm, fitPicture, freePictureName, mmToEmu, NS_A, NS_R, pickPicture, pictureList, shapeIds, shapeNames } from './office-picture'

export type PptxChange =
  | { find: string; replace: string; slide?: number; occurrence?: number; all?: boolean }
  | { shape_text: { slide: number; shape: string | number; text: string } }
  | { duplicate_slide: { slide: number; after?: number } }
  | { add_slide: { layout: string; after?: number; title?: string; body?: string } }
  | { replace_picture: { slide: number; picture: string | number; image: number } }
  | { insert_picture: { slide: number; image: number; x_mm?: number; y_mm?: number; center?: boolean; width_mm?: number; height_mm?: number } }
  | { move_picture: { slide: number; picture: string | number; x_mm?: number; y_mm?: number; center?: boolean; width_mm?: number; height_mm?: number } }

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const SLIDE_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
/** relationships a copied slide cannot share with the original (PowerPoint keeps one owner per chart, diagram, object) */
const NOT_COPIED = new Set(['chart', 'chartUsage', 'diagramData', 'diagramLayout', 'diagramQuickStyle', 'diagramColors', 'diagramDrawing', 'oleObject', 'package', 'control', 'activeXControlBinary', 'audio', 'video', 'media'])
const DROPPED = new Set(['notesSlide', 'comments', 'commentAuthors'])

interface Slide { n: number; part: string; sldId: XNode }

function slidesOf(pkg: Pkg, pres: string, tree: XNode): Slide[] {
  const rels = readRels(pkg, pres)?.rels ?? []
  const list = find(tree, 'p:sldIdLst')
  return (list ? kidsNamed(list, 'p:sldId') : []).map((node, i) => {
    const rid = relId(node.head)
    const rel = rels.find((r) => r.id === rid && r.type === 'slide')
    return { n: i + 1, part: rel?.target ?? '', sldId: node }
  }).filter((s) => s.part && pkg.has(s.part))
}

/** The shapes of a slide in reading order (groups opened), each with its name, placeholder type and text body. */
interface Shape { node: XNode; name: string; ph: string | null; body: XNode | null }
function shapesOf(tree: XNode): Shape[] {
  const tree0 = find(tree, 'p:spTree')
  if (!tree0) return []
  return findAll(tree0, 'p:sp', true).map((node) => {
    const nv = kid(node, 'p:nvSpPr')
    const c = nv ? kid(nv, 'p:cNvPr') : null
    const nvPr = nv ? kid(nv, 'p:nvPr') : null
    const ph = nvPr ? kid(nvPr, 'p:ph') : null
    return { node, name: c ? attrOf(c.head, 'name') ?? '' : '', ph: ph ? attrOf(ph.head, 'type') ?? 'body' : null, body: kid(node, 'p:txBody') }
  })
}
const PH_WORDS: Record<string, string[]> = { title: ['title', 'ctrTitle'], subtitle: ['subTitle'], body: ['body', 'obj'] }
function pickShape(shapes: Shape[], sel: string | number, where: string): Shape {
  const texts = shapes.filter((s) => s.body)
  const list = () => texts.map((s, i) => `${i + 1} ${JSON.stringify(s.name)}${s.ph ? ` (${s.ph === 'ctrTitle' ? 'title' : s.ph === 'subTitle' ? 'subtitle' : s.ph})` : ''}`).join(', ')
  if (typeof sel === 'number') return texts[sel - 1] ?? refuse(`${where}: there is no text shape ${sel} on the slide (its text shapes: ${list() || 'none'})`)
  const want = sel.trim().toLowerCase()
  const byPh = PH_WORDS[want]
  const hits = byPh ? texts.filter((s) => s.ph && byPh.includes(s.ph)) : texts.filter((s) => s.name.toLowerCase() === want)
  if (!hits.length) return refuse(`${where}: no shape ${JSON.stringify(sel)} on the slide (its text shapes: ${list() || 'none'}); give "title", "subtitle", "body", a name or a number`)
  if (hits.length > 1 && !byPh) refuse(`${where}: ${hits.length} shapes are named ${JSON.stringify(sel)}; give the shape's number (${list()})`)
  return hits[0]!
}

/** one run's text element; a new line is refused (PowerPoint keeps a line break outside runs) */
function aText(head: string, text: string, where: string): string {
  if (/[\n\r]/.test(text)) refuse(`${where}: a slide's text cannot get a line break from find and replace; set the shape's whole text with shape_text, one line per paragraph`)
  return `<a:t${head}>${escText(text)}</a:t>`
}

/** image size from its header (PNG, JPEG, GIF), for fitting it into the old frame */
export function imageInfo(b: Uint8Array): { ext: 'png' | 'jpeg' | 'gif'; type: string; w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length > 24 && v.getUint32(0) === 0x89504e47 && v.getUint32(12) === 0x49484452) return { ext: 'png', type: 'image/png', w: v.getUint32(16), h: v.getUint32(20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { ext: 'gif', type: 'image/gif', w: v.getUint16(6, true), h: v.getUint16(8, true) }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return null
      const m = b[p + 1]!
      const len = v.getUint16(p + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ext: 'jpeg', type: 'image/jpeg', w: v.getUint16(p + 7), h: v.getUint16(p + 5) }
      p += 2 + len
    }
  }
  return null
}

export function editPptx(pkg: Pkg, changes: unknown[], images: Uint8Array[]): { notes: EditNote[]; placed: PlacedPicture[] } {
  const pres = mainPart(pkg, 'ppt/presentation.xml')
  const presXml = pkg.need(pres)
  const presTree = xmlTree(presXml, pres)
  const slides = slidesOf(pkg, pres, presTree)
  if (!slides.length) refuse('this deck has no slides')
  const xmls = new Map(slides.map((s) => [s.part, pkg.need(s.part)]))
  const trees = new Map(slides.map((s) => [s.part, xmlTree(xmls.get(s.part)!, s.part)]))
  const paras = new Map(slides.map((s) => [s.part, paragraphs(xmls.get(s.part)!, trees.get(s.part)!, s.part, A)]))
  const splices = new Map<string, Splice[]>(slides.map((s) => [s.part, []]))
  const presSplices: Splice[] = []
  const notes: EditNote[] = []
  const textEdits = new Map<Para, { at: number; len: number; text: string; change: number }[]>()
  const slideNo = new Map(slides.map((s) => [s.part, s.n]))
  const slide = (i: number, n: unknown): Slide => slides[Number(n) - 1] ?? refuse(`change ${i + 1}: there is no slide ${n} (the deck has ${slides.length})`)
  const sldList = find(presTree, 'p:sldIdLst')!
  let nextId = Math.max(255, ...slides.map((s) => Number(attrOf(s.sldId.head, 'id')) || 0)) + 1
  /** where a new slide's entry goes in the slide list: after slide `after` (0: first) */
  const insertAt = (i: number, after: number) => {
    if (!Number.isInteger(after) || after < 0 || after > slides.length) refuse(`change ${i + 1}: after is 0 (first) to ${slides.length}`)
    return after === 0 ? slides[0]!.sldId.start : slides[after - 1]!.sldId.end
  }
  // pictures added by this call: one image part per image, one relationship per slide and image, new shape ids
  const sz = find(presTree, 'p:sldSz')
  const slideW = Number(attrOf(sz?.head ?? '', 'cx')) || 12_192_000, slideH = Number(attrOf(sz?.head ?? '', 'cy')) || 6_858_000
  const mediaOf = new Map<number, { media: string; ext: string; type: string; w: number; h: number }>()
  const ridOf = new Map<string, string>()
  const placed: PlacedPicture[] = []
  const idsOn = new Map<string, { next: number; names: Set<string> }>()
  const picName = (p: XNode) => { const c2 = find(p, 'p:cNvPr'); return c2 ? attrOf(c2.head, 'name') ?? '' : '' }
  const picsOn = (s: Slide) => findAll(find(trees.get(s.part)!, 'p:spTree')!, 'p:pic', true)
  const placedText = (n: number, name: string, x: number, y: number, b: { cx: number; cy: number }) =>
    `slide ${n}, picture ${JSON.stringify(name)} at ${emuToMm(x)}, ${emuToMm(y)} mm, ${emuToMm(b.cx)} x ${emuToMm(b.cy)} mm (the slide is ${emuToMm(slideW)} x ${emuToMm(slideH)} mm)`
  const insertPicture = (i: number, x: Extract<PptxChange, { insert_picture: unknown }>['insert_picture']) => {
    const s = slide(i, x.slide), xml = xmls.get(s.part)!
    const img = images[Number(x.image)] ?? refuse(`change ${i + 1}: the image could not be read`)
    let m = mediaOf.get(Number(x.image))
    if (!m) {
      const info = imageInfo(img) ?? refuse(`change ${i + 1}: the new image is not a PNG, JPEG or GIF`)
      if (!info.w || !info.h) refuse(`change ${i + 1}: the new image has no size`)
      const media = pkg.free('ppt/media/image', `.${info.ext}`, 1)
      pkg.add(media, img)
      ensureContentType(pkg, { ext: info.ext, type: info.type })
      m = { media, ...info }
      mediaOf.set(Number(x.image), m)
    }
    const key = `${s.part}|${x.image}`
    const rid = ridOf.get(key) ?? addRel(pkg, s.part, `${REL}/image`, `../media/${m.media.split('/').pop()}`)
    ridOf.set(key, rid)
    let ids = idsOn.get(s.part)
    if (!ids) { ids = { next: Math.max(1, ...shapeIds(xml)) + 1, names: shapeNames(xml) }; idsOn.set(s.part, ids) }
    const id = ids.next++, name = freePictureName(ids.names, id)
    const box = fitPicture(m.w, m.h, x.width_mm, x.height_mm)
    const ox = x.x_mm !== undefined && !x.center ? mmToEmu(x.x_mm) : Math.round((slideW - box.cx) / 2)
    const oy = x.y_mm !== undefined && !x.center ? mmToEmu(x.y_mm) : Math.round((slideH - box.cy) / 2)
    const tree = find(trees.get(s.part)!, 'p:spTree')!, at = kid(tree, 'p:extLst')?.start ?? tree.closeStart
    splices.get(s.part)!.push({ from: at, to: at, change: i, text: `<p:pic xmlns:a="${NS_A}" xmlns:r="${NS_R}"><p:nvPicPr><p:cNvPr id="${id}" name="${name}" descr=""/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${ox}" y="${oy}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` })
    placed.push({ part: s.part, id, rid })
    notes.push({ change: i, where: `new ${placedText(s.n, name, ox, oy, box)}` })
  }
  const movePicture = (i: number, x: Extract<PptxChange, { move_picture: unknown }>['move_picture']) => {
    const s = slide(i, x.slide), pics = picsOn(s)
    const pic = pickPicture(pics, picName, x.picture) ?? refuse(`change ${i + 1}: no picture ${JSON.stringify(x.picture)} on slide ${s.n} (its pictures: ${pictureList(pics, picName)})`)
    const spPr = kid(pic, 'p:spPr') ?? refuse(`change ${i + 1}: that picture has no frame to move`)
    const xfrm = kid(spPr, 'a:xfrm'), off = xfrm ? kid(xfrm, 'a:off') : null, ext = xfrm ? kid(xfrm, 'a:ext') : null
    // a picture in a group: its numbers are in the group's space; slide = t + k * own
    let tx = 0, ty = 0, kx = 1, ky = 1
    for (let g = pic.parent; g; g = g.parent) {
      if (g.name !== 'p:grpSp') continue
      const f = kid(kid(g, 'p:grpSpPr') ?? g, 'a:xfrm')
      const n = (el: string, a: string) => { const e = f ? kid(f, el) : null; return e ? Number(attrOf(e.head, a)) || 0 : 0 }
      const sx = n('a:chExt', 'cx') ? n('a:ext', 'cx') / n('a:chExt', 'cx') : 1, sy = n('a:chExt', 'cy') ? n('a:ext', 'cy') / n('a:chExt', 'cy') : 1
      tx = n('a:off', 'x') + (tx - n('a:chOff', 'x')) * sx; ty = n('a:off', 'y') + (ty - n('a:chOff', 'y')) * sy
      kx *= sx; ky *= sy
    }
    const own = off && ext ? { x: Number(attrOf(off.head, 'x')), y: Number(attrOf(off.head, 'y')), cx: Number(attrOf(ext.head, 'cx')), cy: Number(attrOf(ext.head, 'cy')) } : null
    const known = own && [own.x, own.y, own.cx, own.cy].every(Number.isFinite) && own.cx > 0 && own.cy > 0 ? own : null
    const hasPlace = (x.x_mm !== undefined && x.y_mm !== undefined) || x.center
    if (!known && (!hasPlace || x.width_mm === undefined || x.height_mm === undefined)) refuse(`change ${i + 1}: that picture takes its place from the slide layout; give x_mm, y_mm, width_mm and height_mm`)
    const cur = known ? { cx: Math.round(known.cx * kx), cy: Math.round(known.cy * ky) } : { cx: mmToEmu(x.width_mm!), cy: mmToEmu(x.height_mm!) }
    const box = fitPicture(cur.cx, cur.cy, x.width_mm, x.height_mm, cur)
    const wx = x.center ? Math.round((slideW - box.cx) / 2) : x.x_mm !== undefined ? mmToEmu(x.x_mm) : Math.round(tx + known!.x * kx)
    const wy = x.center ? Math.round((slideH - box.cy) / 2) : x.y_mm !== undefined ? mmToEmu(x.y_mm) : Math.round(ty + known!.y * ky)
    const lx = Math.round((wx - tx) / kx), ly = Math.round((wy - ty) / ky), lw = Math.max(1, Math.round(box.cx / kx)), lh = Math.max(1, Math.round(box.cy / ky))
    if (![lx, ly, lw, lh].every(Number.isFinite)) refuse(`change ${i + 1}: this picture cannot be moved (its group has no size)`)
    const sp = splices.get(s.part)!
    if (off && ext) {
      sp.push({ from: off.start, to: off.end, change: i, text: `<a:off${withAttr(withAttr(off.head.replace(/\/$/, ''), 'x', String(lx)), 'y', String(ly))}/>` })
      sp.push({ from: ext.start, to: ext.end, change: i, text: `<a:ext${withAttr(withAttr(ext.head.replace(/\/$/, ''), 'cx', String(lw)), 'cy', String(lh))}/>` })
    } else {
      const frame = `<a:xfrm xmlns:a="${NS_A}"><a:off x="${lx}" y="${ly}"/><a:ext cx="${lw}" cy="${lh}"/></a:xfrm>`
      if (xfrm) sp.push({ from: xfrm.start, to: xfrm.end, change: i, text: frame })
      else if (spPr.self) sp.push({ from: spPr.start, to: spPr.end, change: i, text: `<p:spPr${spPr.head.replace(/\/$/, '')}>${frame}</p:spPr>` })
      else sp.push({ from: spPr.openEnd, to: spPr.openEnd, change: i, text: frame })
    }
    notes.push({ change: i, where: `moved ${placedText(s.n, picName(pic), wx, wy, box)}` })
  }
  const rIdAttr = relIdPrefix(slides[0]!.sldId.head)
  const newSlideEntry = (i: number, part: string, after: number, what: string) => {
    if (nextId >= 2147483648) refuse(`change ${i + 1}: the deck's slide numbers are used up`)
    const rid = addRel(pkg, pres, `${REL}/slide`, part.slice(pres.lastIndexOf('/') + 1))
    ensureContentType(pkg, { part, type: SLIDE_TYPE })
    const at = insertAt(i, after)
    presSplices.push({ from: at, to: at, text: `<p:sldId id="${nextId++}" ${rIdAttr}:id="${rid}"/>`, change: i })
    notes.push({ change: i, where: `${what}, placed ${after === 0 ? 'first' : `after slide ${after}`}` })
  }
  const newSlidePart = () => pkg.free('ppt/slides/slide', '.xml', slides.length + 1)

  changes.forEach((raw, i) => {
    const c = raw as Record<string, any>
    if (typeof c.find === 'string') {
      if (!c.find) refuse(`change ${i + 1}: find is empty`)
      if (typeof c.replace !== 'string') refuse(`change ${i + 1}: give replace`)
      const where = c.slide !== undefined ? [slide(i, c.slide)] : slides
      const hits = matchesOf(where.flatMap((s) => paras.get(s.part)!), c.find)
      for (const m of pick(hits, c, i, c.slide !== undefined ? ` on slide ${c.slide}` : '', c.find)) {
        const list = textEdits.get(m.para) ?? []
        list.push({ at: m.at, len: c.find.length, text: c.replace, change: i })
        textEdits.set(m.para, list)
      }
      return
    }
    if (c.shape_text) {
      const s = slide(i, c.shape_text.slide)
      const xml = xmls.get(s.part)!
      const sh = pickShape(shapesOf(trees.get(s.part)!), c.shape_text.shape, `change ${i + 1}`)
      const body = sh.body!
      const ps = kidsNamed(body, 'a:p')
      const first = ps[0]
      const pPr = first ? kid(first, 'a:pPr') : null
      const run = first ? findAll(first, 'a:r').find((r) => kid(r, 'a:rPr')) : undefined
      const rPrNode = run ? kid(run, 'a:rPr') : null
      const end = first ? kid(first, 'a:endParaRPr') : null
      // no run to copy: the look the empty paragraph's end mark has
      const rPr = rPrNode ? slice(xml, rPrNode) : end ? slice(xml, end).replace(/^<a:endParaRPr\b/, '<a:rPr').replace(/<\/a:endParaRPr>$/, '</a:rPr>') : ''
      const lines = String(c.shape_text.text).split(/\r?\n/)
      const keep = body.kids.filter((k) => k.name !== 'a:p').map((k) => slice(xml, k)).join('')
      const ptxt = lines.map((l) => `<a:p>${pPr ? slice(xml, pPr) : ''}${l ? `<a:r>${rPr}<a:t>${escText(l)}</a:t></a:r>` : ''}${end ? slice(xml, end) : ''}</a:p>`).join('')
      splices.get(s.part)!.push({ from: body.start, to: body.end, text: `<p:txBody${body.head}>${keep}${ptxt}</p:txBody>`, change: i })
      const old = paras.get(s.part)!.filter((p) => p.node.parent === body)
      notes.push({ change: i, where: `slide ${s.n}, ${JSON.stringify(sh.name)}`, before: old[0]?.text ?? '', after: lines })
      for (const p of old.slice(1)) notes.push({ change: i, where: `slide ${s.n}, ${JSON.stringify(sh.name)}`, before: p.text })
      return
    }
    if (c.duplicate_slide) {
      const s = slide(i, c.duplicate_slide.slide)
      const rels = readRels(pkg, s.part)
      const bad = rels?.rels.find((r) => NOT_COPIED.has(r.type))
      if (bad) refuse(`change ${i + 1}: slide ${s.n} has a ${bad.type.replace(/([A-Z])/g, ' $1').toLowerCase()} that a copy cannot share; duplicate it in PowerPoint`)
      // a copy never makes a second thing that is fetched from outside the file (a linked picture, an outside object):
      // only plain hyperlinks go along (QA TC-4948)
      const outside = rels?.rels.find((r) => r.external && r.type !== 'hyperlink')
      if (outside) refuse(`change ${i + 1}: slide ${s.n} uses a ${outside.type} from outside the file, which a copy would fetch again; duplicate it in PowerPoint`)
      const part = newSlidePart()
      // the slide as it is, with a new creation id (PowerPoint tells slides apart by it)
      const xml = xmls.get(s.part)!.replace(/(<p14:creationId\b[^>]*\bval=")\d+(")/, (_m, a: string, b: string) => `${a}${Math.floor(Math.random() * 4294967295)}${b}`)
      pkg.add(part, new TextEncoder().encode(xml))
      if (rels) {
        const cuts = rels.rels.filter((r) => DROPPED.has(r.type)).map((r) => ({ from: r.node.start, to: r.node.end, text: '', change: i }))
        // the copy's relationships point where the original's do (relative targets from the same folder)
        pkg.add(part.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels', new TextEncoder().encode(applySplices(rels.xml, cuts, `${s.part}.rels`)))
      }
      newSlideEntry(i, part, c.duplicate_slide.after ?? s.n, `slide ${s.n} copied`)
      notes[notes.length - 1]!.after = paras.get(s.part)!.map((p) => p.text)
      return
    }
    if (c.add_slide) {
      const x = c.add_slide
      const layouts = pkg.names().filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).map((n) => {
        const t = xmlTree(pkg.need(n), n)
        const cs = find(t, 'p:cSld')
        return { part: n, name: cs ? attrOf(cs.head, 'name') ?? '' : '', tree: t, xml: pkg.need(n) }
      })
      const want = String(x.layout).trim().toLowerCase()
      const lay = layouts.find((l) => l.name.toLowerCase() === want) ?? refuse(`change ${i + 1}: the deck has no layout ${JSON.stringify(x.layout)} (its layouts: ${layouts.map((l) => JSON.stringify(l.name)).join(', ')})`)
      const shapes = shapesOf(lay.tree).filter((s) => s.ph && !['dt', 'ftr', 'sldNum', 'hdr'].includes(s.ph))
      let id = 2
      const fill = { title: x.title as string | undefined, body: x.body as string | undefined }
      const used = { title: false, body: false }
      const made: string[] = []
      const sps = shapes.map((s) => {
        const ph = kid(kid(kid(s.node, 'p:nvSpPr')!, 'p:nvPr')!, 'p:ph')!
        const type = attrOf(ph.head, 'type'), idx = attrOf(ph.head, 'idx')
        const kind = s.ph === 'title' || s.ph === 'ctrTitle' ? 'title' : s.ph === 'body' || s.ph === 'obj' || s.ph === 'subTitle' ? 'body' : null
        const text = kind && !used[kind] ? fill[kind] : undefined
        if (kind && text !== undefined) used[kind] = true
        made.push(...(text ?? '').split(/\r?\n/))
        const ps = (text ?? '').split(/\r?\n/).map((l) => `<a:p>${l ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escText(l)}</a:t></a:r>` : '<a:endParaRPr lang="en-US" dirty="0"/>'}</a:p>`).join('')
        return `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="${escAttr(s.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${type ? ` type="${escAttr(type)}"` : ''}${idx ? ` idx="${escAttr(idx)}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody></p:sp>`
      })
      if (fill.title !== undefined && !used.title) refuse(`change ${i + 1}: the layout ${JSON.stringify(lay.name)} has no title; give another layout or no title`)
      if (fill.body !== undefined && !used.body) refuse(`change ${i + 1}: the layout ${JSON.stringify(lay.name)} has no text area; give another layout or no body`)
      const part = newSlidePart()
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sps.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
      pkg.add(part, new TextEncoder().encode(xml))
      const relsName = part.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels'
      pkg.add(relsName, new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/${lay.part.split('/').pop()}"/></Relationships>`))
      newSlideEntry(i, part, x.after ?? slides.length, `new slide (layout ${JSON.stringify(lay.name)})`)
      notes[notes.length - 1]!.after = made
      return
    }
    if (c.insert_picture) { insertPicture(i, c.insert_picture); return }
    if (c.move_picture) { movePicture(i, c.move_picture); return }
    if (c.replace_picture) {
      const x = c.replace_picture
      const s = slide(i, x.slide)
      const xml = xmls.get(s.part)!
      const pics = findAll(find(trees.get(s.part)!, 'p:spTree')!, 'p:pic', true)
      const nameOf = (p: XNode) => { const c2 = find(p, 'p:cNvPr'); return c2 ? attrOf(c2.head, 'name') ?? '' : '' }
      const list = () => pics.map((p, k) => `${k + 1} ${JSON.stringify(nameOf(p))}`).join(', ') || 'none'
      const pic = typeof x.picture === 'number' ? pics[x.picture - 1] : pics.find((p) => nameOf(p).toLowerCase() === String(x.picture).trim().toLowerCase())
      if (!pic) return refuse(`change ${i + 1}: no picture ${JSON.stringify(x.picture)} on slide ${s.n} (its pictures: ${list()})`)
      const blip = find(pic, 'a:blip') ?? refuse(`change ${i + 1}: that picture has no image to replace`)
      if (attrOf(blip.head, 'r:link') !== undefined) refuse(`change ${i + 1}: that picture is linked to a file outside the deck, which is not changed here`)
      const img = images[Number(x.image)] ?? refuse(`change ${i + 1}: the image could not be read`)
      const info = imageInfo(img) ?? refuse(`change ${i + 1}: the new image is not a PNG, JPEG or GIF`)
      if (!info.w || !info.h) refuse(`change ${i + 1}: the new image has no size`)
      const media = pkg.free('ppt/media/image', `.${info.ext}`, 1)
      pkg.add(media, img)
      ensureContentType(pkg, { ext: info.ext, type: info.type })
      const rid = addRel(pkg, s.part, `${REL}/image`, `../media/${media.split('/').pop()}`)
      const sp = splices.get(s.part)!
      // the picture's own image (and no crop, SVG copy or effects meant for the old one)
      const blipXml = without(xml, blip, new Set(['a:extLst']))
      sp.push({ from: blip.start, to: blip.end, text: blipXml.replace(/^<a:blip\b[^>]*?(\/?)>/, (_m, self: string) => `<a:blip${withAttr(blip.head, 'r:embed', rid).replace(/\/$/, '')}${self}>`), change: i })
      const fillEl = kid(pic, 'p:blipFill')
      const crop = fillEl ? kid(fillEl, 'a:srcRect') : null
      if (crop) sp.push({ from: crop.start, to: crop.end, text: '', change: i })
      // fitted into the old frame, centred, keeping the new image's shape
      const spPr = kid(pic, 'p:spPr')
      const xfrm = spPr ? kid(spPr, 'a:xfrm') : null
      const off = xfrm ? kid(xfrm, 'a:off') : null, ext = xfrm ? kid(xfrm, 'a:ext') : null
      if (off && ext) {
        const ox = Number(attrOf(off.head, 'x')), oy = Number(attrOf(off.head, 'y')), cx = Number(attrOf(ext.head, 'cx')), cy = Number(attrOf(ext.head, 'cy'))
        if ([ox, oy, cx, cy].every(Number.isFinite) && cx > 0 && cy > 0) {
          const k = Math.min(cx / info.w, cy / info.h)
          const nw = Math.round(info.w * k), nh = Math.round(info.h * k)
          sp.push({ from: off.start, to: off.end, text: `<a:off${withAttr(withAttr(off.head.replace(/\/$/, ''), 'x', String(ox + Math.round((cx - nw) / 2))), 'y', String(oy + Math.round((cy - nh) / 2)))}/>`, change: i })
          sp.push({ from: ext.start, to: ext.end, text: `<a:ext${withAttr(withAttr(ext.head.replace(/\/$/, ''), 'cx', String(nw)), 'cy', String(nh))}/>`, change: i })
        }
      }
      notes.push({ change: i, where: `slide ${s.n}, picture ${JSON.stringify(nameOf(pic))} now shows the new image (${info.w}x${info.h})` })
      return
    }
    refuse(`change ${i + 1} is not a change edit_office makes in a deck (find/replace, shape_text, duplicate_slide, add_slide, replace_picture, insert_picture, move_picture)`)
  })

  for (const [para, edits] of textEdits) {
    const x = xmls.get(para.part)!
    splices.get(para.part)!.push(...textSplices(x, para, edits, (piece, text) => aText(piece.node.head, text, `change ${edits[0]!.change + 1}`)))
    let after = para.text
    for (const e of [...edits].sort((a, b) => b.at - a.at)) after = after.slice(0, e.at) + e.text + after.slice(e.at + e.len)
    // one paragraph, one before and after (the read-back counts them); the other changes in it point at the first
    const w = `slide ${slideNo.get(para.part)}`
    edits.forEach((e, k) => notes.push(k === 0 ? { change: e.change, where: w, before: para.text, after: [after] } : { change: e.change, where: `${w}, the same paragraph as change ${edits[0]!.change + 1}` }))
  }
  for (const [part, list] of splices) if (list.length) pkg.set(part, applySplices(xmls.get(part)!, list, part))
  if (presSplices.length) {
    if (sldList.self) refuse('this deck\'s slide list cannot be changed')
    pkg.set(pres, applySplices(presXml, presSplices, pres))
  }
  notes.sort((a, b) => a.change - b.change)
  return { notes, placed }
}

/** The paragraphs of every slide in show order, as the read-back compares them. */
export function pptxParagraphTexts(pkg: Pkg): string[] {
  const pres = mainPart(pkg, 'ppt/presentation.xml')
  const x = pkg.need(pres)
  return slidesOf(pkg, pres, xmlTree(x, pres)).flatMap((s) => { const sx = pkg.need(s.part); return paragraphs(sx, xmlTree(sx, s.part), s.part, A).map((p) => p.text) })
}

registerEditor('pptx', editPptx)
registerLister('pptx', pptxParagraphTexts)
