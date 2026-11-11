import { useEffect, useRef, useState } from 'react'
import { HWP_PLUGIN_ID, HwpReason, type HwpPage } from '@mycel/shared/hwp'
import { api, API, isApiError } from '../../lib/api'
import { useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { Button } from '../ui'

/** Where the pages come from: a team file by its path, or a file sent in a team chat room (read through the room: its
 * members only, the same checks as reading it inline). */
/** What the server says about this file or this server, which asking again cannot change: no [다시 시도], only the
 * download (QA TC-265 FILES-23: "이 서버에서는 한글 미리보기를 쓸 수 없어요" with a retry that could only fail again).
 * A timeout, a busy queue, a cancelled or changed render, a preview an admin may turn on, and a request that never got
 * the server's answer (the connection) keep it. */
export const HWP_FINAL: ReadonlySet<HwpReason> = new Set<HwpReason>(['engine', 'isolation', 'unsupported', 'locked', 'distribution', 'damaged', 'limit', 'loss'])
/** Whether the panel offers [다시 시도] for a failed preview; `fromServer`: the reason is the server's own words */
export const hwpCanRetry = (reason: HwpReason | 'missing' | 'quarantined', fromServer: boolean) =>
  reason !== 'quarantined' && !(fromServer && reason !== 'missing' && HWP_FINAL.has(reason))

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
  // the reason is the server's own (not a failure without its answer, which is shown as 'engine' and may pass)
  const [fromServer, setFromServer] = useState(false)
  const where = source.kind === 'team' ? `team:${source.path}` : `room:${source.roomId}/${source.fileId}`
  // The document the pages on screen come from (each page carries its sourceHash). Pages are asked for by path, so
  // after someone replaced the file the next page came from the new one: "3 / 5쪽" right after page 2 of the old one
  // (QA TC-226). A page of another document is not shown in its place: the preview starts again at page 1 of the new
  // version and says so, until the person turns a page.
  const shownDoc = useRef<{ where: string; hash: string } | null>(null)
  const [replaced, setReplaced] = useState(false)
  useEffect(() => setReplaced(false), [where])
  const turn = (to: number) => {
    setReplaced(false)
    setPage(to)
  }
  useEffect(() => {
    const ctrl = new AbortController()
    let url: string | undefined
    setShown(null); setReason(null)
    const asked = source.kind === 'team'
      ? api.call(API.hwpPreview, { query: { path: source.path, page }, signal: ctrl.signal })
      : api.call(API.roomFileHwpPreview, { params: { id: source.roomId, fileId: source.fileId }, query: { page }, signal: ctrl.signal })
    asked.then(r => {
      if (ctrl.signal.aborted) return
      const before = shownDoc.current?.where === where ? shownDoc.current.hash : null
      shownDoc.current = { where, hash: r.sourceHash }
      if (before !== null && before !== r.sourceHash) {
        setReplaced(true)
        // page 1 of the new version comes next (this effect again)
        if (page !== 1) return setPage(1)
      }
      const bytes = Uint8Array.from(atob(r.png), c => c.charCodeAt(0))
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      setShown({ url, meta: r })
    }).catch(e => {
      if (ctrl.signal.aborted) return
      if (isApiError(e, 'unavailable') && e.body.params?.reason === 'quarantined') { setHeld(e.message); setReason('quarantined'); return }
      const parsed = HwpReason.safeParse(isApiError(e) ? e.body.params?.reason : undefined)
      setFromServer(parsed.success)
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
    {hwpCanRetry(reason, fromServer) && <Button variant="secondary" onClick={() => retry(n => n + 1)} data-testid="preview-unsupported-retry">{t('common.retry')}</Button>}
  </div>
  return <section className="flex flex-col gap-3 p-3" data-testid="hwp-view" aria-label={t('hwp.viewer')}>
    <nav className="flex flex-wrap items-center justify-center gap-3" aria-label={t('hwp.pages')}>
      <Button variant="secondary" disabled={page <= 1 || !shown} onClick={() => turn(page - 1)} data-testid="hwp-previous">{t('hwp.previous')}</Button>
      <span role="status">{shown ? t('hwp.page', { page, count: shown.meta.pageCount }) : t('common.loading')}</span>
      <Button variant="secondary" disabled={!shown || page >= shown.meta.pageCount} onClick={() => turn(page + 1)} data-testid="hwp-next">{t('hwp.next')}</Button>
    </nav>
    {replaced && <p className="text-center text-sm text-warn" role="status" data-testid="hwp-replaced">{t('hwp.replaced')}</p>}
    {shown && <>
      <p className="text-xs text-muted">{t('hwp.limitations')}</p>
      <img src={shown.url} width={shown.meta.width} height={shown.meta.height} alt={t('hwp.page', { page, count: shown.meta.pageCount })} className="mx-auto h-auto max-w-full bg-white shadow-sm" data-testid="hwp-page" />
    </>}
  </section>
}
