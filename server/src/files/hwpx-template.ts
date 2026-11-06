// The built-in template of make_file's .hwpx (files/hwpx-write.ts): an empty Hangul document (OWPML, KS X 6101) whose
// header holds the styles a Markdown document needs: 바탕글 for paragraphs, 개요 1-7 for headings (outline levels, no
// outline numbers, so a heading reads exactly as written), and the usual 본문, 쪽 번호, 머리말, 각주, 미주, 메모 and 캡션
// for whoever goes on editing it in Hangul. A4 portrait with Hangul's default margins, 함초롬바탕 10 pt for text and
// 함초롬돋움 for headings (the faces Hangul itself starts with). Written here, not shipped as a binary file, so every
// value can be read and reviewed; a team's own template (.hwpx under skills/) replaces it through the same code path.
// The XML layout follows Hancom's public OWPML documentation and files saved by Hangul (element order, the
// HwpUnitChar switch around paragraph margins, ids).
import { writeZip } from './zip-write'

/** The namespace declarations Hangul writes on the root of header.xml, sectionN.xml and content.hpf. */
export const OWPML_NS = [
  ['ha', 'http://www.hancom.co.kr/hwpml/2011/app'],
  ['hp', 'http://www.hancom.co.kr/hwpml/2011/paragraph'],
  ['hp10', 'http://www.hancom.co.kr/hwpml/2016/paragraph'],
  ['hs', 'http://www.hancom.co.kr/hwpml/2011/section'],
  ['hc', 'http://www.hancom.co.kr/hwpml/2011/core'],
  ['hh', 'http://www.hancom.co.kr/hwpml/2011/head'],
  ['hhs', 'http://www.hancom.co.kr/hwpml/2011/history'],
  ['hm', 'http://www.hancom.co.kr/hwpml/2011/master-page'],
  ['hpf', 'http://www.hancom.co.kr/schema/2011/hpf'],
  ['dc', 'http://purl.org/dc/elements/1.1/'],
  ['opf', 'http://www.idpf.org/2007/opf/'],
  ['ooxmlchart', 'http://www.hancom.co.kr/hwpml/2016/ooxmlchart'],
  ['hwpunitchar', 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar'],
  ['epub', 'http://www.idpf.org/2007/ops'],
  ['config', 'urn:oasis:names:tc:opendocument:xmlns:config:1.0'],
] as const
export const NS_ATTRS = OWPML_NS.map(([p, u]) => `xmlns:${p}="${u}"`).join(' ')
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
export const HWPUNITCHAR = 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar'
/** "no character shape of its own" in numbering and bullet heads */
export const NO_CHAR_SHAPE = '4294967295'
const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'] as const
const LANG_ATTRS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'] as const
const each = (v: string | number) => LANG_ATTRS.map((l) => `${l}="${v}"`).join(' ')

/** The faces of the template: id 0 for headings, 1 for text (each language's list is the same). */
const FACES = ['함초롬돋움', '함초롬바탕']
export const DOTUM = 0, BATANG = 1

function fontfaces(): string {
  const fonts = FACES.map((f, i) => `<hh:font id="${i}" face="${f}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`).join('')
  return `<hh:fontfaces itemCnt="${LANGS.length}">${LANGS.map((l) => `<hh:fontface lang="${l}" fontCnt="${FACES.length}">${fonts}</hh:fontface>`).join('')}</hh:fontfaces>`
}

const BORDER_NONE = '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
  ['left', 'right', 'top', 'bottom'].map((s) => `<hh:${s}Border type="NONE" width="0.1 mm" color="#000000"/>`).join('') +
  '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>'

/** borderFill 1: nothing (pages, paragraphs); 2: nothing with an empty fill (character shapes), as Hangul starts */
function borderFills(): string {
  return '<hh:borderFills itemCnt="2">' +
    `<hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">${BORDER_NONE}</hh:borderFill>` +
    `<hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">${BORDER_NONE}<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush></hh:borderFill>` +
    '</hh:borderFills>'
}

export interface CharShape { height: number; face: number; bold?: boolean; italic?: boolean; spacing?: number; color?: string }

/** One character shape (hh:charPr) in Hangul's child order: italic before bold, both right after the offsets. */
export function charPrXml(id: number, s: CharShape, borderFill = 2): string {
  return `<hh:charPr id="${id}" height="${s.height}" textColor="${s.color ?? '#000000'}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="${borderFill}">` +
    `<hh:fontRef ${each(s.face)}/><hh:ratio ${each(100)}/><hh:spacing ${each(s.spacing ?? 0)}/><hh:relSz ${each(100)}/><hh:offset ${each(0)}/>` +
    (s.italic ? '<hh:italic/>' : '') + (s.bold ? '<hh:bold/>' : '') +
    '<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/>' +
    '<hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>'
}

export interface ParaShape {
  align?: 'JUSTIFY' | 'LEFT' | 'RIGHT' | 'CENTER'
  heading?: { type: 'NONE' | 'OUTLINE' | 'NUMBER' | 'BULLET'; idRef: number; level: number }
  /** HWPUNIT (1/100 pt) as Hangul shows them: the HwpUnitChar case of the switch; the default side holds them doubled */
  left?: number; indent?: number; prev?: number; next?: number
  lineSpacing?: { type: string; value: number }
  tabPr?: number
  keepWithNext?: boolean
  condense?: number
  borderFill?: number
}

/** One paragraph shape (hh:paraPr) as Hangul writes it: margins and line spacing twice, inside the HwpUnitChar switch
 * (the case in Hangul's units, the default side doubled for older readers; a percentage is the same on both). */
export function paraPrXml(id: number, s: ParaShape): string {
  const h = s.heading ?? { type: 'NONE', idRef: 0, level: 0 }
  const ls = s.lineSpacing ?? { type: 'PERCENT', value: 160 }
  const margin = (k: number) => `<hh:margin><hc:intent value="${(s.indent ?? 0) * k}" unit="HWPUNIT"/><hc:left value="${(s.left ?? 0) * k}" unit="HWPUNIT"/>` +
    `<hc:right value="0" unit="HWPUNIT"/><hc:prev value="${(s.prev ?? 0) * k}" unit="HWPUNIT"/><hc:next value="${(s.next ?? 0) * k}" unit="HWPUNIT"/></hh:margin>` +
    `<hh:lineSpacing type="${ls.type}" value="${ls.type === 'PERCENT' ? ls.value : ls.value * k}" unit="HWPUNIT"/>`
  return `<hh:paraPr id="${id}" tabPrIDRef="${s.tabPr ?? 0}" condense="${s.condense ?? 0}" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="LTR">` +
    `<hh:align horizontal="${s.align ?? 'JUSTIFY'}" vertical="BASELINE"/>` +
    `<hh:heading type="${h.type}" idRef="${h.idRef}" level="${h.level}"/>` +
    `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="${s.keepWithNext ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
    '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    `<hp:switch><hp:case hp:required-namespace="${HWPUNITCHAR}">${margin(1)}</hp:case><hp:default>${margin(2)}</hp:default></hp:switch>` +
    `<hh:border borderFillIDRef="${s.borderFill ?? 2}" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`
}

/** A numbering head (hh:paraHead) of one level: `text` is the label (^1 is this level's number), empty for none. */
export function paraHeadXml(level: number, numFormat: string, text: string, start = 1, checkable = false): string {
  const attrs = `start="${start}" level="${level}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${numFormat}" charPrIDRef="${NO_CHAR_SHAPE}" checkable="${checkable ? 1 : 0}"`
  return text ? `<hh:paraHead ${attrs}>${text}</hh:paraHead>` : `<hh:paraHead ${attrs}/>`
}

/** The heading levels of the template: 개요 1-7. Size in HWPUNIT (1000 = 10 pt), spacing above and below. */
const OUTLINE = [
  { height: 1600, prev: 1600, next: 600 },
  { height: 1400, prev: 1400, next: 500 },
  { height: 1200, prev: 1200, next: 400 },
  { height: 1100, prev: 1000, next: 300 },
  { height: 1000, prev: 800, next: 200 },
  { height: 1000, prev: 800, next: 200 },
  { height: 1000, prev: 800, next: 200 },
]

/** header.xml of the built-in template. */
export function defaultHeaderXml(): string {
  const chars: CharShape[] = [
    { height: 1000, face: BATANG }, // 0 바탕글, 본문, 캡션
    ...OUTLINE.map((o) => ({ height: o.height, face: DOTUM, bold: true })), // 1-7 개요 1-7
    { height: 1000, face: DOTUM }, // 8 쪽 번호
    { height: 900, face: BATANG }, // 9 머리말, 각주, 미주
    { height: 900, face: DOTUM, spacing: -5 }, // 10 메모
  ]
  const paras: ParaShape[] = [
    { next: 600 }, // 0 바탕글
    { next: 600 }, // 1 본문
    ...OUTLINE.map((o, i): ParaShape => ({ align: 'LEFT', heading: { type: 'OUTLINE', idRef: 0, level: i }, prev: o.prev, next: o.next, tabPr: 1, keepWithNext: true })), // 2-8
    { lineSpacing: { type: 'PERCENT', value: 150 } }, // 9 머리말
    { lineSpacing: { type: 'PERCENT', value: 130 } }, // 10 각주, 미주
    { align: 'LEFT', lineSpacing: { type: 'PERCENT', value: 130 } }, // 11 메모
    { lineSpacing: { type: 'PERCENT', value: 150 }, next: 600 }, // 12 캡션
  ]
  const style = (id: number, type: 'PARA' | 'CHAR', name: string, eng: string, para: number, char: number, next: number) =>
    `<hh:style id="${id}" type="${type}" name="${name}" engName="${eng}" paraPrIDRef="${para}" charPrIDRef="${char}" nextStyleIDRef="${next}" langID="1042" lockForm="0"/>`
  const styles = [
    style(0, 'PARA', '바탕글', 'Normal', 0, 0, 0),
    style(1, 'PARA', '본문', 'Body', 1, 0, 1),
    ...OUTLINE.map((_, i) => style(2 + i, 'PARA', `개요 ${i + 1}`, `Outline ${i + 1}`, 2 + i, 1 + i, 0)),
    style(9, 'CHAR', '쪽 번호', 'Page Number', 0, 8, 0),
    style(10, 'PARA', '머리말', 'Header', 9, 9, 10),
    style(11, 'PARA', '각주', 'Footnote', 10, 9, 11),
    style(12, 'PARA', '미주', 'Endnote', 10, 9, 12),
    style(13, 'PARA', '메모', 'Memo', 11, 10, 13),
    style(14, 'PARA', '캡션', 'Caption', 12, 0, 14),
  ]
  // the outline numbering (secPr outlineShapeIDRef="1"): every level without a label, so headings show only their text
  const outline = `<hh:numbering id="1" start="0">${Array.from({ length: 10 }, (_, i) => paraHeadXml(i + 1, 'DIGIT', '')).join('')}</hh:numbering>`
  return XML_DECL + `<hh:head ${NS_ATTRS} version="1.5" secCnt="1">` +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
    '<hh:refList>' + fontfaces() + borderFills() +
    `<hh:charProperties itemCnt="${chars.length}">${chars.map((c, i) => charPrXml(i, c)).join('')}</hh:charProperties>` +
    '<hh:tabProperties itemCnt="3"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/><hh:tabPr id="2" autoTabLeft="0" autoTabRight="1"/></hh:tabProperties>' +
    `<hh:numberings itemCnt="1">${outline}</hh:numberings>` +
    `<hh:paraProperties itemCnt="${paras.length}">${paras.map((p, i) => paraPrXml(i, p)).join('')}</hh:paraProperties>` +
    `<hh:styles itemCnt="${styles.length}">${styles.join('')}</hh:styles>` +
    '</hh:refList>' +
    '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
    '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
    '<hh:trackchageConfig flags="56"/>' +
    '</hh:head>'
}

/** The section properties of the template's first paragraph: A4 portrait, Hangul's default margins (in HWPUNIT:
 * left/right 30 mm, top 20 mm, bottom 15 mm, header/footer 15 mm), one column. */
export function defaultSecPrXml(): string {
  const note = (place: string) => `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>` +
    `<hp:noteSpacing betweenNotes="${place === 'EACH_COLUMN' ? 283 : 0}" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="${place}" beneathText="0"/>`
  const pageBorder = (t: string) => `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`
  return '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
    '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
    '<hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr>' +
    `<hp:footNotePr>${note('EACH_COLUMN')}</hp:footNotePr><hp:endNotePr>${note('END_OF_DOCUMENT')}</hp:endNotePr>` +
    pageBorder('BOTH') + pageBorder('EVEN') + pageBorder('ODD') + '</hp:secPr>'
}
export const COL_PR = '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>'

/** The built-in template as a .hwpx file: the header above and one empty paragraph. */
let cached: Uint8Array | null = null
export function defaultTemplate(): Uint8Array {
  if (cached) return cached
  const section = XML_DECL + `<hs:sec ${NS_ATTRS}><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
    `<hp:run charPrIDRef="0">${defaultSecPrXml()}${COL_PR}</hp:run><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p></hs:sec>`
  const enc = (s: string) => new TextEncoder().encode(s)
  cached = writeZip([
    { name: 'mimetype', data: enc('application/hwp+zip'), store: true },
    { name: 'Contents/header.xml', data: enc(defaultHeaderXml()) },
    { name: 'Contents/section0.xml', data: enc(section) },
  ])
  return cached
}
