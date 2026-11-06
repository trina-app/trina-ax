// Word / PowerPoint / Excel previews rendered in the page (no server conversion): docx-preview,
// @aiden0z/pptx-renderer (Apache-2.0), SheetJS. Ported from Saram web/src/components/viewers/OfficeView.tsx.
import clsx from 'clsx'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { CellObject } from 'xlsx'
import { useLocale, useT } from '../../i18n'
import { guardLinks } from '../../lib/safeLinks'
import { SHEET_PREVIEW_ROWS, rangeCellIds, sheetMeta, startSheetIndex, type SheetMeta } from '../../lib/sheetPreview'

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
  if (busy) return <p className="p-6 text-sm text-faint">{t('common.loading')}</p>
  return null
}

export function DocxView({ blob }: { blob: Blob }) {
  const t = useT()
  const { ref, error, busy } = useRender(async (el) => {
    const { renderAsync } = await import('docx-preview')
    // no external resources: docx-preview renders embedded images from the file itself
    await renderAsync(blob, el, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true, renderComments: false, renderAltChunks: false, useBase64URL: true })
  }, [blob])
  return (
    <>
      <Status busy={busy} error={error} what={t('preview.kind.docx')} />
      <div ref={ref} className="docx-host" />
    </>
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
    <>
      <Status busy={busy} error={error} what={t('preview.kind.pptx')} />
      <div ref={ref} className="mx-auto py-3" style={{ width: w }} />
    </>
  )
}

/** `startSheet` / `range` (an answer's source, a link with &sheet=…&range=…): that tab opens, its range is marked and
 * scrolled into view. */
export function SheetView({ blob, startSheet, range }: { blob: Blob; startSheet?: string; range?: string }) {
  const t = useT()
  const locale = useLocale()
  const [sheets, setSheets] = useState<(SheetMeta & { html: string })[] | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  useSafeLinks(tableRef, [sheets])
  useEffect(() => {
    let live = true
    setSheets(null)
    setError(null)
    ;(async () => {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array', dense: true, sheetRows: SHEET_PREVIEW_ROWS, sheetStubs: true })
      // a formula cell without a stored result (make_file writes these) shows its formula, not a blank
      for (const name of wb.SheetNames) {
        for (const row of (wb.Sheets[name] as { '!data'?: (CellObject | undefined)[][] })['!data'] ?? []) {
          row?.forEach((c, j) => {
            if (c?.t === 'z') row[j] = c.f ? { t: 's', v: `=${c.f}`, w: `=${c.f}` } : undefined
          })
        }
      }
      // sheet_to_html escapes cell text (cell hyperlinks become <a href>: useSafeLinks); the editable flag stays off
      // Hidden sheets stay in the tabs with a badge; a sheet cut at the row limit shows a notice (R2-FMT-06/07).
      const out = sheetMeta(wb, XLSX.utils.decode_range).map((m) => ({ ...m, html: XLSX.utils.sheet_to_html(wb.Sheets[m.name]!, { header: '', footer: '' }) }))
      if (live) {
        setSheets(out)
        setActive(startSheetIndex(out, startSheet))
      }
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [blob, startSheet])
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
  if (!sheets) return <p className="p-6 text-sm text-faint">{t('common.loading')}</p>
  const current = sheets[active]
  return (
    <div className="flex h-full flex-col">
      {current?.cut && (
        <p role="status" className="shrink-0 border-b border-line bg-subtle px-3 py-1.5 text-xs text-muted" data-testid="sheet-rows-cut">
          {t('preview.sheetRowsCut', { rows: SHEET_PREVIEW_ROWS.toLocaleString(locale) })}
        </p>
      )}
      <div
        ref={tableRef}
        className="min-h-0 flex-1 overflow-auto bg-surface p-3 text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap [&_tr:first-child_td]:bg-subtle [&_tr:first-child_td]:font-semibold [&_td[data-t=n]]:text-right [&_td[data-t=n]]:tabular-nums [&_td[data-source-cell]]:bg-accent-soft"
        data-sheet={current?.name}
        dangerouslySetInnerHTML={{ __html: current?.html ?? '' }}
      />
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
