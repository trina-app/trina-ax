// Settings › 트리나에게 허용한 것: auto mode (docs/decisions/20261125-auto-mode.md). The person's own switch, and "최근 자동
// 승인": the last 50 cards auto mode approved for them (audit ai.auto_allow), each with a link to its chat (only the
// person's own chats are named; others show "a chat"). Hidden while the team does not let this person use it (the
// team value off, the team's "Always allow" off, a guest): then nothing here changes anything.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { MyAutoMode } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatMonthDay } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { Switch } from '../ui'

export function AutoModeSettings() {
  const t = useT()
  const locale = useLocale()
  const [state, setState] = useState<MyAutoMode | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.call(API.getAutoMode).then((r) => live && setState(r), () => live && setState(null))
    return () => { live = false }
  }, [])
  if (!state?.available) return null
  const change = async (on: boolean) => {
    setBusy(true)
    try {
      setState(await api.call(API.setAutoMode, { body: { on, via: 'settings' } }))
      void useSession.getState().refreshMe()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally { setBusy(false) }
  }
  return (
    <div className="mb-5" data-testid="auto-mode-settings">
      <div className="flex items-start gap-3 md:rounded-xl md:border md:border-line md:p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" id="auto-mode-title">{t('allowances.auto.title')}</p>
          <p className="mt-0.5 text-xs text-muted" id="auto-mode-desc">{t('allowances.auto.desc')}</p>
        </div>
        <Switch checked={state.on} disabled={busy} onChange={(v) => void change(v)} label={t('allowances.auto.title')} hideLabel describedBy="auto-mode-desc" testId="auto-mode-switch" />
      </div>
      <h3 className="mt-4 mb-1 text-sm font-semibold">{t('allowances.auto.recent')}</h3>
      {state.recent.length === 0 ? (
        <p className="text-sm text-muted" data-testid="auto-mode-recent-empty">{t('allowances.auto.none')}</p>
      ) : (
        <ul className="divide-y divide-line md:rounded-xl md:border md:border-line" data-testid="auto-mode-recent">
          {state.recent.map((r, i) => (
            <li key={`${r.at}-${i}`} className="py-2.5 md:px-4" data-testid="auto-mode-recent-row">
              <p className="text-sm [overflow-wrap:anywhere]">{t(`allowances.card.${r.kind}` as 'allowances.card.remember')}</p>
              <p className="mt-0.5 text-xs text-muted">
                {r.chatId && r.chatTitle !== null ? <Link className="underline" to={`/c/${r.chatId}`}>{r.chatTitle}</Link> : t('allowances.auto.someChat')} · {formatMonthDay(r.at, locale)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
