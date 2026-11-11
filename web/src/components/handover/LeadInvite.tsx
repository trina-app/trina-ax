// "이 사람이 팀장이에요" on an invite (docs/DECISIONS.md "W6"; shared/src/api/admin.ts CreateInviteBody.leadFor): the
// owner says who the link is for, and the server makes one single-use link that only ever makes a member in the team
// group, for 3 days; the one before it stops working. The message then is the one-person message (who set the team up,
// that they hand it over once the person joins). Used by Admin › Members' invite dialog (LeadFlag, LeadMessage); never
// the welcome steps' invite step (owner 2026-11-11: one team link invites many people, so "this person will be the
// owner" does not belong on it). Only for the owner, and only where the server offers it (HandoverState.flag: not on a
// hosted team without its safety switch).
import { Check, Copy } from 'lucide-react'
import { useEffect } from 'react'
import { LEAD_FOR_MAX, LEAD_INVITE_HOURS } from '@mycel/shared/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { useHandover } from '../../store/handover'
import { Button, Field, inputCls, useCopy } from '../ui'

type T = ReturnType<typeof useT>

/** An invite address as the server gave it ("/invite/…" or a full address), as one to paste. */
export const absoluteUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${location.origin}${url.startsWith('/') ? '' : '/'}${url}`)

/** The one-person message: "{name}님이 {product}에 팀을 만들어 두었어요. 들어오면 {name}님이 팀장을 넘겨 드려요: {url} · …". */
export const leadMessage = (t: T, o: { name: string; url: string }) => t('handover.message', o)

/** How many days a lead link is open (the server's 72 hours). */
export const LEAD_DAYS = LEAD_INVITE_HOURS / 24

/** The owner may flag an invite here: the owner, on a server that offers it (loads the handover state once). */
export function useLeadOffered(enabled = true): boolean {
  const owner = isOwner(useMe())
  const flag = useHandover((s) => !!s.state?.flag)
  useEffect(() => {
    if (owner && enabled) void useHandover.getState().load().catch(() => {})
  }, [owner, enabled])
  return owner && enabled && flag
}

/** The checkbox row "이 사람이 팀장이에요 · 들어오면 팀장을 넘길지 물어볼게요" and, ticked, "누구에게 보내나요?". */
export function LeadFlag({ checked, onChecked, label, onLabel, locked }: { checked: boolean; onChecked: (v: boolean) => void; label: string; onLabel: (v: string) => void; locked?: boolean }) {
  const t = useT()
  return (
    <div data-testid="lead-flag">
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={checked} onChange={(e) => onChecked(e.target.checked)} data-testid="lead-flag-check" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-ink">{t('handover.flag')}</span>
          <span className="text-muted"> · {t('handover.flagHint')}</span>
        </span>
      </label>
      {checked && !locked && (
        <div className="mt-3 pl-6.5">
          <Field label={t('handover.leadFor')}>
            <input
              data-autofocus
              className={inputCls}
              value={label}
              maxLength={LEAD_FOR_MAX}
              placeholder={t('handover.leadForPlaceholder')}
              onChange={(e) => onLabel(e.target.value)}
              data-testid="lead-for"
            />
          </Field>
        </div>
      )}
    </div>
  )
}

/** The made lead link: the message with one [메시지 복사], a quiet [링크만 복사], and one line of facts (for whom, until
 * when). `replaced`: an earlier lead link stopped working. */
export function LeadMessage({ url, leadFor, expiresAt, replaced, onCopied }: { url: string; leadFor: string; expiresAt: string; replaced?: boolean; onCopied?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const message = leadMessage(t, { name: me?.user.name ?? '', url })
  const msg = useCopy()
  const link = useCopy()
  return (
    <div className="space-y-3" data-testid="lead-link">
      {replaced && <p className="text-xs text-warn" data-testid="lead-replaced">{t('handover.replaced')}</p>}
      <div>
        <p className="text-xs font-medium text-muted">{t('teamLink.messagePreview')}</p>
        <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm leading-6 break-words whitespace-pre-wrap text-ink" data-testid="lead-message">
          {message}
        </blockquote>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="primary" className="mr-1 max-sm:w-full" onClick={() => { void msg.copy(message); onCopied?.() }} data-testid="lead-copy-message">
          {msg.copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {msg.copied ? t('common.copied') : t('teamLink.copyMessage')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { void link.copy(url); onCopied?.() }} data-testid="lead-copy-link">
          {link.copied ? <Check size={14} className="text-ok" aria-hidden /> : <Copy size={14} aria-hidden />} {link.copied ? t('common.copied') : t('teamLink.copyLink')}
        </Button>
      </div>
      <p className="text-label text-muted" data-testid="lead-facts">{t('handover.facts', { leadFor, date: formatDateTime(expiresAt, locale) })}</p>
    </div>
  )
}
