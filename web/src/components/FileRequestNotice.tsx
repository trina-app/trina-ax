// Under an access request in Activity (QA TC-3093, 'file.access_requested'): the asker's note as plain text, and while
// it waits and I may share the file, Share / Decline in the row (the handover notice's pattern,
// components/handover/HandoverNotice.tsx), with one line above them on what Share does: only this file, for that person,
// and, when the server says so (`outside`), that they are not in its project so its other files stay hidden (QA TC-7231).
// After: what was done; the file gone meanwhile: that, without buttons.
import { useState } from 'react'
import type { InboxNotification } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { Button } from './ui'

/** What Share on a waiting request does, in one line: the person who would get it (`for` when someone asked for them). */
export function requestWhat(t: ReturnType<typeof useT>, f: NonNullable<InboxNotification['fileShare']>): string {
  const name = f.for ?? f.by ?? ''
  return t(f.outside === 'project' ? 'fileRequest.whatProject' : 'fileRequest.what', { name })
}

export function FileRequestExtras({ item, onRead, onChanged }: { item: InboxNotification; onRead: () => void; onChanged: () => void }) {
  const t = useT()
  const locale = useLocale()
  const f = item.fileShare
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const [state, setState] = useState(f?.state)
  if (!f || item.code !== 'file.access_requested') return null
  const answer = async (a: 'approve' | 'decline') => {
    if (!f.requestId) return
    setBusy(a)
    try {
      const r = await api.call(API.answerFileRequest, { params: { id: f.requestId }, body: { answer: a } })
      setState(r.state)
      onRead()
      onChanged()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }
  const gone = f.gone || state === 'closed'
  const done = state === 'approved' ? (f.for ? t('fileRequest.approvedFor', { for: f.for }) : t('fileRequest.approved', { by: f.by ?? '' })) : state === 'declined' ? t('fileRequest.declined') : gone ? t('fileRequest.gone') : null
  return (
    <div className="mt-1 space-y-2" data-testid="file-request" data-state={gone ? 'closed' : state}>
      {f.note && !gone && <p className="text-sm break-words whitespace-pre-wrap text-muted" data-testid="file-request-note">“{f.note}”</p>}
      {done ? (
        <p className="text-xs text-muted" data-testid="file-request-done">{done}</p>
      ) : state === 'pending' && f.canAnswer ? (
        <>
          <p className="text-xs break-keep text-muted" data-testid="file-request-what" data-outside={f.outside ?? undefined}>{requestWhat(t, f)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" busy={busy === 'approve'} disabled={!!busy} onClick={() => void answer('approve')} data-testid="file-request-share">{t('fileRequest.shareFile')}</Button>
            <Button size="sm" busy={busy === 'decline'} disabled={!!busy} onClick={() => void answer('decline')} data-testid="file-request-decline">{t('fileRequest.decline')}</Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
