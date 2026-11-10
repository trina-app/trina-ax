// 팀장 넘기기: the one confirm (docs/DECISIONS.md "W6"), opened from Home's card, its Inbox notice and Admin › Members'
// ··· menu. It says who gets the role (the owner's own words for the lead link, or the account's name and username),
// what moves with it, lists the connections made with my own accounts (each ticked: ended at the transfer; unticked:
// kept, a company seat) and who can still reset passwords outside the app, then asks for my password again
// (POST /api/admin/transfer-ownership, owner-reauth). A race (the owner changed meanwhile, 409 owner_changed, or my role
// is gone already) closes it with "이미 팀장이 바뀌었어요". The names are text only, never markup.
import { useEffect, useState } from 'react'
import type { HandoverConnection, HandoverRecovery } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useSession } from '../../store/session'
import { markTransferredHere, useHandover } from '../../store/handover'
import { toast } from '../../store/ui'
import { Button, Field, Modal, Skeleton, inputCls } from '../ui'
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
  /** the connections left unticked (kept) */
  kept: ReadonlySet<string>
  onToggle: (c: HandoverConnection) => void
}

/** The dialog's lines, without loading or sending (tests render it as it is). */
export function HandoverView({ target, leadFor, connections, failed, recovery, kept, onToggle }: HandoverViewProps) {
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
          <ul className="space-y-0.5">
            {connections.map((c) => {
              const on = !kept.has(connKey(c))
              return (
                <li key={connKey(c)}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg py-1.5 text-sm">
                    <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={on} onChange={() => onToggle(c)} data-testid={`handover-conn-${c.kind}-${c.id}`} />
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">{connectionLine(t, c)}</span>
                      <span className="text-muted"> · {t(on ? 'handover.conn.ends' : 'handover.conn.keeps')}</span>
                    </span>
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
  if (isApiError(e, 'forbidden') && !e.body.fields?.['body.password']) return 'owner_changed'
  if (isApiError(e, 'rate_limited')) return 'rate_limited'
  return 'other'
}

export function HandoverDialog({ target, leadFor, onClose, onDone }: { target: HandoverTarget; leadFor?: string | null; onClose: () => void; onDone?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const state = useHandover((s) => s.state)
  const [read, setRead] = useState<'loading' | 'done' | 'failed'>('loading')
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set())
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    // the connections as they are now (made or ended since the page loaded)
    useHandover.getState().load(true).then(() => live && setRead('done'), () => live && setRead('failed'))
    return () => { live = false }
  }, [])
  const connections = read === 'done' ? (state?.connections ?? []) : null
  const toggle = (c: HandoverConnection) => setKept((s) => {
    const next = new Set(s)
    if (!next.delete(connKey(c))) next.add(connKey(c))
    return next
  })
  const submit = async () => {
    if (!password || busy || read === 'loading') return
    setBusy(true)
    setError(null)
    const end = (connections ?? []).filter((c) => !kept.has(connKey(c))).map((c) => ({ kind: c.kind, id: c.id }))
    try {
      const r = await api.call(API.transferOwnership, { body: { userId: target.id, password, end } })
      markTransferredHere()
      const failed = r.ended?.some((x) => x.result === 'failed')
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
      setError(why === 'not_ready' ? t('handover.notReady') : why === 'rate_limited' ? t('handover.rateLimited') : errorText(e, locale, t('error.network')))
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('handover.title', { name: target.name })}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" busy={busy} disabled={!password || read === 'loading'} onClick={() => void submit()} data-testid="handover-submit">
            {t('handover.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="handover-dialog">
        <HandoverView target={target} leadFor={leadFor} connections={connections} failed={read === 'failed'} recovery={state?.recovery ?? null} kept={kept} onToggle={toggle} />
        <Field label={t('system.passwordAgain')} error={error}>
          <input
            data-autofocus
            className={inputCls}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit() }}
            data-testid="handover-password"
          />
        </Field>
      </div>
    </Modal>
  )
}
