// Home's top slot for the owner when someone joined with their lead link (docs/DECISIONS.md "W6"): the owner's own words
// for whom the link was, beside the account's name, username and join time (facts the joiner cannot set), "팀장을
// 넘길까요?", one [넘기기] (the confirm, from this server-held card, never from an address) and ✕ (hides the card; the
// Inbox notice stays). While it shows it is the one thing at the top of Home (Home.tsx); on a phone the first quiet row
// under the box. Shown only while it holds (GET /api/admin/handover `card`: I flagged it, I am still the owner, they
// are active) and the server offers the flag.
import clsx from 'clsx'
import { Crown, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { LeadCard, Locale } from '@mycel/shared/api'
import { formatShortDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { useHandover } from '../../store/handover'
import { toast } from '../../store/ui'
import { Button, IconButton, useMediaQuery } from '../ui'
import { HandoverDialog } from './HandoverDialog'
import { isolate } from './isolate'

type T = ReturnType<typeof useT>

/** "{leadFor}에게 보낸 팀장 링크로 '{name}'(아이디 {username})님이 {time}에 들어왔어요" (the card and its Inbox notice). */
type Joined = { leadFor: string; user: { name: string; username: string }; joinedAt: string }
const joinedParams = (locale: Locale, o: Joined) => ({ leadFor: o.leadFor, name: o.user.name, username: o.user.username, time: formatShortDateTime(o.joinedAt, locale) })
export const joinedText = (t: T, locale: Locale, o: Joined) => t('handover.joined', joinedParams(locale, o))
/** The same as shown: the owner's words, the name and the username each in <bdi> (isolate.tsx). */
export const joinedNode = (locale: Locale, o: Joined): ReactNode => isolate(locale, 'handover.joined', joinedParams(locale, o), ['leadFor', 'name', 'username'])

/** The card while it should show (`enabled`: the owner on Home itself), else null. Loads the handover state once. */
export function useLeadCard(enabled: boolean): LeadCard | null {
  const owner = isOwner(useMe())
  const state = useHandover((s) => s.state)
  useEffect(() => {
    if (owner && enabled) void useHandover.getState().load().catch(() => {})
  }, [owner, enabled])
  if (!owner || !enabled || !state?.flag || !state.card || state.card.dismissed) return null
  return state.card
}

export function HandoverCard({ card }: { card: LeadCard }) {
  const t = useT()
  const locale = useLocale()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [open, setOpen] = useState(false)
  const close = () => void useHandover.getState().dismiss().catch(() => toast({ level: 'error', text: t('error.network') }))
  return (
    // a computer: one quiet framed row above the greeting (like the goal card); a phone: no frame, under the box
    <section className={clsx('flex items-start gap-2.5', phone ? 'py-1.5 pl-3' : 'mb-8 rounded-2xl border border-line bg-surface py-3 pr-2 pl-4')} aria-label={t('handover.menu')} data-testid="handover-card">
      <Crown size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
      {/* the facts, and under them the question (as the sketch's two lines); the one button beside them, under them on a
          phone */}
      <div className={clsx('flex min-w-0 flex-1 gap-x-3 gap-y-2', phone ? 'flex-col items-start' : 'items-center')}>
        <p className="min-w-0 flex-1 text-sm leading-6" data-testid="handover-card-text">
          <span className="block font-medium text-ink">{joinedNode(locale, card)}</span>
          <span className="block text-muted">{t('handover.ask')}</span>
        </p>
        <div className="shrink-0">
          <Button size="sm" variant="primary" onClick={() => setOpen(true)} data-testid="handover-card-open">
            {t('handover.confirm')}
          </Button>
        </div>
      </div>
      <IconButton label={t('common.close')} onClick={close} className="touch-hit shrink-0" data-testid="handover-card-close">
        <X size={15} />
      </IconButton>
      {open && <HandoverDialog target={card.user} leadFor={card.leadFor} onClose={() => setOpen(false)} />}
    </section>
  )
}
