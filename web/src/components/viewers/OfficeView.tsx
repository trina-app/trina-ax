// Word / PowerPoint / Excel previews rendered in the page (no server conversion): docx-preview,
// @aiden0z/pptx-renderer (Apache-2.0), SheetJS. Ported from Saram web/src/components/viewers/OfficeView.tsx.
import { fixRenderedBullets } from '../../lib/docxBullets'
import { alignLineFloats, lineFloats } from '../../lib/docxFloat'
import { docxFitZoom, docxPageWidth } from '../../lib/docxFit'
import { defaultDocxPages } from '../../lib/docxPage'
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { CellObject } from 'xlsx'
import { useLocale, useT } from '../../i18n'
import { guardLinks } from '../../lib/safeLinks'
import { startDraw } from '../../lib/renderHost'
import { PreviewLoading } from '../ui'
import { SHEET_PREVIEW_ROWS, rangeCellIds, sheetMeta, startSheetIndex, type SheetMeta } from '../../lib/sheetPreview'
import { fillFormulaResults, type SheetFormula } from '../../lib/sheetFormulas'
import { gridFromCells, picturesReach, placePicture, readSheetPictures, type DrawnCell, type SheetPicture } from '../../lib/sheetPictures'

/** Links in a drawn document: http(s) only, opened in a new tab without an opener, with no question first
 * (lib/safeLinks.ts; docs/decisions/20261123-ask-registry-findings.md, decision 14). */
