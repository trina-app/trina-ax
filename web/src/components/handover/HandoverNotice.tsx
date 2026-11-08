// The handover's Inbox rows (shared/src/api/notifications.ts InboxNotification.handover; docs/DECISIONS.md "W6"): who
// joined with my lead link (the card's words; [넘기기] while it still holds, from this notice, never from an address),
// the role moving (to me: [내보내기] for the old owner while I may, "설정 이어서 하기" while the welcome steps wait; from
// me; to someone else), what was ended at the transfer, who can still reset passwords on a hosted team, and the lock
// after too many wrong passwords. Names are text only.
import { Link } from 'react-router-dom'
import type { InboxNotification, Locale } from '@mycel/shared/api'
import { Fragment, useState, type ReactNode } from 'react'
import { api, API } from '../../lib/api'
import { formatShortDateTime } from '../../lib/format'
import { useT, type MessageKey, type Params } from '../../i18n'
import { Button, confirmDialog } from '../ui'
import { useAction } from '../../pages/admin/common'
import { toast } from '../../store/ui'
import { connectionLine, HandoverDialog } from './HandoverDialog'
import { isolate } from './isolate'

type T = ReturnType<typeof useT>
export type HandoverNote = NonNullable<InboxNotification['handover']>

/** The row's sentence, as pieces joined with " · ": each a text key, its values, and the values to isolate. */
type Piece = { key: MessageKey; params?: Params; iso?: string[] }
function noticePieces(locale: Locale, h: HandoverNote): Piece[] {
  if (h.kind === 'reauth_locked') return [{ key: 'handover.locked' }]
  if (h.kind === 'lead_joined') {
    const time = formatShortDateTime(h.joinedAt, locale)
    if (!h.user) return [{ key: 'handover.joinedGone', params: { leadFor: h.leadFor, time }, iso: ['leadFor'] }]
    return [
      { key: 'handover.joined', params: { leadFor: h.leadFor, name: h.user.name, username: h.user.username, time }, iso: ['leadFor', 'name', 'username'] },
      { key: h.open ? 'handover.ask' : 'handover.notNow' },
    ]
  }
  if (h.me === 'to') return [h.from ? { key: 'handover.toMe', params: { from: h.from.name }, iso: ['from'] } : { key: 'handover.toMeGone' }]
  if (h.me === 'from') return [h.to ? { key: 'handover.done', params: { name: h.to.name }, iso: ['name'] } : { key: 'handover.fromMeGone' }]
  return [h.to ? { key: 'handover.other', params: { to: h.to.name }, iso: ['to'] } : { key: 'handover.otherGone' }]
}

/** The row's sentence as text. */
export function handoverNoticeText(t: T, locale: Locale, h: HandoverNote): string {
  return noticePieces(locale, h).map((p) => t(p.key, p.params)).join(' · ')
}

/** The row's sentence as shown: names, usernames and the owner's words in <bdi> (isolate.tsx). */
export function handoverNoticeNode(locale: Locale, h: HandoverNote): ReactNode {
  return noticePieces(locale, h).map((p, i) => <Fragment key={i}>{i > 0 && ' · '}{isolate(locale, p.key, p.params ?? {}, p.iso ?? [])}</Fragment>)
}

/** The quiet lines under a transfer's sentence: what was ended ("끊은 연결: 팀 AI 1개 · 드라이브 공유 2개"), what could not
 * be, and (to the two people on a hosted team) who can still reset passwords. */
export function handoverNoticeLines(t: T, h: HandoverNote): string[] {
  if (h.kind !== 'transferred') return []
  const out: string[] = []
  const conns = h.ended.connections ?? 0
  const parts = [h.ended.teamAi > 0 && t('handover.endedAi', { n: h.ended.teamAi }), h.ended.driveShares > 0 && t('handover.endedDrive', { n: h.ended.driveShares }), conns > 0 && t('handover.endedConn', { n: conns })].filter((x): x is string => !!x)
  if (parts.length) out.push(t('handover.ended', { list: parts.join(' · ') }))
  // to the new owner, what is still to end has its own line with [끊기] (HandoverNoticeExtras); to anyone else the count
  if (h.ended.failed > 0 && !h.pending) out.push(t('handover.endedFailed', { n: h.ended.failed }))
  if (h.recovery === 'hosted' && h.me !== 'other') out.push(t('handover.recovery.hosted'))
  return out
}

