// Native Excel charts in the workbooks make_file writes (tools/make-file.ts). Neither exceljs nor SheetJS writes charts,
// so after exceljs has written the file, the chart parts are added to its zip (files/zip-write.ts): for each chart
// xl/charts/chartN.xml (DrawingML chart over the sheet's cells), one xl/drawings/drawingN.xml per sheet with an anchor
// per chart, their relationships, the content types, and <drawing r:id> in the sheet. Every other part is copied as it
// was. The chart refers to the cells (Excel and LibreOffice redraw it when the numbers change) and carries the values
// as its cache, so a viewer that does not calculate shows it too.
// A chart covers one rectangle of one sheet: its first column is the labels (categories), its first row the series
// names, every other column one series of numbers. Kinds: column (vertical bars), bar (horizontal), line, pie.
import { MAKE_FILE_CHARTS_MAX } from '@mycel/shared'
import { readZip, writeZip, type ZipEntry } from '../files/zip-write'
import { ToolError } from '../policy/errors'

export const CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const
export type ChartType = (typeof CHART_TYPES)[number]
/** the charts of one workbook (the tool's schema says the same: MAKE_FILE_CHARTS_MAX) */
export const CHARTS_MAX = MAKE_FILE_CHARTS_MAX

export interface ChartSpec { type: ChartType; range: string; sheet?: string; title?: string; anchor?: string }
/** A sheet as make_file wrote it: its name in the file, the heading it came from, its cells (rows[r][c] = row r+1). */
export interface ChartSheet { name: string; title?: string; rows: unknown[][] }

interface Area { c1: number; r1: number; c2: number; r2: number }
interface Placed { spec: ChartSpec; sheet: number; area: Area; from: { col: number; row: number } }

const colNumber = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
export const colName = (n: number): string => (n > 26 ? colName(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26))
const MAX_COL = 16384, MAX_ROW = 1048576
/** a chart's size in cells */
const CHART_COLS = 8, CHART_ROWS = 16
const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/

function cell(s: string): { col: number; row: number } | null {
  const m = CELL.exec(s.trim())
  if (!m) return null
  const col = colNumber(m[1]!), row = Number(m[2])
  return col >= 1 && col <= MAX_COL && row >= 1 && row <= MAX_ROW ? { col, row } : null
}

/** XML text and attribute values: escaped, and characters XML 1.0 cannot hold (control characters, lone surrogates) dropped */
export const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')

/** The value a cell shows: a number, a formula's stored result, or text */
function shown(v: unknown): number | string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return v
  if (typeof v === 'object' && 'formula' in (v as object)) {
    const r = (v as { result?: unknown }).result
    return typeof r === 'number' || typeof r === 'string' ? r : null
  }
  return String(v)
}

/**
 * Checks every chart against the sheets and decides where it goes; throws a ToolError naming the problem (nothing is
 * saved then). Charts without `anchor` go right of the sheet's data, one below the other.
 */
