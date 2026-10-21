// Admin > System in office mode (docs/OFFICE.md "자동 업데이트"): the installation's automatic updates. The server
// Mac's update agent does the work (it restarts this server); this card shows its state, polls while it runs, and has
// two buttons: update now (the password again) and automatic updates off / on. When the run it watched ends it says how
// and, after an update, loads the new version's page (the page also reconnects and reloads by itself once the server
// answers with a new version).
import { Download, PauseCircle, PlayCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { OfficeUpdateStatus } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { Button, Field, Modal, inputCls } from '../../components/ui'
import { finishedRun } from '../../lib/officeUpdate'
import { toast } from '../../store/ui'
import { Card, useAction } from './common'

export default function OfficeUpdate({ status, reload }: { status: OfficeUpdateStatus; reload: () => Promise<void> }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pw, setPw] = useState('')
  const u = status
  const active = !!u.running || u.requested
  // the run this page watched has ended: say how, and after an update load the new version's page
  const before = useRef<OfficeUpdateStatus | null>(null)
  useEffect(() => {
    const done = finishedRun(before.current, u)
    before.current = u
    if (done === 'updated') {
      toast({ level: 'success', text: t('officeUpdate.result.updated', { version: u.current }), sticky: true })
      setTimeout(() => location.reload(), 2500)
    } else if (done) toast({ level: 'error', text: t(`officeUpdate.result.${done}` as MessageKey, { version: u.last?.version ?? '' }), sticky: true })
  }, [u, t])
  // while an update runs (and the server restarts under it) look again every few seconds
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => void reload().catch(() => {}), 3000)
    return () => clearInterval(id)
  }, [active, reload])

  const result = u.last && u.last.kind !== 'available' ? t(`officeUpdate.result.${u.last.kind}` as MessageKey, { version: u.last.version ?? '' }) : null
  return (
    <Card title={t('officeUpdate.title')}>
      <div className="space-y-2 text-sm" data-testid="office-update">
        <p>
          {t('officeUpdate.current', { version: u.current })} · {t(u.channel === 'beta' ? 'teamSettings.beta' : 'teamSettings.stable')}
        </p>
        {!u.agentInstalled ? (
          <p className="text-warn">{t('officeUpdate.noAgent')}</p>
        ) : u.paused ? (
          <p className="text-muted">{t('officeUpdate.paused')}</p>
        ) : (
          <p className="text-muted">{t('officeUpdate.schedule', { time: u.time, date: formatDateTime(u.nextWindowAt, locale) })}</p>
        )}
        {u.lastCheckAt && (
          <p className="text-xs text-faint">
            {t('officeUpdate.lastCheck', { date: formatDateTime(u.lastCheckAt, locale) })}
            {result && ` · ${result}`}
          </p>
        )}
        {u.available && !active && (
          <div className="rounded-lg border border-line p-3">
            <p className="font-medium">{t('officeUpdate.available', { version: u.available.version })}</p>
            {u.available.notes && <p className="mt-1 text-xs whitespace-pre-wrap text-muted">{u.available.notes}</p>}
          </div>
        )}
        {u.lastUpdate && (
          <p className={u.lastUpdate.result === 'updated' ? 'text-xs text-faint' : 'text-xs text-warn'}>
            {t('officeUpdate.lastUpdate', { from: u.lastUpdate.from, to: u.lastUpdate.to, date: formatDateTime(u.lastUpdate.at, locale) })}
            {u.lastUpdate.result !== 'updated' && ` · ${t(`officeUpdate.result.${u.lastUpdate.result}` as MessageKey, { version: u.lastUpdate.to })}`}
          </p>
        )}
        {u.desktop && <p className="text-xs text-faint">{t('officeUpdate.desktop', { version: u.desktop.version })}</p>}
        {active && (
          <div className="rounded-lg bg-subtle px-3 py-2 text-xs" role="status">
            <span className="font-medium">{u.running ? t('officeUpdate.running', { step: t(`officeUpdate.step.${u.running.step}` as MessageKey) }) : t('officeUpdate.requested')}</span>
            <p className="mt-1 text-muted">{t('officeUpdate.restartNote')}</p>
          </div>
        )}
        {u.agentInstalled && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" size="sm" disabled={active} onClick={() => setAsk(true)}>
              <Download size={14} aria-hidden /> {t('officeUpdate.now')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              busy={busy}
              onClick={async () => {
                setBusy(true)
                await act(() => api.call(API.officeUpdateAction, { body: { action: u.paused ? 'resume' : 'pause' } }), t(u.paused ? 'officeUpdate.resumed.done' : 'officeUpdate.paused.done'))
                await reload()
                setBusy(false)
              }}
            >
              {u.paused ? <PlayCircle size={14} aria-hidden /> : <PauseCircle size={14} aria-hidden />} {t(u.paused ? 'officeUpdate.resume' : 'officeUpdate.pause')}
            </Button>
          </div>
        )}
      </div>
      {ask && (
        <Modal
          open
          onClose={() => setAsk(false)}
          title={t('officeUpdate.confirmTitle')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsk(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={!pw}
                onClick={async () => {
                  setBusy(true)
                  const r = await act(() => api.call(API.officeUpdateAction, { body: { action: 'now', password: pw } }))
                  setBusy(false)
                  if (!r) return
                  setAsk(false)
                  setPw('')
                  await reload()
                }}
              >
                {t('officeUpdate.now')}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-muted">{t('officeUpdate.confirmBody')}</p>
          <Field label={t('system.passwordAgain')}>
            <input data-autofocus className={inputCls} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
        </Modal>
      )}
    </Card>
  )
}