/** The row's lines and actions under its time (Settings › 알림's Inbox). `onChanged`: read the Inbox again. */
export function HandoverNoticeExtras({ item, onRead, onChanged }: { item: InboxNotification; onRead: () => void; onChanged: () => void }) {
  const t = useT()
  const act = useAction()
  const [open, setOpen] = useState(false)
  const h = item.handover
  if (!h) return null
  const lines = handoverNoticeLines(t, h)
  const [ending, setEnding] = useState(false)
  // 아직 끊지 못한 연결 (the new owner): what the old owner asked to end and is still connected, ended from here
  const endPending = async (transferId: string) => {
    setEnding(true)
    const r = await act(() => api.call(API.endPendingConnections, { body: { transferId } }))
    setEnding(false)
    if (!r) return
    toast({ level: r.pending ? 'warn' : 'success', text: r.pending ? t('handover.pendingLeft', { n: r.pending }) : t('handover.pendingDone') })
    onChanged()
  }
  const remove = async (from: { id: string; name: string }) => {
    if (!(await confirmDialog({ title: t('handover.removeTitle', { name: from.name }), body: t('members.disableBody'), confirm: t('handover.remove'), danger: true }))) return
    onRead()
    if (await act(() => api.call(API.updateUser, { params: { id: from.id }, body: { status: 'disabled' } }), t('handover.removed', { name: from.name }))) onChanged()
  }
  return (
    <>
      {lines.map((l) => <p key={l} className="mt-1 text-xs text-muted" data-testid="handover-notice-line">{l}</p>)}
      {h.kind === 'lead_joined' && h.open && h.user && (
        <div className="mt-2">
          <Button size="sm" variant="primary" onClick={() => setOpen(true)} data-testid="handover-notice-open">{t('handover.confirm')}</Button>
          {open && <HandoverDialog target={h.user} leadFor={h.leadFor} onClose={() => setOpen(false)} onDone={() => { onRead(); onChanged() }} />}
        </div>
      )}
      {h.kind === 'transferred' && h.me === 'to' && !!h.pending?.length && (
        <div className="mt-2" data-testid="handover-notice-pending">
          <p className="text-xs text-warn">{t('handover.pending', { list: h.pending.map((p) => connectionLine(t, { kind: p.kind, label: p.label, provider: p.kind === 'drive_share' ? 'google' : p.kind === 'team_connection' ? 'service' : 'claude' })).join(' · ') })}</p>
          <Button size="sm" className="mt-1.5" busy={ending} onClick={() => void endPending(item.sourceId)} data-testid="handover-notice-end-pending">{t('handover.pendingEnd')}</Button>
        </div>
      )}
      {h.kind === 'transferred' && h.me === 'to' && (h.removable || h.setupUnfinished) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {h.removable && h.from && (
            <Button size="sm" onClick={() => void remove(h.from!)} data-testid="handover-notice-remove">{t('handover.remove')}</Button>
          )}
          {h.setupUnfinished && <Link className="text-sm text-accent-text hover:underline" to="/welcome" onClick={onRead} data-testid="handover-notice-setup">{t('handover.setup')}</Link>}
        </div>
      )}
      {/* first the devices (signing one out asks for no password, which is locked now), then the password */}
      {h.kind === 'reauth_locked' && <Link className="text-sm text-accent-text hover:underline" to="/settings/security" onClick={onRead} data-testid="handover-notice-password">{t('handover.lockedLink')}</Link>}
    </>
  )
}
