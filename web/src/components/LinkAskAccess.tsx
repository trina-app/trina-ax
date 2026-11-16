// "Ask for access" on a chat's or a project's link (QA TC-4185, TC-4186; docs/decisions/
// 20261116-chat-project-ask-access.md). Shown where the chat page (pages/Chat.tsx) or the project page (pages/Projects.tsx)
// would say "can't be opened": GET /api/link-access/:kind/:id says what this person may do, and nothing of the chat or
// project (as a file's link page, pages/FileLink.tsx):
// - open: it opens for them now (shared meanwhile, or a project they manage): the page reads it again (onOpen);
// - no_access with canAsk: "You need access", a note and [Ask for access]; after the tap the button reads "Requested"
//   with "Request sent…", and back later "You asked on Nov 16. Waiting for an answer.";
// - no_access because it can never be shared (a chat of a personal project, a scheduled run's…): one line, no button;
// - anything else (unknown, a guest, a failed read): the page's own not-found (`fallback`).
import { Lock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { FILE_REQUEST_NOTE_MAX, type AccessKind, type LinkAccessView } from '@mycel/shared/api'
import { api, API, ApiError, errorText } from '../lib/api'
import { formatDate } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { Button, Skeleton, inputCls } from './ui'

export function LinkAskAccess({ kind, id, onOpen, fallback }: { kind: AccessKind; id: string; onOpen: () => void; fallback: ReactNode }) {
  const [view, setView] = useState<LinkAccessView | 'failed' | null>(null)
  useEffect(() => {
    let live = true
    setView(null)
    api.call(API.linkAccess, { params: { kind, id } }).then((v) => { if (live) setView(v) }, () => { if (live) setView('failed') })
    return () => { live = false }
  }, [kind, id])
  useEffect(() => {
    if (view !== null && view !== 'failed' && view.status === 'open') onOpen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  if (view === null) return <Card testId="link-access-loading"><Skeleton lines={3} className="w-full" /></Card>
  if (view === 'failed' || view.status !== 'no_access') return <>{fallback}</>
  if (view.why === 'not_shareable') return <NotShareable kind={kind} />
  if (!view.canAsk) return <>{fallback}</>
  return <AskCard kind={kind} id={id} askedAt={view.askedAt} onOpen={onOpen} />
}

/** the card in the middle of the page (a phone: the whole width, the page's gutter), as a file's link page */
function Card({ children, testId, kind }: { children: ReactNode; testId: string; kind?: AccessKind }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-12" data-testid="link-access-page">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center" data-testid={testId} data-kind={kind}>
        {children}
      </div>
    </div>
  )
}

function NotShareable({ kind }: { kind: AccessKind }) {
  const t = useT()
  return (
    <Card testId="link-access-not-shareable" kind={kind}>
      <Lock size={28} className="text-faint" aria-hidden />
      <p className="text-title-sm font-semibold text-ink">{t('linkAccess.needAccess')}</p>
      <p className="text-sm break-keep text-muted" data-testid="link-access-not-shareable-line">{t(kind === 'chat' ? 'linkAccess.chatNotShareable' : 'linkAccess.projectNotShareable')}</p>
    </Card>
  )
}

function AskCard({ kind, id, askedAt: asked, onOpen }: { kind: AccessKind; id: string; askedAt: string | null; onOpen: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [askedAt, setAskedAt] = useState(asked)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.requestLinkAccess, { params: { kind, id }, body: note.trim() ? { message: note.trim() } : {} })
      // shared meanwhile: the page reads it again
      if (r.status === 'open') { onOpen(); return }
      setAskedAt(r.askedAt)
      setSent(r.status === 'sent')
    } catch (e) {
      // too many asks (429), no longer possible (403): the server's words
      setError(e instanceof ApiError ? errorText(e, locale, t('error.network')) : t('error.network'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card testId="link-access-ask" kind={kind}>
      <Lock size={28} className="text-faint" aria-hidden />
      <p className="text-title-sm font-semibold text-ink">{t('linkAccess.needAccess')}</p>
      {askedAt ? (
        <>
          <p role="status" className="text-sm break-keep text-muted" data-testid={sent ? 'link-access-sent' : 'link-access-waiting'}>
            {sent ? t('linkAccess.sent') : t('linkAccess.asked', { date: formatDate(askedAt, locale) })}
          </p>
          <Button variant="secondary" disabled className="max-sm:w-full" data-testid="link-access-ask-button" data-state="requested">{t('linkAccess.requested')}</Button>
        </>
      ) : (
        <>
          <p className="text-sm break-keep text-muted">{t(kind === 'chat' ? 'linkAccess.chatBody' : 'linkAccess.projectBody')}</p>
          <textarea
            className={`${inputCls} mt-1 h-auto min-h-20 resize-y py-2 text-left max-md:resize-none`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={FILE_REQUEST_NOTE_MAX}
            placeholder={t('linkAccess.note')}
            aria-label={t('linkAccess.note')}
            data-testid="link-access-note"
          />
          {error && <p role="alert" className="text-sm break-keep text-danger" data-testid="link-access-error">{error}</p>}
          <Button variant="primary" busy={busy} onClick={() => void ask()} className="max-sm:w-full" data-testid="link-access-ask-button" data-state="ask">{t('linkAccess.ask')}</Button>
        </>
      )}
    </Card>
  )
}
