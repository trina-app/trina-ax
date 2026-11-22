// Word / PowerPoint / Excel previews rendered in the page (no server conversion): docx-preview,
// @aiden0z/pptx-renderer (Apache-2.0), SheetJS. Ported from Saram web/src/components/viewers/OfficeView.tsx.
import { fixRenderedBullets } from '../../lib/docxBullets'
import { docxFitZoom, docxPageWidth } from '../../lib/docxFit'
import { defaultDocxPages } from '../../lib/docxPage'
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { CellObject } from 'xlsx'
import { useLocale, useT } from '../../i18n'
import { guardLinks } from '../../lib/safeLinks'
import { PreviewLoading } from '../ui'
import { SHEET_PREVIEW_ROWS, rangeCellIds, sheetMeta, startSheetIndex, type SheetMeta } from '../../lib/sheetPreview'
import { fillFormulaResults, type SheetFormula } from '../../lib/sheetFormulas'

/** Links in a drawn document: http(s) only, opened after asking, in a new window (lib/safeLinks.ts). */
function useSafeLinks(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  const t = useT()
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return guardLinks(el, (url) => window.confirm(tRef.current('preview.openLink', { url })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** render may return a cleanup function; it runs when the file changes or the view closes. */
function useRender(render: (el: HTMLDivElement) => Promise<void | (() => void)>, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  useSafeLinks(ref, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let live = true
    setBusy(true)
    setError(null)
    el.innerHTML = ''
    let cleanup: (() => void) | undefined
    render(el)
      .then((done) => {
        if (typeof done !== 'function') return
        if (live) cleanup = done
        else done()
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setBusy(false))
    return () => {
      live = false
      cleanup?.()
    }
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
    await renderAsync(blob, el, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true, renderComments: false, renderAltChunks: false, useBase64URL: true })
    fixRenderedBullets(el)
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
  const { ref, error, busy } = useRender(async (el) => {
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
    // Embedded content only: external media links are not fetched, and the optional PDF.js fallback is off.
    const viewer = await PptxViewer.open(await blob.arrayBuffer(), el, {
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
    if (startSlide && startSlide >= 1 && startSlide <= viewer.slideCount) {
      el.dataset.startSlide = String(startSlide)
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
  const [sheets, setSheets] = useState<(SheetMeta & { html: string; formulas: SheetFormula[] })[] | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // the formula cell last clicked or tapped: its formula shows under the sheet (a phone has no hover)
  const [picked, setPicked] = useState<SheetFormula | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  useSafeLinks(tableRef, [sheets])
  useEffect(() => {
    let live = true
    setSheets(null)
    setError(null)
    ;(async () => {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array', dense: true, sheetRows: SHEET_PREVIEW_ROWS, sheetStubs: true, cellNF: true })
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
      // sheet_to_html escapes cell text (cell hyperlinks become <a href>: useSafeLinks); the editable flag stays off
      const out = meta.map((m) => ({ ...m, formulas: formulas.get(m.name) ?? [], html: XLSX.utils.sheet_to_html(wb.Sheets[m.name]!, { header: '', footer: '' }) }))
      if (live) {
        setSheets(out)
        setActive(startSheetIndex(out, startSheet))
      }
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [blob, startSheet])
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
        className="min-h-0 flex-1 overflow-auto bg-surface p-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap [&_tr:first-child_td]:bg-subtle [&_tr:first-child_td]:font-semibold [&_td[data-t=n]]:text-right [&_td[data-t=n]]:tabular-nums [&_td[data-source-cell]]:bg-accent-soft [&_td[data-formula=raw]]:text-faint [&_td[data-formula=raw]]:italic"
        data-sheet={current?.name}
        onClick={(e) => {
          const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-formula]')
          const addr = td?.id.replace(/^sjs-/, '')
          setPicked((addr && current?.formulas.find((f) => f.addr === addr)) || null)
        }}
        dangerouslySetInnerHTML={{ __html: current?.html ?? '' }}
      />
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
