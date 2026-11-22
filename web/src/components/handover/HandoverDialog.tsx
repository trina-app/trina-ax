// 팀장 넘기기: the one confirm (docs/DECISIONS.md "W6"), opened from Home's card, its Inbox notice and Admin › Members'
// ··· menu. It says who gets the role (the owner's own words for the lead link, or the account's name and username),
// what moves with it, lists the connections made with my own accounts (each kept for the team unless I tick its
// "Disconnect when I hand over", QA TC-3095) and who can still reset passwords outside the app, then asks for my password
// again, or without one a Google check (POST /api/admin/transfer-ownership, owner-reauth). A race (the owner changed
// meanwhile, 409 owner_changed, or my role is gone already) closes it with "이미 팀장이 바뀌었어요". The names are text
// only, never markup.
import { useEffect, useState } from 'react'
import type { HandoverConnection, HandoverRecovery } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useSession } from '../../store/session'
import { markTransferredHere, useHandover } from '../../store/handover'
import { toast } from '../../store/ui'
import { Button, Modal, Skeleton } from '../ui'
import { ReauthInput, useReauth } from '../../pages/admin/common'
import { isolate } from './isolate'

export interface HandoverTarget { id: string; name: string; username: string }
type T = ReturnType<typeof useT>

const connKey = (c: Pick<HandoverConnection, 'kind' | 'id'>) => `${c.kind}:${c.id}`

/** One connection's line: "팀 AI '…' (내 Claude 계정)", "드라이브 공유 '…' (내 구글 계정)", "팀 연결 '…' (내 계정으로 로그인)". */
export function connectionLine(t: T, c: Pick<HandoverConnection, 'kind' | 'provider' | 'label'>): string {
  const key: MessageKey = c.kind === 'drive_share' ? 'handover.conn.drive' : c.kind === 'team_connection' ? 'handover.conn.service' : c.provider === 'chatgpt' ? 'handover.conn.chatgpt' : 'handover.conn.claude'
  return t(key, { label: c.label })
}

/** Who can still set an owner's or admin's password outside the app, as the dialog says it. */
export const recoveryLine = (t: T, r: HandoverRecovery): string => t(`handover.recovery.${r}`)

export interface HandoverViewProps {
  target: HandoverTarget
  /** the owner's own words for whom the lead link was ("받는 사람: …"); without it, the account's name and username */
  leadFor?: string | null
  /** null while they load */
  connections: HandoverConnection[] | null
  /** the list could not be read: the transfer still works, the line says where to end them later */
  failed?: boolean
  recovery: HandoverRecovery | null
  /** the connections I ticked to disconnect at the transfer; every other one is kept (the default) */
  ending: ReadonlySet<string>
  onToggle: (c: HandoverConnection) => void
}