export function placeCharts(specs: ChartSpec[], sheets: ChartSheet[]): Placed[] {
  if (specs.length > CHARTS_MAX) throw new ToolError(`at most ${CHARTS_MAX} charts per file`)
  const findSheet = (want: string) => sheets.findIndex((s) => s.name.toLowerCase() === want.trim().toLowerCase() || s.title?.trim().toLowerCase() === want.trim().toLowerCase())
  const sheetList = () => sheets.map((s) => `'${s.name}'`).join(', ')
  const checked = specs.map((spec, i) => {
    const what = `chart ${i + 1}`
    // "A1:D5", "Sheet!A1:D5" or "'Q3 sales'!A1:D5" ('' inside quotes is one ')
    const m = /^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?([^!]*)$/.exec(spec.range.trim())
    if (!m) throw new ToolError(`${what}: range must be like "A1:D5" (got '${spec.range}')`)
    const prefix = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]
    let sheet = 0
    if (prefix !== undefined) {
      sheet = findSheet(prefix)
      if (sheet < 0) throw new ToolError(`${what}: there is no sheet '${prefix}'; the sheets are ${sheetList()}`)
    }
    if (spec.sheet !== undefined && spec.sheet.trim() !== '') {
      const named = findSheet(spec.sheet)
      if (named < 0) throw new ToolError(`${what}: there is no sheet '${spec.sheet}'; the sheets are ${sheetList()}`)
      if (prefix !== undefined && named !== sheet) throw new ToolError(`${what}: range names sheet '${prefix}' but sheet is '${spec.sheet}'`)
      sheet = named
    }
    const s = sheets[sheet]!
    const [a, b, extra] = m[3]!.split(':')
    const p = a !== undefined ? cell(a) : null, q = b !== undefined ? cell(b) : null
    if (!p || !q || extra !== undefined) throw new ToolError(`${what}: range must be like "A1:D5" (got '${spec.range}')`)
    const area = { c1: Math.min(p.col, q.col), r1: Math.min(p.row, q.row), c2: Math.max(p.col, q.col), r2: Math.max(p.row, q.row) }
    const width = s.rows.reduce((n, r) => Math.max(n, r.length), 0)
    if (area.r2 > s.rows.length || area.c2 > width) throw new ToolError(`${what}: ${spec.range} is outside sheet '${s.name}' (its data is A1:${colName(Math.max(width, 1))}${Math.max(s.rows.length, 1)})`)
    if (area.c2 === area.c1 || area.r2 === area.r1) throw new ToolError(`${what}: the range needs a label column and a name row plus at least one column of numbers, e.g. A1:D5`)
    if (spec.type === 'pie' && area.c2 - area.c1 > 1) throw new ToolError(`${what}: a pie chart takes one column of numbers (labels plus one column, e.g. A1:B5)`)
    for (let c = area.c1 + 1; c <= area.c2; c++) {
      let any = false
      for (let r = area.r1 + 1; r <= area.r2; r++) if (typeof shown(s.rows[r - 1]?.[c - 1]) === 'number' || isFormulaCell(s.rows[r - 1]?.[c - 1])) any = true
      if (!any) throw new ToolError(`${what}: column ${colName(c)} has no numbers in ${colName(c)}${area.r1 + 1}:${colName(c)}${area.r2}; write plain numbers in the cells (no currency signs, % or units)`)
    }
    let at: { col: number; row: number } | null = null
    if (spec.anchor !== undefined && spec.anchor.trim() !== '') {
      at = cell(spec.anchor)
      if (!at) throw new ToolError(`${what}: anchor must be a cell like "G2" (got '${spec.anchor}')`)
      if (at.col > MAX_COL - CHART_COLS || at.row > MAX_ROW - CHART_ROWS) throw new ToolError(`${what}: anchor ${spec.anchor} leaves no room for the chart; pick a cell nearer A1`)
    }
    return { spec, sheet, area, at, width }
  })
  // charts without an anchor go right of the data, one below the other, starting below any anchored chart there
  const next = new Map<number, number>()
  const free = (sheet: number, col: number) => {
    let row = next.get(sheet)
    if (row === undefined) {
      row = 2
      for (const c of checked) if (c.sheet === sheet && c.at && c.at.col < col + CHART_COLS && c.at.col + CHART_COLS > col) row = Math.max(row, c.at.row + CHART_ROWS + 2)
    }
    next.set(sheet, row + CHART_ROWS + 2)
    return row
  }
  return checked.map((c) => ({ spec: c.spec, sheet: c.sheet, area: c.area, from: c.at ?? { col: c.width + 2, row: free(c.sheet, c.width + 2) } }))
}

