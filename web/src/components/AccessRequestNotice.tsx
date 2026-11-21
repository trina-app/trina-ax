// Under a request to open my chat or project in Activity (QA TC-4185, TC-4186; 'access.requested'; docs/decisions/
// 20261116-chat-project-ask-access.md): the asker's note as plain text, and while it waits and I may share it, Share
// (a chat) or Add (a project) and Decline in the row, as a file's request (components/FileRequestNotice.tsx). A chat's
// first share with someone asks first, with the Share dialog's own warning lines (components/ShareWarning.tsx), and
// shares only after the yes. After: what was done; the chat or project gone meanwhile: that, without buttons.
// An ask to add one file of my chat shared with people (`file`, docs/decisions/20261121-share-chat-files.md): [Add to
// the chat] and Decline; the server checks the file again and copies it into the chat, or closes the ask.
import { useState } from 'react'
import type { InboxNotification } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { useChats } from '../store/chats'
import { shareWarningLines } from './ShareWarning'
import { Button, confirmDialog } from './ui'

export function AccessRequestExtras({ item, onRead, onChanged }: { item: InboxNotification; onRead: () => void; onChanged: () => void }) {
  const t = useT()
  const locale = useLocale()
  const a = item.accessRequest
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  // what I answered here, else what the notice says now (a row drawn again after a resize or a reload reads the latter)
  const [answered, setState] = useState<NonNullable<InboxNotification['accessRequest']>['state'] | null>(null)
  const state = answered ?? a?.state
  if (!a || item.code !== 'access.requested') return null
  const answer = async (choice: 'approve' | 'decline') => {
    if (!a.requestId) return
    setBusy(choice)
    try {
      let r = await api.call(API.answerAccessRequest, { params: { id: a.requestId }, body: { answer: choice } })
      if (r.state === 'confirm') {
        const by = a.by ?? ''
        const lines = shareWarningLines(t, r.check, by)
        const yes = await confirmDialog({ title: t('accessRequest.confirmTitle', { by }), body: [t('accessRequest.confirmBody', { by }), ...lines].join(' '), confirm: t('accessRequest.share'), cancel: t('common.cancel') })
        if (!yes) return
        r = await api.call(API.answerAccessRequest, { params: { id: a.requestId }, body: { answer: 'approve', confirmKey: r.confirmKey } })
        // (something changed again meanwhile: the next press asks again)
        if (r.state === 'confirm') return
      }
      setState(r.state)
      // a file added to my chat: the chat, when open here, is read again so its link opens the copy
      if (r.state === 'approved' && a.file && a.targetId && useChats.getState().threads[a.targetId]) void useChats.getState().loadThread(a.targetId).catch(() => {})
      onRead()
      onChanged()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }
  const gone = a.gone || state === 'closed'
  const done = state === 'approved' ? t(a.file ? 'accessRequest.addedFile' : a.kind === 'project' ? 'accessRequest.addedProject' : 'accessRequest.sharedChat', { by: a.by ?? '' })
    : state === 'declined' ? t('accessRequest.declined') : gone ? t('accessRequest.gone') : null
  return (
    <div className="mt-1 space-y-2" data-testid="access-request" data-kind={a.kind ?? undefined} data-state={gone ? 'closed' : state}>
      {a.note && !gone && <p className="text-sm break-words whitespace-pre-wrap text-muted" data-testid="access-request-note">“{a.note}”</p>}
      {done ? (
        <p className="text-xs text-muted" data-testid="access-request-done">{done}</p>
      ) : state === 'pending' && a.canAnswer ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" busy={busy === 'approve'} disabled={!!busy} onClick={() => void answer('approve')} data-testid="access-request-share">{t(a.file ? 'accessRequest.addToChat' : a.kind === 'project' ? 'accessRequest.add' : 'accessRequest.share')}</Button>
          <Button size="sm" busy={busy === 'decline'} disabled={!!busy} onClick={() => void answer('decline')} data-testid="access-request-decline">{t('accessRequest.decline')}</Button>
        </div>
      ) : null}
    </div>
  )
}