/** The dialog's lines, without loading or sending (tests render it as it is). */
export function HandoverView({ target, leadFor, connections, failed, recovery, ending, onToggle }: HandoverViewProps) {
  const t = useT()
  const locale = useLocale()
  const name = target.name
  return (
    <div className="space-y-4 text-sm" data-testid="handover-view">
      <div className="space-y-2">
        <p className="text-ink" data-testid="handover-check">
          {leadFor ? isolate(locale, 'handover.checkLead', { leadFor }, ['leadFor']) : isolate(locale, 'handover.checkUser', { name, username: target.username }, ['name', 'username'])}
        </p>
        <p className="text-muted" data-testid="handover-moves">{isolate(locale, 'handover.moves', { name }, ['name'])}</p>
      </div>
      {connections === null && !failed && <Skeleton lines={2} />}
      {failed && <p className="text-label text-muted" data-testid="handover-connections-failed">{t('handover.connectionsFailed')}</p>}
      {!!connections?.length && (
        <fieldset data-testid="handover-connections">
          <legend className="mb-1.5 text-label text-muted">{isolate(locale, 'handover.connections', { name }, ['name'])}</legend>
          <ul className="divide-y divide-line">
            {connections.map((c) => {
              // kept unless I ask: the box is the action ("Disconnect when I hand over"), never a "kept" box left unticked
              const on = ending.has(connKey(c))
              const id = `handover-conn-line-${c.kind}-${c.id}`
              return (
                <li key={connKey(c)} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4" data-testid={`handover-row-${c.kind}-${c.id}`} data-ending={on || undefined}>
                  <span className="min-w-0 flex-1" id={id}>
                    <span className="block text-ink">{connectionLine(t, c)}</span>
                    <span className={on ? 'block text-label text-danger' : 'block text-label text-muted'} data-testid={`handover-status-${c.kind}-${c.id}`}>{t(on ? 'handover.conn.willEnd' : 'handover.conn.kept')}</span>
                  </span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-2 text-label text-ink max-md:min-h-11">
                    <input type="checkbox" className="size-4 shrink-0" checked={on} onChange={() => onToggle(c)} aria-describedby={id} data-testid={`handover-conn-${c.kind}-${c.id}`} />
                    {t('handover.conn.endToggle')}
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
      )}
      {recovery && <p className="text-label leading-5 text-muted" data-testid="handover-recovery" data-recovery={recovery}>{recoveryLine(t, recovery)}</p>}
    </div>
  )
}

/** Why the transfer did not go through, as the dialog handles it: the role moved meanwhile (close it), or a line under
 * the password field. Exported for its test. */
export function transferRefusal(e: unknown): 'owner_changed' | 'not_ready' | 'rate_limited' | 'other' {
  // a 409 for a race (the owner changed meanwhile), a target not ready yet, or one disabled meanwhile (no reason: the
  // server's own words)
  if (isApiError(e, 'conflict')) return e.body.params?.reason === 'owner_changed' ? 'owner_changed' : e.body.params?.reason === 'target_not_ready' ? 'not_ready' : 'other'
  // the route refuses a caller who is no owner any more (another tab handed it over) before it reads the password; a
  // wrong password is a 403 about that field
  if (isApiError(e, 'forbidden') && !e.body.fields?.['body.password'] && !e.body.fields?.['body.reauthFlow']) return 'owner_changed'
  if (isApiError(e, 'rate_limited')) return 'rate_limited'
  return 'other'
}

export function HandoverDialog({ target, leadFor, onClose, onDone }: { target: HandoverTarget; leadFor?: string | null; onClose: () => void; onDone?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const state = useHandover((s) => s.state)
  const [read, setRead] = useState<'loading' | 'done' | 'failed'>('loading')
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set())
  const r = useReauth()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    // the connections as they are now (made or ended since the page loaded)
    useHandover.getState().load(true).then(() => live && setRead('done'), () => live && setRead('failed'))
    return () => { live = false }
  }, [])
  const connections = read === 'done' ? (state?.connections ?? []) : null
  const toggle = (c: HandoverConnection) => setEnding((s) => {
    const next = new Set(s)
    if (!next.delete(connKey(c))) next.add(connKey(c))
    return next
  })
  const submit = () => {
    if (!r.ready || busy || read === 'loading') return
    // in the press: for an account without a password this opens the Google window
    const proof = r.proof()
    setBusy(true)
    // only what I ticked is ended; nothing ticked keeps everything (the server's default too: no `end` = keep)
    const end = (connections ?? []).filter((c) => ending.has(connKey(c))).map((c) => ({ kind: c.kind, id: c.id }))
    void (async () => {
      const p = await proof
      if (!p) { setBusy(false); return }
      try {
        const res = await api.call(API.transferOwnership, { body: { userId: target.id, ...p, end } })
        markTransferredHere()
        const failed = res.ended?.some((x) => x.result === 'failed')
        toast({ level: 'success', text: t('handover.done', { name: target.name }), ...(failed ? { detail: t('handover.doneFailed') } : {}) })
        onClose()
        onDone?.()
        // I am an admin now: the owner-only screens and controls go away, and so does the card
        await useSession.getState().refreshMe()
        void useHandover.getState().load(true).catch(() => {})
      } catch (e) {
        setBusy(false)
        const why = transferRefusal(e)
        if (why === 'owner_changed') {
          toast({ level: 'info', text: t('handover.ownerChanged') })
          onClose()
          void useSession.getState().refreshMe().then(() => useHandover.getState().load(true)).catch(() => {})
          return
        }
        r.setError(why === 'not_ready' ? t('handover.notReady') : why === 'rate_limited' ? t('handover.rateLimited') : errorText(e, locale, t('error.network')))
      }
    })()
  }
  const close = () => { r.cancel(); onClose() }
  return (
    <Modal
      open
      onClose={close}
      title={t('handover.title', { name: target.name })}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" busy={busy} disabled={!r.ready || read === 'loading'} onClick={submit} data-testid="handover-submit">
            {t('handover.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="handover-dialog">
        <HandoverView target={target} leadFor={leadFor} connections={connections} failed={read === 'failed'} recovery={state?.recovery ?? null} ending={ending} onToggle={toggle} />
        {/* my password again, or without one a Google check (pages/admin/common.tsx useReauth) */}
        <ReauthInput r={r} testId="handover-password" onEnter={submit} />
      </div>
    </Modal>
  )
}
