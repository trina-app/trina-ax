// The auto mode pill in the AI chat's box (docs/decisions/20261125-auto-mode.md): "Ask" / "Auto". One tap changes it.
// The first tap that turns it on shows one sheet: what auto mode does, what always asks, and that each auto step has
// undo; after a yes there, later taps change it at once. Shown only while the team lets this person use it
// (Me.team.autoMode: never for a guest, never with the team value off), and not in a confidential chat. The server
// keeps the value (PUT /api/ai-allowances/auto-mode) and decides every card; this pill only shows and changes it.
import clsx from 'clsx'
import { Zap } from 'lucide-react'
import { useState } from 'react'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useMe, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { confirmDialog } from '../ui'

/** this browser already showed the first-use sheet (a per-viewer convenience: without it, the sheet shows again) */
const SEEN_KEY = 'autoMode.introSeen'
const seen = (): boolean => { try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false } }
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1') } catch { /* private window: asked again next time */ } }

export function AutoModePill({ hidden }: { hidden?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const [busy, setBusy] = useState(false)
  if (hidden || !me?.team?.autoMode) return null
  const on = me.user?.autoMode === true
  const change = async () => {
    if (busy) return
    if (!on && !seen()) {
      const yes = await confirmDialog({
        title: t('autoMode.intro.title'),
        body: (
          <div className="space-y-2 text-sm" data-testid="auto-mode-intro">
            <p>{t('autoMode.intro.what')}</p>
            <p>{t('autoMode.intro.floor')}</p>
            <p>{t('autoMode.intro.undo')}</p>
          </div>
        ),
        confirm: t('autoMode.intro.turnOn'),
      })
      if (!yes) return
      markSeen()
    }
    setBusy(true)
    try {
      await api.call(API.setAutoMode, { body: { on: !on, via: 'pill' } })
      await useSession.getState().refreshMe()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally { setBusy(false) }
  }
  return (
    <button
      type="button"
      onClick={() => void change()}
      aria-pressed={on}
      aria-label={on ? t('autoMode.pill.onLabel') : t('autoMode.pill.offLabel')}
      title={on ? t('autoMode.pill.onLabel') : t('autoMode.pill.offLabel')}
      disabled={busy}
      className={clsx('touch-hit inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition',
        on ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:text-ink', busy && 'opacity-60')}
      data-testid="auto-mode-pill"
    >
      <Zap size={13} aria-hidden />
      <span>{on ? t('autoMode.pill.auto') : t('autoMode.pill.ask')}</span>
    </button>
  )
}
