// The side panel's answer to a file link of a chat shared with people that does not open for me (docs/decisions/
// 20261121-share-chat-files.md): the chat made the file in its creator's own folder, so only they can add it to the
// chat. "Only Alice can add this file to the chat." [Ask to add it] sends the ask to their Activity; "You asked on …"
// while it waits; the chat has it now: its copy opens instead. Anything else (the server answers 'no' for every other
// reason alike): today's "can't be found, or you don't have access" line, with nothing about the file.
import { useEffect, useState } from 'react'
import type { ChatFileAccess } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDate } from '../lib/format'
import { openFilePreview } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { FileMoved } from './FileMoved'
import { Button, PreviewLoading } from './ui'

export function ChatFileAsk({ chatId, path, fallback }: { chatId: string; path: string; fallback: string }) {
  const t = useT()
  const locale = useLocale()
  const [state, setState] = useState<ChatFileAccess | { status: 'loading' } | { status: 'sent'; by: string; name: string }>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    api.call(API.chatFileAccess, { params: { id: chatId }, query: { path } }).then(
      (r) => {
        if (!live) return
        // the chat has it now: its copy, in the same panel
        if (r.status === 'copy') return openFilePreview({ source: 'chat', chatId, fileId: r.fileId, name: r.name })
        setState(r)
      },
      () => live && setState({ status: 'no' }),
    )
    return () => { live = false }
  }, [chatId, path])
  if (state.status === 'loading') return <PreviewLoading label={t('common.loading')} />
  // nothing to ask for: a file someone moved or put in the trash says so (components/FileMoved.tsx), else the usual line
  if (state.status === 'no' || state.status === 'copy') return <FileMoved path={path} chatId={chatId} fallback={fallback} />
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.requestChatFile, { params: { id: chatId }, body: { path } })
      if (r.status === 'open') return
      setState({ status: 'sent', by: state.by, name: state.name })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-start gap-3 p-6" data-testid="chat-file-ask" data-state={state.status}>
      <p className="text-sm leading-6 font-medium break-keep text-ink">{t('chatFileAsk.only', { name: state.by })}</p>
      <p className="text-sm leading-6 break-keep text-muted">{t('chatFileAsk.why', { name: state.by })}</p>
      {state.status === 'ask' ? (
        <Button variant="primary" busy={busy} onClick={() => void send()} data-testid="chat-file-ask-send">{t('chatFileAsk.ask')}</Button>
      ) : (
        <p role="status" className="text-sm leading-6 break-keep text-muted" data-testid="chat-file-ask-sent">
          {state.status === 'sent' ? t('linkAccess.sent') : t('linkAccess.asked', { date: formatDate(state.askedAt, locale) })}
        </p>
      )}
      {error && <p role="alert" className="text-sm break-keep text-danger" data-testid="chat-file-ask-error">{error}</p>}
    </div>
  )
}
