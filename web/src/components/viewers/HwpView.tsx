import { useEffect, useState } from 'react'
import { HWP_PLUGIN_ID, HwpReason, type HwpPage } from '@mycel/shared/hwp'
import { api, API, isApiError } from '../../lib/api'
import { useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { Button } from '../ui'

/** Where the pages come from: a team file by its path, or a file sent in a team chat room (read through the room: its
 * members only, the same checks as reading it inline). */
export type HwpSource = { kind: 'team'; path: string } | { kind: 'room'; roomId: string; fileId: string }

/** Shared web/Electron/WebView viewer. Only server-produced PNG pixels enter the page. */
export default function HwpView({ source, download, startPage }: { source: HwpSource; download: () => void; startPage?: number }) {
  const t = useT()
  const me = useMe()
  // a page the AI looked at (hwp_render), from an answer's sources
  const [page, setPage] = useState(startPage && startPage >= 1 ? startPage : 1)
  const [revision, retry] = useState(0)
  const [shown, setShown] = useState<{ url: string; meta: HwpPage } | null>(null)
  // 'quarantined': the file is on the team's download-only list (the server's own words say so: `held`)
  const [reason, setReason] = useState<HwpReason | 'missing' | 'quarantined' | null>(null)
  const [held, setHeld] = useState('')
  const where = source.kind === 'team' ? `team:${source.path}` : `room:${source.roomId}/${source.fileId}`
  useEffect(() => {
    const ctrl = new AbortController()
    let url: string | undefined
    setShown(null); setReason(null)
    const asked = source.kind === 'team'
      ? api.call(API.hwpPreview, { query: { path: source.path, page }, signal: ctrl.signal })
      : api.call(API.roomFileHwpPreview, { params: { id: source.roomId, fileId: source.fileId }, query: { page }, signal: ctrl.signal })
    asked.then(r => {
      if (ctrl.signal.aborted) return
      const bytes = Uint8Array.from(atob(r.png), c => c.charCodeAt(0))
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      setShown({ url, meta: r })
    }).catch(e => {
      if (ctrl.signal.aborted) return
      if (isApiError(e, 'unavailable') && e.body.params?.reason === 'quarantined') { setHeld(e.message); setReason('quarantined'); return }
      const parsed = HwpReason.safeParse(isApiError(e) ? e.body.params?.reason : undefined)
      setReason(isApiError(e, 'not_found') ? 'missing' : parsed.success ? parsed.data : 'engine')
    })
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where, page, revision])
  // the preview is off: an admin is told to turn the plugin on when it is installed and only turned off, otherwise
  // where to add it (an installed package that cannot run here, status 'unsupported', is not fixed by turning it on)
  const admin = isAdmin(me)
  const [installedOff, setInstalledOff] = useState(false)
  useEffect(() => {
    if (reason !== 'disabled' || !admin) return
    const ctrl = new AbortController()
    api.call(API.listPlugins, { signal: ctrl.signal })
      .then(d => { if (!ctrl.signal.aborted) setInstalledOff(d.installed.some(p => p.id === HWP_PLUGIN_ID && p.status === 'disabled')) })
      .catch(() => { /* the hint stays the general one */ })
    return () => ctrl.abort()
  }, [reason, admin])
  if (reason) return <div className="flex flex-col items-start gap-3 p-6" data-testid="preview-unsupported">
    <p className="text-sm text-muted" role="status">{reason === 'missing' ? t('preview.notFound') : reason === 'quarantined' ? held : t(`hwp.${reason}`)}</p>
    {/* the HWP Preview plugin is off or missing: admins learn where to add it (docs/PLUGINS.md) */}
    {reason === 'disabled' && admin && <a className="text-sm text-accent-text underline" href="/admin/plugins" data-testid="hwp-plugins-link">{t(installedOff ? 'hwp.disabledAdminOff' : 'hwp.disabledAdmin')}</a>}
    {reason !== 'missing' && <Button variant="primary" onClick={download} data-testid="preview-unsupported-download">{t('common.download')}</Button>}
    {reason !== 'quarantined' && <Button variant="secondary" onClick={() => retry(n => n + 1)}>{t('common.retry')}</Button>}
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
