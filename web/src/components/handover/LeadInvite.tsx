// "이 사람이 팀장이에요" on an invite (docs/DECISIONS.md "W6"; shared/src/api/admin.ts CreateInviteBody.leadFor): the
// owner says who the link is for, and the server makes one single-use link that only ever makes a member in the team
// group, for 3 days; the one before it stops working. The message then is the one-person message (who set the team up,
// that they hand it over once the person joins). Used by the welcome steps' invite step (LeadInvite around the team
// link panel) and by Admin › Members' invite dialog (LeadFlag, LeadMessage). Only for the owner, and only where the
// server offers it (HandoverState.flag: not on a hosted team without its safety switch).
import { Check, Copy, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cleanLeadFor, LEAD_FOR_MAX, LEAD_INVITE_HOURS, type Invite } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { useHandover } from '../../store/handover'
import { Button, Field, inputCls, useCopy } from '../ui'
import { useAction, useActionOk } from '../../pages/admin/common'

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

type Made = { id: string; url: string; leadFor: string; expiresAt: string; replaced: boolean }
const madeOf = (r: { invite: Invite; url: string; replacedLead?: boolean }): Made => ({ id: r.invite.id, url: absoluteUrl(r.url), leadFor: r.invite.leadFor ?? '', expiresAt: r.invite.expiresAt, replaced: !!r.replacedLead })

/**
 * The welcome steps' invite step with the flag on top (`enabled`; the owner, where the server offers it): unticked, the
 * team link panel as it is (`children`); ticked, "누구에게 보내나요?" and [팀장 링크 만들기], then the one-person message
 * in place of the team link's. Unticking revokes the lead link unless it was copied in this visit (a copied one stays,
 * Admin › Members lists it); ticking again in the same visit shows the kept one. A lead link made earlier (its address
 * is not known now) is one quiet line; ticking makes a new one.
 */
export function LeadInvite({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const t = useT()
  const locale = useLocale()
  const offered = useLeadOffered(enabled)
  const act = useAction()
  const actOk = useActionOk()
  const openLead = useHandover((s) => s.state?.openLead ?? null)
  const [ticked, setTicked] = useState(false)
  const [label, setLabel] = useState('')
  const [made, setMade] = useState<Made | null>(null)
  const [busy, setBusy] = useState(false)
  const copied = useRef(false)
  if (!offered) return <>{children}</>
  const clean = cleanLeadFor(label)
  const create = async () => {
    if (!clean || busy) return
    setBusy(true)
    const r = await act(() => api.call(API.createInvite, { body: { leadFor: clean } }))
    setBusy(false)
    if (!r) return
    copied.current = false
    setMade(madeOf(r))
    void useHandover.getState().load(true).catch(() => {})
  }
  const tick = async (on: boolean) => {
    setTicked(on)
    if (on || !made || copied.current) return
    // never sent: it stops working; the label stays for a tick again
    const m = made
    setMade(null)
    if (await actOk(() => api.call(API.revokeInvite, { params: { id: m.id } }))) void useHandover.getState().load(true).catch(() => {})
  }
  return (
    <div className="space-y-4" data-testid="lead-invite">
      <LeadFlag checked={ticked} onChecked={(v) => void tick(v)} label={label} onLabel={setLabel} locked={!!made} />
      {openLead && !(ticked && made) && (
        <p className="text-label text-muted" data-testid="lead-open">{t('handover.openLead', { leadFor: openLead.leadFor, date: formatDateTime(openLead.expiresAt, locale) })}</p>
      )}
      {!ticked ? (
        children
      ) : made ? (
        <LeadMessage url={made.url} leadFor={made.leadFor} expiresAt={made.expiresAt} replaced={made.replaced} onCopied={() => { copied.current = true }} />
      ) : (
        <div className="space-y-3 pl-6.5">
          <p className="text-xs text-muted" data-testid="lead-note">{t('handover.leadNote', { days: LEAD_DAYS })}</p>
          <Button variant="primary" className="max-sm:w-full" busy={busy} disabled={!clean} onClick={() => void create()} data-testid="lead-create">
            <Plus size={14} aria-hidden /> {t('handover.makeLink')}
          </Button>
        </div>
      )}
    </div>
  )
}
