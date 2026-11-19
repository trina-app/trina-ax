// The quiet "Hide" of a Home onboarding card (the member welcome card, the 7-day goal, "Ready in your team"): small
// muted words, not a ✕, the same on every card (owner 2026-11-20: every Home onboarding card can be closed). On a phone
// it is a full 44px target. The goal and "Ready in your team" keep their hide in the person's preferences on the server
// (prefs.goalCard, prefs.preparedCard: the same on every device, the app and the browser alike), with an undo toast and
// a way back (HomeCardsShowAgain: Settings › Profile, and Admin › Home for the goal). The member welcome card keeps its
// own record (store/memberWelcome.ts).
import clsx from 'clsx'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useMe, useSession } from '../../store/session'
import { toast } from '../../store/ui'

export function CardHide({ onClick, label, testId, className, disabled }: { onClick: () => void; label: string; testId: string; className?: string; disabled?: boolean }) {
  const t = useT()
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} className={clsx('touch-hit shrink-0 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-60 max-md:min-h-11', className)} data-testid={testId}>
      {t('common.hide')}
    </button>
  )
}

/** The Home cards a person can hide for good, by their preference key. */
export type HomeCard = 'goalCard' | 'preparedCard'
const SHOW: Record<HomeCard, MessageKey> = { goalCard: 'homeCards.showGoal', preparedCard: 'homeCards.showPrepared' }
const HIDDEN: Record<HomeCard, MessageKey> = { goalCard: 'homeCards.hiddenGoal', preparedCard: 'homeCards.hiddenPrepared' }

/** Whether the person hid this card, and the hide (kept on the server, an undo toast that brings it back). */
export function useCardHidden(card: HomeCard): { hidden: boolean; hide: () => void } {
  const t = useT()
  const hidden = useMe()?.user.prefs?.[card] === 'hidden'
  const set = (v: 'hidden' | null) => useSession.getState().updatePrefs({ [card]: v })
  const hide = () => void set('hidden').then(
    (ok) => {
      if (!ok) return toast({ level: 'error', text: t('error.network') })
      toast({ level: 'info', text: t(HIDDEN[card]), action: { label: t('common.undo'), run: () => void set(null).catch(() => toast({ level: 'error', text: t('error.network') })) } })
    },
    () => toast({ level: 'error', text: t('error.network') }),
  )
  return { hidden, hide }
}

/** One quiet row per hidden Home card that brings it back ("Show the team goal on Home again"); nothing when none is
 * hidden. `cards`: which ones this place offers. */
export function HomeCardsShowAgain({ cards, testId = 'home-cards-show', className }: { cards: readonly HomeCard[]; testId?: string; className?: string }) {
  const t = useT()
  const prefs = useMe()?.user.prefs
  const [busy, setBusy] = useState(false)
  const hidden = cards.filter((c) => prefs?.[c] === 'hidden')
  if (!hidden.length) return null
  const show = (c: HomeCard) => {
    setBusy(true)
    void useSession.getState().updatePrefs({ [c]: null }).then(
      (ok) => toast(ok ? { level: 'success', text: t('homeCards.back') } : { level: 'error', text: t('error.network') }),
      () => toast({ level: 'error', text: t('error.network') }),
    ).finally(() => setBusy(false))
  }
  return (
    <section className={clsx('space-y-2', className)} data-testid={testId}>
      {hidden.map((c) => (
        <button key={c} type="button" disabled={busy} onClick={() => show(c)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-left text-sm hover:bg-hover disabled:opacity-60" data-testid={`${testId}-${c}`}>
          <RotateCcw size={15} className="shrink-0 text-faint" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t(SHOW[c])}</span>
        </button>
      ))}
    </section>
  )
}
