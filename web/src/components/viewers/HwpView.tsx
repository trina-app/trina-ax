import { useEffect, useState } from 'react'
import { HwpReason, type HwpPage } from '@mycel/shared/hwp'
import { api, API, isApiError } from '../../lib/api'
import { useT } from '../../i18n'
import { Button } from '../ui'

/** Shared web/Electron/WebView viewer. Only server-produced PNG pixels enter the page. */
export default function HwpView({ path, download }: { path: string; download: () => void }) {
  const t = useT()
  const [page, setPage] = useState(1)
  const [revision, retry] = useState(0)
  const [shown, setShown] = useState<{ url: string; meta: HwpPage } | null>(null)
  const [reason, setReason] = useState<HwpReason | 'missing' | null>(null)
  useEffect(() => {
    const ctrl = new AbortController()
    let url: string | undefined
    setShown(null); setReason(null)
    api.call(API.hwpPreview, { query: { path, page }, signal: ctrl.signal }).then(r => {
      if (ctrl.signal.aborted) return
      const bytes = Uint8Array.from(atob(r.png), c => c.charCodeAt(0))
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      setShown({ url, meta: r })
    }).catch(e => {
      if (ctrl.signal.aborted) return
      const parsed = HwpReason.safeParse(isApiError(e) ? e.body.params?.reason : undefined)
      setReason(isApiError(e, 'not_found') ? 'missing' : parsed.success ? parsed.data : 'engine')
    })
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url) }
  }, [path, page, revision])
  if (reason) return <div className="flex flex-col items-start gap-3 p-6" data-testid="preview-unsupported">
    <p className="text-sm text-muted" role="status">{reason === 'missing' ? t('preview.notFound') : t(`hwp.${reason}`)}</p>
    {reason !== 'missing' && <Button variant="primary" onClick={download} data-testid="preview-unsupported-download">{t('common.download')}</Button>}
    <Button variant="secondary" onClick={() => retry(n => n + 1)}>{t('common.retry')}</Button>
  </div>
  return <section className="flex flex-col gap-3 p-3" data-testid="hwp-view" aria-label={t('hwp.viewer')}>
    <nav className="flex flex-wrap items-center justify-center gap-3" aria-label={t('hwp.pages')}>
      <Button variant="secondary" disabled={page <= 1 || !shown} onClick={() => setPage(n => n - 1)} data-testid="hwp-previous">{t('hwp.previous')}</Button>
      <span role="status">{shown ? t('hwp.page', { page, count: shown.meta.pageCount }) : t('common.loading')}</span>
      <Button variant="secondary" disabled={!shown || page >= shown.meta.pageCount} onClick={() => setPage(n => n + 1)} data-testid="hwp-next">{t('hwp.next')}</Button>
    </nav>
    {shown && <>
      <p className="text-xs text-muted">{t('hwp.limitations')}</p>
      <img src={shown.url} width={shown.meta.width} height={shown.meta.height} alt={t('hwp.page', { page, count: shown.meta.pageCount })} className="mx-auto h-auto max-w-full bg-white shadow-sm" data-testid="hwp-page" />
    </>}
  </section>
}