const isFormulaCell = (v: unknown) => typeof v === 'object' && v !== null && 'formula' in v

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`
const ref = (sheet: string, c1: number, r1: number, c2 = c1, r2 = r1) =>
  `${quoteSheet(sheet)}!$${colName(c1)}$${r1}` + (c1 === c2 && r1 === r2 ? '' : `:$${colName(c2)}$${r2}`)

function strCache(values: (number | string | null)[]): string {
  return `<c:strCache><c:ptCount val="${values.length}"/>` +
    values.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${esc(String(v))}</c:v></c:pt>`)).join('') + '</c:strCache>'
}
function numCache(values: (number | string | null)[]): string {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>` +
    values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : '')).join('') + '</c:numCache>'
}

const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** chartN.xml of one placed chart (ECMA-376 part 1, 21.2: element order as the schema has it) */
export function chartXml(p: Placed, sheet: ChartSheet): string {
  const { spec, area } = p
  const at = (r: number, c: number) => shown(sheet.rows[r - 1]?.[c - 1])
  const cats: (number | string | null)[] = []
  for (let r = area.r1 + 1; r <= area.r2; r++) cats.push(at(r, area.c1))
  const numericCats = cats.every((v) => typeof v === 'number')
  const catRef = ref(sheet.name, area.c1, area.r1 + 1, area.c1, area.r2)
  const cat = numericCats ? `<c:cat><c:numRef><c:f>${esc(catRef)}</c:f>${numCache(cats)}</c:numRef></c:cat>`
    : `<c:cat><c:strRef><c:f>${esc(catRef)}</c:f>${strCache(cats)}</c:strRef></c:cat>`
  const series: string[] = []
  for (let c = area.c1 + 1, i = 0; c <= area.c2; c++, i++) {
    const vals: (number | string | null)[] = []
    for (let r = area.r1 + 1; r <= area.r2; r++) vals.push(at(r, c))
    const name = at(area.r1, c)
    const tx = `<c:tx><c:strRef><c:f>${esc(ref(sheet.name, c, area.r1))}</c:f>${strCache([name])}</c:strRef></c:tx>`
    const val = `<c:val><c:numRef><c:f>${esc(ref(sheet.name, c, area.r1 + 1, c, area.r2))}</c:f>${numCache(vals)}</c:numRef></c:val>`
    const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}`
    series.push(spec.type === 'line' ? `<c:ser>${head}<c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`
      : spec.type === 'pie' ? `<c:ser>${head}${cat}${val}</c:ser>`
        : `<c:ser>${head}<c:invertIfNegative val="0"/>${cat}${val}</c:ser>`)
  }
  // horizontal bars: the categories run top-down (first row on top), so the value axis crosses at the last one
  const axes = (catPos: 'b' | 'l', valPos: 'l' | 'b', topDown = false) =>
    `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="${topDown ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${catPos}"/>` +
    '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    '<c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>' +
    `<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${valPos}"/><c:majorGridlines/>` +
    '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:crossAx val="500000001"/><c:crosses val="${topDown ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`
  const ids = '<c:axId val="500000001"/><c:axId val="500000002"/>'
  const plot = spec.type === 'pie'
    ? `<c:pieChart><c:varyColors val="1"/>${series.join('')}<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`
    : spec.type === 'line'
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series.join('')}<c:marker val="1"/>${ids}</c:lineChart>${axes('b', 'l')}`
      : `<c:barChart><c:barDir val="${spec.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series.join('')}<c:gapWidth val="150"/>${ids}</c:barChart>${spec.type === 'bar' ? axes('l', 'b', true) : axes('b', 'l')}`
  const title = spec.title?.trim()
  const titleXml = title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr b="1"/></a:pPr><a:r><a:rPr b="1"/><a:t>${esc(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>'
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart>${titleXml}<c:plotArea><c:layout/>${plot}</c:plotArea>` +
    '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>'
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

function drawingXml(charts: { from: { col: number; row: number }; rid: string; id: number }[]): string {
  const anchor = (c: (typeof charts)[number]) =>
    '<xdr:twoCellAnchor editAs="oneCell">' +
    `<xdr:from><xdr:col>${c.from.col - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.from.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${c.from.col - 1 + CHART_COLS}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.from.row - 1 + CHART_ROWS}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${c.id + 1}" name="Chart ${c.id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="${c.rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    charts.map(anchor).join('') + '</xdr:wsDr>'
}

const relsXml = (rels: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELS_NS}">` +
  rels.map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${esc(r.target)}"/>`).join('') + '</Relationships>'

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * The workbook `xlsx` (as exceljs wrote it) with the charts added. `sheets` are its sheets in order, as written.
 * Throws a ToolError when a chart does not fit the sheets (placeCharts) and an Error when the file is not shaped as
 * expected (a bug, not the AI's input).
 */
export function addCharts(xlsx: Uint8Array, specs: ChartSpec[], sheets: ChartSheet[]): Uint8Array {
  const placed = placeCharts(specs, sheets)
  if (!placed.length) return xlsx
  const entries: ZipEntry[] = readZip(xlsx)
  const td = new TextDecoder()
  const te = new TextEncoder()
  const get = (name: string) => entries.find((e) => e.name === name)
  const text = (name: string) => { const e = get(name); return e ? td.decode(e.data) : null }
  const put = (name: string, xml: string) => {
    const e = get(name)
    const data = te.encode(xml)
    if (e) { e.data = data; delete e.raw; delete e.store } else entries.push({ name, data })
  }
  // sheet name -> its part, from the workbook and its relationships
  const wbXml = text('xl/workbook.xml'), wbRels = text('xl/_rels/workbook.xml.rels')
  if (!wbXml || !wbRels) throw new Error('xlsx without workbook parts')
  const targets = new Map<string, string>()
  for (const m of wbRels.matchAll(/<Relationship\b[^>]*>/g)) { const id = attr(m[0], 'Id'), t = attr(m[0], 'Target'); if (id && t) targets.set(id, t) }
  const sheetPart = new Map<string, string>()
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id')
    const t = rid ? targets.get(rid) : undefined
    if (name !== undefined && t) sheetPart.set(unesc(name), t.startsWith('/') ? t.slice(1) : `xl/${t}`)
  }
  let types = text('[Content_Types].xml')
  if (!types) throw new Error('xlsx without content types')
  const next = (dir: string, base: string) => {
    let n = 1
    while (get(`${dir}/${base}${n}.xml`)) n++
    return n
  }
  let chartNo = 0
  const bySheet = new Map<number, Placed[]>()
  for (const p of placed) bySheet.set(p.sheet, [...(bySheet.get(p.sheet) ?? []), p])
  for (const [si, list] of bySheet) {
    const sheet = sheets[si]!
    const part = sheetPart.get(sheet.name)
    const sheetXml = part ? text(part) : null
    if (!part || !sheetXml) throw new Error(`xlsx sheet '${sheet.name}' not found`)
    if (/<drawing\b/.test(sheetXml)) throw new Error(`xlsx sheet '${sheet.name}' already has a drawing`)
    const dn = next('xl/drawings', 'drawing')
    const drawingName = `xl/drawings/drawing${dn}.xml`
    const anchors: { from: { col: number; row: number }; rid: string; id: number }[] = []
    const drawingRels: { id: string; type: string; target: string }[] = []
    list.forEach((p, i) => {
      const cn = next('xl/charts', 'chart')
      put(`xl/charts/chart${cn}.xml`, chartXml(p, sheet))
      types = types!.replace('</Types>', `<Override PartName="/xl/charts/chart${cn}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`)
      drawingRels.push({ id: `rId${i + 1}`, type: 'chart', target: `../charts/chart${cn}.xml` })
      anchors.push({ from: p.from, rid: `rId${i + 1}`, id: ++chartNo })
    })
    put(drawingName, drawingXml(anchors))
    put(`xl/drawings/_rels/drawing${dn}.xml.rels`, relsXml(drawingRels))
    types = types.replace('</Types>', `<Override PartName="/${drawingName}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`)
    // the sheet's relationship to its drawing
    const dir = part.slice(0, part.lastIndexOf('/')), file = part.slice(part.lastIndexOf('/') + 1)
    const relsName = `${dir}/_rels/${file}.rels`
    const old = text(relsName)
    let rid = 'rIdChart1'
    for (let n = 1; old?.includes(`Id="${rid}"`); n++) rid = `rIdChart${n + 1}`
    const rel = `<Relationship Id="${rid}" Type="${REL}/drawing" Target="../drawings/drawing${dn}.xml"/>`
    put(relsName, old ? old.replace('</Relationships>', `${rel}</Relationships>`) : relsXml([]).replace('</Relationships>', `${rel}</Relationships>`))
    // <drawing> comes before these in CT_Worksheet (ECMA-376 part 1, 18.3.1.99)
    const before = /<(legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/.exec(sheetXml)
    if (!before) throw new Error('xlsx sheet without an end')
    const ns = /<worksheet\b[^>]*\sxmlns:r=/.test(sheetXml) ? '' : ` xmlns:r="${REL}"`
    put(part, sheetXml.slice(0, before.index) + `<drawing${ns} r:id="${rid}"/>` + sheetXml.slice(before.index))
  }
  put('[Content_Types].xml', types)
  return writeZip(entries)
}
