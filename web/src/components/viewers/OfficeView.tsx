// Word / PowerPoint / Excel previews rendered in the page (no server conversion): docx-preview, pptx-preview,
// SheetJS. Ported from Saram web/src/components/viewers/OfficeView.tsx.
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'

function useRender(render: (el: HTMLDivElement) => Promise<void>, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let live = true
    setBusy(true)
    setError(null)
    el.innerHTML = ''
    render(el)
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setBusy(false))
    return () => {
      live = false
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
    await renderAsync(blob, el, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true, renderComments: false, useBase64URL: true })
  }, [blob])
  return (
    <>
      <Status busy={busy} error={error} what={t('preview.kind.docx')} />
      <div ref={ref} className="docx-host" />
    </>
  )
}

export function PptxView({ blob, width }: { blob: Blob; width: number }) {
  const t = useT()
  const w = Math.max(320, width - 32)
  const { ref, error, busy } = useRender(async (el) => {
    const { init } = await import('pptx-preview')
    const previewer = init(el, { width: w, height: Math.round((w * 9) / 16), mode: 'list' })
    await previewer.preview(await blob.arrayBuffer())
  }, [blob, w])
  return (
    <>
      <Status busy={busy} error={error} what={t('preview.kind.pptx')} />
      <div ref={ref} className="mx-auto py-3" style={{ width: w }} />
    </>
  )
}

export function SheetView({ blob }: { blob: Blob }) {
  const t = useT()
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setSheets(null)
    setError(null)
    ;(async () => {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array', dense: true, sheetRows: 5000 })
      // sheet_to_html escapes cell text; the editable flag stays off
      const out = wb.SheetNames.map((name) => ({ name, html: XLSX.utils.sheet_to_html(wb.Sheets[name]!, { header: '', footer: '' }) }))
      if (live) {
        setSheets(out)
        setActive(0)
      }
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [blob])
  if (error) return <p className="p-6 text-sm text-danger">{t('preview.cantOpen', { what: t('preview.kind.sheet'), error })}</p>
  if (!sheets) return <p className="p-6 text-sm text-faint">{t('common.loading')}</p>
  return (
    <div className="flex h-full flex-col">
      <div
        className="min-h-0 flex-1 overflow-auto bg-surface p-3 text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap [&_tr:first-child_td]:bg-subtle [&_tr:first-child_td]:font-semibold"
        dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? '' }}
      />
      {sheets.length > 1 && (
        <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-t border-line bg-subtle px-2 py-1">
          {sheets.map((s, i) => (
            <button key={i} role="tab" type="button" aria-selected={i === active} onClick={() => setActive(i)} className={clsx('rounded px-2.5 py-1 text-xs whitespace-nowrap', i === active ? 'bg-surface font-semibold shadow-sm' : 'text-muted hover:bg-hover')}>
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