function useSafeLinks(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return guardLinks(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** render draws into `host`, an element of its own for this drawing (lib/renderHost.ts: a drawing still on its way when
 * the file or the width changes can only empty its own host, never the next drawing's slides); it may return a cleanup
 * function, run when the file changes or the view closes; `signal` is aborted then. */
function useRender(render: (host: HTMLDivElement, signal: AbortSignal) => Promise<void | (() => void)>, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  useSafeLinks(ref, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setBusy(true)
    setError(null)
    return startDraw(el, () => {
      const host = document.createElement('div')
      host.setAttribute('data-draw-host', '')
      return host
    }, render, { error: setError, done: () => setBusy(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { ref, error, busy }
}

function Status({ busy, error, what }: { busy: boolean; error: string | null; what: string }) {
  const t = useT()
  if (error) return <p className="p-6 text-sm text-danger">{t('preview.cantOpen', { what, error })}</p>
  if (busy) return <PreviewLoading overlay label={t('common.loading')} />
  return null
}

/** `width`: the width the preview is shown in (the panel's, the file viewer's column); a page wider than it is scaled
 * down to fit (lib/docxFit.ts), never up. */
export function DocxView({ blob, width }: { blob: Blob; width: number }) {
  const t = useT()
  // the widest page at scale 1, measured once after each render: a new object each time, so a next file whose pages
  // are as wide as the last one's still gets its zoom (renderAsync draws a new wrapper)
  const [page, setPage] = useState<{ w: number }>({ w: 0 })
  const { ref, error, busy } = useRender(async (el) => {
    const { renderAsync } = await import('docx-preview')
    // no external resources: docx-preview renders embedded images from the file itself
    // keepOrigin: the file's own XML, for what the renderer does not keep (where a floating picture is measured from)
    const doc = await renderAsync(blob, el, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true, renderComments: false, renderAltChunks: false, useBase64URL: true, keepOrigin: true } as Parameters<typeof renderAsync>[3])
    fixRenderedBullets(el)
    const xml = (doc.documentPart as unknown as { _xmlDocument?: Document } | undefined)?._xmlDocument
    if (xml) alignLineFloats([...el.querySelectorAll<HTMLElement>('section > article div[style*="width: 0px"]')], lineFloats(xml))
    // a file with no page of its own (make_file's .docx) gets Word's default page and margins (lib/docxPage.ts),
    // before the page width is measured for the fit zoom
    const wrapper = el.querySelector<HTMLElement>('.docx-wrapper')
    if (wrapper) defaultDocxPages(wrapper)
    setPage({ w: wrapper ? docxPageWidth(wrapper) : 0 })
  }, [blob])
  // CSS zoom (not a transform): the scroll height follows the smaller pages
  useLayoutEffect(() => {
    const wrapper = ref.current?.querySelector<HTMLElement>('.docx-wrapper')
    if (!wrapper) return
    const z = docxFitZoom(width, page.w)
    if (z < 1) wrapper.style.setProperty('zoom', String(z))
    else wrapper.style.removeProperty('zoom')
  }, [ref, width, page])
  return (
    <div className="relative min-h-full">
      <Status busy={busy} error={error} what={t('preview.kind.docx')} />
      <div ref={ref} className="docx-host" />
    </div>
  )
}

/** `startSlide` (an answer's source, a link with &slide=N): the slide's number in the show order, hidden slides
 * counted (the renderer's list has every slide, in that order). */
export function PptxView({ blob, width, startSlide }: { blob: Blob; width: number; startSlide?: number }) {
  const t = useT()
  const w = Math.max(320, width - 32)
  const { ref, error, busy } = useRender(async (host, signal) => {
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
    const bytes = await blob.arrayBuffer()
    if (signal.aborted) return
    // Embedded content only: external media links are not fetched, and the optional PDF.js fallback is off.
    const viewer = await PptxViewer.open(bytes, host, {
      signal,
      width: w,
      fitMode: 'contain',
      externalMedia: 'block',
      pdfjs: false,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      renderMode: 'list',
      listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
    })
    if (signal.aborted) {
      viewer.destroy()
      return
    }
    host.dataset.slides = String(viewer.slideCount)
    if (startSlide && startSlide >= 1 && startSlide <= viewer.slideCount) {
      host.dataset.startSlide = String(startSlide)
      await viewer.goToSlide(startSlide - 1, { block: 'start' })
    }
    return () => viewer.destroy()
  }, [blob, w, startSlide])
  return (
    <div className="relative min-h-full">
      <Status busy={busy} error={error} what={t('preview.kind.pptx')} />
      <div ref={ref} className="mx-auto py-3" style={{ width: w }} />
    </div>
  )
}

/** `startSheet` / `range` (an answer's source, a link with &sheet=…&range=…): that tab opens, its range is marked and
 * scrolled into view. */
export function SheetView({ blob, startSheet, range }: { blob: Blob; startSheet?: string; range?: string }) {
  const t = useT()
  const locale = useLocale()
  const [sheets, setSheets] = useState<(SheetMeta & { html: string; formulas: SheetFormula[]; pictures: (SheetPicture & { url: string })[]; first: { col: number; row: number }; last: { col: number; row: number } })[] | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // the formula cell last clicked or tapped: its formula shows under the sheet (a phone has no hover)
  const [picked, setPicked] = useState<SheetFormula | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  useSafeLinks(tableRef, [sheets])
  useEffect(() => {
    let live = true
    let made: { pictures: { url: string }[] }[] = []
    setSheets(null)
    setError(null)
    ;(async () => {
      const XLSX = await import('xlsx')
      const data = await blob.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array', dense: true, sheetRows: SHEET_PREVIEW_ROWS, sheetStubs: true, cellNF: true })
      // pictures anchored in each sheet (its drawing part): SheetJS reads cells only (lib/sheetPictures.ts)
      let pictures = new Map<string, SheetPicture[]>()
      try {
        const zip = XLSX.CFB.read(new Uint8Array(data), { type: 'array' }) as { FullPaths: string[]; FileIndex: { content?: Uint8Array | number[] }[] }
        const parts = new Map<string, number>()
        zip.FullPaths.forEach((p, i) => parts.set(p.replace(/^Root Entry\//, '').toLowerCase(), i))
        pictures = readSheetPictures((p) => {
          const i = parts.get(p.toLowerCase())
          const c = i === undefined ? undefined : zip.FileIndex[i]?.content
          return c && c.length ? (c instanceof Uint8Array ? c : Uint8Array.from(c)) : null
        })
      } catch { /* not a zip (.xls, .ods) or no readable drawing: cells only */ }
      // Hidden sheets stay in the tabs with a badge; a sheet cut at the row limit shows a notice (R2-FMT-06/07).
      const meta = sheetMeta(wb, XLSX.utils.decode_range)
      // A formula cell without a stored result (make_file and openpyxl write these) shows the result the preview
      // works out (S-112); a formula it can't work out shows as greyed formula text, never a guessed number.
      const formulas = fillFormulaResults(wb, {
        cut: new Set(meta.filter((m) => m.cut).map((m) => m.name)),
        decodeRange: XLSX.utils.decode_range,
        format: (z, v) => XLSX.SSF.format(z, v),
      })
      for (const name of wb.SheetNames) {
        for (const row of (wb.Sheets[name] as { '!data'?: (CellObject | undefined)[][] })['!data'] ?? []) {
          row?.forEach((c, j) => {
            if (c?.t === 'z') row[j] = undefined
          })
        }
      }
      // the drawn table reaches the cells the pictures are anchored to (up to the rows the preview reads)
      const span = (name: string) => {
        const ws = wb.Sheets[name]!
        const r = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null
        const lastRow = SHEET_PREVIEW_ROWS - 1
        // a picture anchored far outside the data (past 256 columns from its start, or the rows the preview reads) is
        // left out, so one anchor at XFD5000 cannot build a huge table
        const startCol = r?.s.c ?? 0
        const near = (pictures.get(name) ?? []).filter((p) => {
          const a = p.anchor
          const cells = a.kind === 'two' ? [a.from] : a.kind === 'one' ? [a.from] : []
          return cells.every((c) => c.col <= startCol + 255 && c.row <= lastRow)
        })
        pictures.set(name, near)
        const reach = picturesReach(near)
        const range = r ?? { s: { c: reach?.first.col ?? 0, r: reach?.first.row ?? 0 }, e: { c: reach?.first.col ?? 0, r: reach?.first.row ?? 0 } }
        if (reach) {
          range.s = { c: Math.min(range.s.c, reach.first.col), r: Math.min(range.s.r, reach.first.row) }
          // only the extra reach the pictures add is capped, never the data's own range
          range.e = { c: Math.max(range.e.c, Math.min(reach.last.col, range.s.c + 255)), r: Math.max(range.e.r, Math.min(reach.last.row, lastRow)) }
          ws['!ref'] = XLSX.utils.encode_range(range)
        }
        return { first: { col: range.s.c, row: range.s.r }, last: { col: range.e.c, row: range.e.r } }
      }
      // sheet_to_html escapes cell text (cell hyperlinks become <a href>: useSafeLinks); the editable flag stays off
      const out = meta.map((m) => ({ ...m, ...span(m.name), formulas: formulas.get(m.name) ?? [], html: XLSX.utils.sheet_to_html(wb.Sheets[m.name]!, { header: '', footer: '' }),
        pictures: (pictures.get(m.name) ?? []).map((p) => ({ ...p, url: URL.createObjectURL(new Blob([p.bytes as BlobPart], { type: p.type })) })) }))
      if (!live) { for (const sh of out) for (const p of sh.pictures) URL.revokeObjectURL(p.url); return }
      made = out
      setSheets(out)
      setActive(startSheetIndex(out, startSheet))
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
      for (const sh of made) for (const p of sh.pictures) URL.revokeObjectURL(p.url)
    }
  }, [blob, startSheet])
  // the pictures over the drawn cells: measured after the table is drawn and again when it changes size
  const gridRef = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<{ x: number; y: number; w: number; h: number }[]>([])
  useLayoutEffect(() => {
    const host = gridRef.current
    const sheet = sheets?.[active]
    setBoxes([])
    if (!host || !sheet?.pictures.length) return
    const measure = () => {
      const base = host.getBoundingClientRect()
      const cells: DrawnCell[] = []
      for (const td of host.querySelectorAll<HTMLTableCellElement>('td[id^="sjs-"]')) {
        const m = /^sjs-([A-Z]{1,3})(\d{1,7})$/.exec(td.id)
        if (!m) continue
        const col = [...m[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
        const r = td.getBoundingClientRect()
        cells.push({ col, row: Number(m[2]) - 1, colSpan: td.colSpan || 1, rowSpan: td.rowSpan || 1, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height })
      }
      const grid = gridFromCells(cells, sheet.first.col, sheet.first.row, sheet.last.col, sheet.last.row)
      setBoxes(sheet.pictures.map((p) => placePicture(p, grid)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [sheets, active])
  // formula cells: the formula on hover; one the preview can't work out is greyed
  const notCalculated = t('preview.formulaNotCalculated')
  useEffect(() => {
    const el = tableRef.current
    const list = sheets?.[active]?.formulas
    setPicked(null)
    if (!el || !list) return
    for (const f of list) {
      const td = el.querySelector<HTMLElement>(`#sjs-${f.addr}`)
      if (!td) continue
      td.dataset.formula = f.shown ? 'shown' : 'raw'
      td.title = f.shown ? `=${f.formula}` : `=${f.formula}\n${notCalculated}`
    }
  }, [sheets, active, notCalculated])
  // the source's rows: marked and scrolled to while its sheet is the open tab
  const targetOpen = !!sheets && startSheet !== undefined && sheets[active]?.name === startSheet
  useEffect(() => {
    const el = tableRef.current
    if (!el || !targetOpen) return
    const cells = rangeCellIds(range).map((id) => el.querySelector<HTMLElement>(`#${id}`)).filter((c): c is HTMLElement => !!c)
    for (const c of cells) c.dataset.sourceCell = ''
    cells[0]?.scrollIntoView({ block: 'center', inline: 'nearest' })
    return () => { for (const c of cells) delete c.dataset.sourceCell }
  }, [targetOpen, range, active, sheets])
  if (error) return <p className="p-6 text-sm text-danger">{t('preview.cantOpen', { what: t('preview.kind.sheet'), error })}</p>
  if (!sheets) return <PreviewLoading label={t('common.loading')} />
  const current = sheets[active]
  return (
    <div className="flex h-full flex-col">
      {current?.cut && (
        <p role="status" className="shrink-0 border-b border-line bg-subtle px-3 py-1.5 text-xs text-muted" data-testid="sheet-rows-cut">
          {t('preview.sheetRowsCut', { rows: SHEET_PREVIEW_ROWS.toLocaleString(locale) })}
        </p>
      )}
      {/* its own scroll box, in the Tab order (named by the sheet) so a keyboard can scroll a long or wide sheet */}
      <div
        ref={tableRef}
        tabIndex={0}
        role="region"
        aria-label={current?.name}
        className="min-h-0 flex-1 overflow-auto bg-surface p-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap [&_tr:first-child_td]:bg-subtle [&_tr:first-child_td]:font-semibold [&_td[data-t=n]]:text-right [&_td[data-t=n]]:tabular-nums [&_td[data-source-cell]]:bg-accent-soft [&_td[data-formula=raw]]:text-faint [&_td[data-formula=raw]]:italic [&_td[data-formula=raw]]:max-w-48 [&_td[data-formula=raw]]:overflow-hidden [&_td[data-formula=raw]]:text-ellipsis"
        data-sheet={current?.name}
        onClick={(e) => {
          const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-formula]')
          const addr = td?.id.replace(/^sjs-/, '')
          setPicked((addr && current?.formulas.find((f) => f.addr === addr)) || null)
        }}
      >
        {/* the table and, over it, the sheet's pictures where they are anchored (lib/sheetPictures.ts) */}
        <div ref={gridRef} className="relative w-max">
          <div dangerouslySetInnerHTML={{ __html: current?.html ?? '' }} />
          {current?.pictures.map((p, i) => boxes[i] && (
            <img key={`${active}-${i}`} src={p.url} alt={p.name} data-testid="sheet-picture" draggable={false}
              className="pointer-events-none absolute max-w-none object-fill select-none"
              style={{ left: boxes[i]!.x, top: boxes[i]!.y, width: boxes[i]!.w, height: boxes[i]!.h }} />
          ))}
        </div>
      </div>
      {picked && (
        <p role="status" className="flex shrink-0 flex-wrap gap-x-2 border-t border-line bg-subtle px-3 py-1.5 text-xs" data-testid="sheet-formula">
          <span className="font-semibold text-muted">{picked.addr}</span>
          <span className="min-w-0 truncate font-mono" title={`=${picked.formula}`}>={picked.formula}</span>
          {!picked.shown && <span className="text-faint">{notCalculated}</span>}
        </p>
      )}
      {sheets.length > 1 && (
        <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-t border-line bg-subtle px-2 py-1">
          {sheets.map((s, i) => (
            <button key={i} role="tab" type="button" aria-selected={i === active} onClick={() => setActive(i)} title={s.hidden ? t('preview.sheetHiddenTitle') : undefined} className={clsx('inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs whitespace-nowrap focus-visible:-outline-offset-2', i === active ? 'bg-surface font-semibold shadow-sm' : 'text-muted hover:bg-hover', s.hidden && 'italic')}>
              {s.name}
              {s.hidden && (
                <span className="rounded border border-line px-1 text-nano font-normal not-italic text-faint" data-testid="sheet-hidden-badge">
                  {t('preview.sheetHidden')}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
