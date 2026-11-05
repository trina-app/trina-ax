// Test helpers for make_file's and edit_hwp's .hwpx: template and document files built here (no third-party documents
// in the repo; every name, company and address in them is made up) and a reader of a written file's parts.
import * as XLSX from 'xlsx'
import { charPrXml, defaultHeaderXml, defaultSecPrXml, NS_ATTRS, paraPrXml, XML_DECL } from '../../server/src/files/hwpx-template'
import { writeZip, type ZipEntry } from '../../server/src/files/zip-write'

export const enc = (s: string) => new TextEncoder().encode(s)

/** the parts of a .hwpx (SheetJS reads zips too), as text */
export function hwpxParts(bytes: Uint8Array): Map<string, string> {
  const c = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' })
  const out = new Map<string, string>()
  c.FullPaths.forEach((p: string, i: number) => {
    const content = c.FileIndex[i]?.content
    if (content && content.length) out.set(p.replace(/^Root Entry\//, ''), Buffer.from(content as Uint8Array).toString('utf8'))
  })
  return out
}

/** a template .hwpx: the built-in header (or `head`), a section with page setup `secPr` and a text of its own */
export function hwpxTemplate(o: { head?: string; secPr?: string; extra?: Record<string, Uint8Array | string>; mimetype?: string | null; text?: string } = {}): Uint8Array {
  const sec = XML_DECL + `<hs:sec ${NS_ATTRS}><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${o.secPr ?? defaultSecPrXml()}` +
    `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t>${o.text ?? '템플릿 안내 문구'}</hp:t></hp:run></hp:p></hs:sec>`
  const files: { name: string; data: Uint8Array; store?: boolean }[] = []
  if (o.mimetype !== null) files.push({ name: 'mimetype', data: enc(o.mimetype ?? 'application/hwp+zip'), store: true })
  files.push({ name: 'Contents/header.xml', data: enc(o.head ?? defaultHeaderXml()) }, { name: 'Contents/section0.xml', data: enc(sec) })
  for (const [n, v] of Object.entries(o.extra ?? {})) files.push({ name: n, data: typeof v === 'string' ? enc(v) : v })
  return writeZip(files)
}

// ---------------------------------------------------------------- documents to change (edit_hwp)
/** The shapes the form documents use, added to the built-in header after its own items. */
export const FORM = {
  /** character shapes: 0 body (built-in), 11 body bold, 12 body italic, 13 title (20 pt bold), 14 small (9 pt) */
  bold: 11, italic: 12, title: 13, small: 14,
  /** paragraph shapes: 0 body (built-in), 13 centred, 14 right, 15 cell (no space after) */
  center: 13, right: 14, cellPara: 15,
  /** border fills: 3 thin solid lines, 4 the same, shaded (label cells) */
  line: 3, shaded: 4,
}

/** the built-in header with the form's shapes after its own (ids continue its numbering) */
export function formHeaderXml(): string {
  const solid = (id: number, shade: string | null) => `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    ['left', 'right', 'top', 'bottom'].map((s) => `<hh:${s}Border type="SOLID" width="0.12 mm" color="#000000"/>`).join('') +
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
    (shade ? `<hc:fillBrush><hc:winBrush faceColor="${shade}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '') + '</hh:borderFill>'
  return defaultHeaderXml()
    .replace(/<hh:borderFills itemCnt="2">([\s\S]*?)<\/hh:borderFills>/, (_m, inner) => `<hh:borderFills itemCnt="4">${inner}${solid(3, null)}${solid(4, '#E8E8E8')}</hh:borderFills>`)
    .replace(/<hh:charProperties itemCnt="11">([\s\S]*?)<\/hh:charProperties>/, (_m, inner) => `<hh:charProperties itemCnt="15">${inner}` +
      charPrXml(11, { height: 1000, face: 1, bold: true }) + charPrXml(12, { height: 1000, face: 1, italic: true }) +
      charPrXml(13, { height: 2000, face: 0, bold: true, spacing: 20 }) + charPrXml(14, { height: 900, face: 1 }) + '</hh:charProperties>')
    .replace(/<hh:paraProperties itemCnt="13">([\s\S]*?)<\/hh:paraProperties>/, (_m, inner) => `<hh:paraProperties itemCnt="16">${inner}` +
      paraPrXml(13, { align: 'CENTER', next: 600 }) + paraPrXml(14, { align: 'RIGHT', next: 600 }) + paraPrXml(15, { align: 'CENTER', next: 0 }) + '</hh:paraProperties>')
}

/** a layout cache as Hangul saves one (its numbers are only plausible: tests check that changed paragraphs lose it) */
export const lineseg = (vert: number, width = 42520) =>
  `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${vert}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="${width}" flags="393216"/></hp:linesegarray>`

let pid = 1_000_000
/** runs: [character shape, text] (text escaped here); a string is one run in the body shape */
export function para(runs: string | [number, string][], o: { paraPr?: number; style?: number; cache?: boolean; vert?: number; raw?: string } = {}): string {
  const list = typeof runs === 'string' ? [[0, runs] as [number, string]] : runs
  const body = o.raw ?? list.map(([c, t]) => `<hp:run charPrIDRef="${c}">${t ? `<hp:t>${esc(t)}</hp:t>` : '<hp:t/>'}</hp:run>`).join('')
  return `<hp:p id="${pid++}" paraPrIDRef="${o.paraPr ?? 0}" styleIDRef="${o.style ?? 0}" pageBreak="0" columnBreak="0" merged="0">${body}${o.cache === false ? '' : lineseg(o.vert ?? 1600)}</hp:p>`
}
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface CellSpec { text?: string | [number, string][]; colSpan?: number; rowSpan?: number; width: number; height?: number; shaded?: boolean; raw?: string }
/** a table in its own paragraph, as Hangul writes one; each row's cells left to right (columns counted from spans). By
 * default placed as a character and split by cell at a page boundary, as Hangul writes a new table; `height` sets
 * hp:sz's height (default the rows' heights) */
export function table(rows: CellSpec[][], o: { id?: number; cache?: boolean; zones?: string; treatAsChar?: boolean; pageBreak?: 'CELL' | 'TABLE' | 'NONE'; height?: number } = {}): string {
  const occupied = new Set<string>()
  let width = 0
  const trs = rows.map((cells, r) => {
    let c = 0
    let w = 0
    const tcs = cells.map((cell) => {
      while (occupied.has(`${r}:${c}`)) c++
      const cs = cell.colSpan ?? 1, rs = cell.rowSpan ?? 1
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) occupied.add(`${r + i}:${c + j}`)
      const p = cell.raw ?? para(cell.text ?? '', { paraPr: FORM.cellPara, cache: o.cache, vert: 0, ...(typeof cell.text === 'string' || cell.text === undefined ? {} : {}) })
      const tc = `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${cell.shaded ? FORM.shaded : FORM.line}">` +
        '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
        `${p}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="${rs}"/>` +
        `<hp:cellSz width="${cell.width}" height="${cell.height ?? 2400}"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`
      c += cs
      w += cell.width
      return tc
    })
    width = Math.max(width, w)
    return `<hp:tr>${tcs.join('')}</hp:tr>`
  })
  const cols = Math.max(...[...occupied].map((k) => Number(k.split(':')[1]) + 1))
  const height = o.height ?? rows.reduce((h, cells) => h + Math.max(...cells.map((c) => (c.rowSpan ?? 1) === 1 ? c.height ?? 2400 : 0), 0), 0)
  const tbl = `<hp:tbl id="${o.id ?? 1500000000}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="${o.pageBreak ?? 'CELL'}" repeatHeader="1" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${FORM.line}" noAdjust="0">` +
    `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="${o.treatAsChar === false ? 0 : 1}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    '<hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>' + (o.zones ?? '') + trs.join('') + '</hp:tbl>'
  return para([], { raw: `<hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run>`, cache: o.cache, vert: 4000 })
}

/** a page setup (HWPUNIT; the built-in A4 upright page unless given): hp:pagePr and its hp:margin. Hangul writes
 * landscape="WIDELY" for an upright page and "NARROWLY" for a turned one, keeping the upright paper's width and height */
export interface PageSpec { width?: number; height?: number; left?: number; right?: number; top?: number; bottom?: number; header?: number; footer?: number; landscape?: boolean }
export const pageSecPrXml = (p: PageSpec = {}) => defaultSecPrXml().replace(/<hp:pagePr\b[\s\S]*?<\/hp:pagePr>/,
  `<hp:pagePr landscape="${p.landscape ? 'NARROWLY' : 'WIDELY'}" width="${p.width ?? 59528}" height="${p.height ?? 84186}" gutterType="LEFT_ONLY">` +
  `<hp:margin header="${p.header ?? 4252}" footer="${p.footer ?? 4252}" gutter="0" left="${p.left ?? 8504}" right="${p.right ?? 8504}" top="${p.top ?? 5668}" bottom="${p.bottom ?? 4252}"/></hp:pagePr>`)

/** A .hwpx with Hangul's parts in Hangul's order: `sections` are the paragraphs of each section after the first one
 * (which holds the page setup, `page` or the built-in one). `extra` parts go at the end; `manifest` items are added to
 * content.hpf. */
export function hwpxDoc(sections: string[], o: { head?: string; extra?: Record<string, Uint8Array | string>; manifest?: string; preview?: string; firstPara?: string; page?: PageSpec } = {}): Uint8Array {
  const first = o.firstPara ?? `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${o.page ? pageSecPrXml(o.page) : defaultSecPrXml()}` +
    `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t/></hp:run>${lineseg(0)}</hp:p>`
  const secs = sections.map((s, i) => XML_DECL + `<hs:sec ${NS_ATTRS}>${i === 0 ? first : ''}${s}</hs:sec>`)
  const items = secs.map((_, i) => `<opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>`).join('')
  const hpf = XML_DECL + `<opf:package ${NS_ATTRS} version="" unique-identifier="" id=""><opf:metadata><opf:title>문서</opf:title><opf:language>ko</opf:language></opf:metadata>` +
    `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${items}<opf:item id="settings" href="settings.xml" media-type="application/xml"/>${o.manifest ?? ''}</opf:manifest>` +
    `<opf:spine><opf:itemref idref="header" linear="yes"/>${secs.map((_, i) => `<opf:itemref idref="section${i}" linear="yes"/>`).join('')}</opf:spine></opf:package>`
  const files: ZipEntry[] = [
    { name: 'mimetype', data: enc('application/hwp+zip'), store: true },
    { name: 'version.xml', data: enc(XML_DECL + '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Test" appVersion=""/>') },
    { name: 'Contents/header.xml', data: enc(o.head ?? formHeaderXml()) },
    ...secs.map((s, i) => ({ name: `Contents/section${i}.xml`, data: enc(s) })),
    { name: 'Preview/PrvText.txt', data: enc(o.preview ?? '미리보기') },
    { name: 'settings.xml', data: enc(XML_DECL + '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>') },
    { name: 'META-INF/container.rdf', data: enc(XML_DECL + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>') },
    { name: 'Contents/content.hpf', data: enc(hpf) },
    { name: 'META-INF/container.xml', data: enc(XML_DECL + '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>') },
    { name: 'META-INF/manifest.xml', data: enc(XML_DECL + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>') },
  ]
  for (const [n, v] of Object.entries(o.extra ?? {})) files.push({ name: n, data: typeof v === 'string' ? enc(v) : v })
  return writeZip(files)
}

/** A 1x1 PNG (a picture in BinData) */
export const PNG_1PX = Uint8Array.from(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'))

/** A click-here field (누름틀) around `text`, as Hangul writes one */
export const clickHere = (text: string, name = '입력') =>
  `<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="1801" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="627272811"><hp:parameters cnt="1" name=""><hp:stringParam name="Direction">여기를 누르세요</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>` +
  `<hp:run charPrIDRef="0">${text ? `<hp:t>${esc(text)}</hp:t>` : '<hp:t/>'}</hp:run><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="1801" fieldid="627272811"/></hp:ctrl></hp:run>`

/** A picture paragraph that shows BinData/image1.png (manifest item `image1`) */
export const picture = () => para([], { raw: '<hp:run charPrIDRef="0"><hp:pic id="1600000001" zOrder="1" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="526000001" reverse="0">' +
  '<hp:offset x="0" y="0"/><hp:orgSz width="2000" height="2000"/><hp:curSz width="2000" height="2000"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="1000" centerY="1000" rotateimage="1"/>' +
  '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>' +
  '<hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="2000" y="0"/><hc:pt2 x="2000" y="2000"/><hc:pt3 x="0" y="2000"/></hp:imgRect>' +
  '<hp:imgClip left="0" right="2000" top="0" bottom="2000"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="2000" dimheight="2000"/><hp:effects/>' +
  '<hp:sz width="2000" widthRelTo="ABSOLUTE" height="2000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
  '<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic><hp:t/></hp:run>', vert: 8000 })
export const PICTURE_ITEM = '<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/>'

/**
 * A made-up certificate of employment (재직증명서) of a made-up company, as a Hangul-saved form looks: a title, a
 * table of label cells and empty cells (two merged across columns), placeholders in the body, a paragraph with bold
 * and normal text, a click-here field, a picture (the company seal) and an element no reader here knows.
 */
export function employmentForm(o: { cache?: boolean } = {}): Uint8Array {
  const cache = o.cache
  // the columns fill the A4 text width of the built-in page (59528 - 2 x 8504 HWPUNIT)
  const L = (text: string, width = 8000): CellSpec => ({ text, width, shaded: true })
  const E = (width: number, colSpan = 1): CellSpec => ({ text: '', width, colSpan })
  return hwpxDoc([
    para([[FORM.title, '재 직 증 명 서']], { paraPr: FORM.center, cache, vert: 1600 }) +
    table([
      [L('성명'), E(13260), L('생년월일'), E(13260)],
      [L('주소'), E(34520, 3)],
      [L('소속'), E(13260), L('직위'), E(13260)],
      [L('재직기간'), { text: '{{입사일}} ~ 현재', width: 34520, colSpan: 3 }],
      [L('용도'), E(34520, 3)],
    ], { cache }) +
    para('위 사람은 당사에 재직하고 있음을 증명합니다.', { cache, vert: 20000 }) +
    para([[0, '발급일: '], [FORM.bold, '{{발급일}}']], { paraPr: FORM.center, cache, vert: 22000 }) +
    para([[FORM.bold, '주식회사 가나다상사'], [0, '  대표이사 {{대표자}} (인)']], { paraPr: FORM.center, cache, vert: 24000 }) +
    para([], { raw: clickHere('') + '<hp:run charPrIDRef="0"><hp:t> (담당 부서 연락처)</hp:t></hp:run>', cache, vert: 26000 }) +
    picture() +
    para([], { raw: '<hp:run charPrIDRef="14"><hp:t>문서번호 제2026-0412호</hp:t><hp:futureThing kind="미래 요소" level="3"/></hp:run>', cache, vert: 30000 }),
  ], { extra: { 'BinData/image1.png': PNG_1PX }, manifest: PICTURE_ITEM, preview: '재 직 증 명 서' })
}

/**
 * A made-up one-page application (신청서) built the way statutory forms are: the page is one table placed as a character
 * (글자처럼 취급), a heading row, `rows` empty list rows and a closing row, every row 3000 HWPUNIT tall. With the default
 * 18 list rows the table is 60,000 tall, and the built-in page's body (84,186 less 5,668 top, 4,252 bottom, header and
 * footer) is 65,762: one more row fits, two do not.
 */
export function onePageForm(o: { rows?: number; treatAsChar?: boolean; pageBreak?: 'CELL' | 'TABLE' | 'NONE'; page?: PageSpec } = {}): Uint8Array {
  const W = [6000, 9000, 15000]
  const row = (...t: string[]): CellSpec[] => t.map((text, k) => ({ text, width: W[k]!, height: 3000 }))
  return hwpxDoc([
    table([
      row('관계', '성명', '주소'),
      ...Array.from({ length: o.rows ?? 18 }, () => row('', '', '')),
      [{ text: '가나시장 귀하', width: 30000, colSpan: 3, height: 3000 }],
    ], { treatAsChar: o.treatAsChar, pageBreak: o.pageBreak }) +
    para('위와 같이 신청합니다.'),
  ], { page: o.page })
}

/**
 * A made-up purchase request (물품 구매 요청서): a table of items with a title row, two item rows and a total row
 * (its first cell merged across four columns), shaded by a cell zone on the title row.
 */
export function purchaseForm(o: { cache?: boolean; zones?: boolean } = {}): Uint8Array {
  const W = [12000, 9000, 5000, 7000, 9000]
  const H = (t: string, i: number): CellSpec => ({ text: [[FORM.bold, t]], width: W[i]!, shaded: true })
  const C = (t: string, i: number): CellSpec => ({ text: t, width: W[i]! })
  const zones = o.zones === false ? '' : '<hp:cellzoneList><hp:cellzone startRowAddr="0" startColAddr="0" endRowAddr="0" endColAddr="4" borderFillIDRef="4"/><hp:cellzone startRowAddr="3" startColAddr="0" endRowAddr="3" endColAddr="4" borderFillIDRef="3"/></hp:cellzoneList>'
  return hwpxDoc([
    para([[FORM.title, '물품 구매 요청서']], { paraPr: FORM.center, cache: o.cache }) +
    para('요청 부서: 경영지원팀    요청일: 2026년 11월 3일', { cache: o.cache, vert: 3000 }) +
    table([
      ['품명', '규격', '수량', '단가', '금액'].map(H),
      ['복사용지', 'A4 80g', '10', '25,000', '250,000'].map(C),
      ['토너', '검정', '2', '89,000', '178,000'].map(C),
      [{ text: '합계', width: W[0]! + W[1]! + W[2]! + W[3]!, colSpan: 4, shaded: true }, C('428,000', 4)],
    ], { cache: o.cache, id: 1500000002, zones }) +
    para('위와 같이 구매를 요청합니다.', { cache: o.cache, vert: 16000 }),
  ])
}
