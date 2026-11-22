// The side panel's answer to a team-file link in a room message that does not open for me (QA S-120, docs/decisions/
// 20261122-room-link-ask-and-team-file-names.md): "You don't have access to this file." with who answers (the poster by
// name when it is their file, else "the file's owner or an admin") and [Ask to view], an ordinary file access request
// (its answer comes in Activity). "Request sent…" / "You asked on …" while it waits; shared with me since: the file's
// link opens it. Anything else (the server answers 'no' for every other reason alike): today's line, through FileMoved
// (a file someone moved or put in the trash says so), with nothing about the file.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RoomFileAccess } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDate } from '../lib/format'
import type { RoomLinkFrom } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { FileMoved } from './FileMoved'
import { Button, PreviewLoading } from './ui'

export function RoomFileAsk({ room, path, fallback }: { room: RoomLinkFrom; path: string; fallback: string }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const [state, setState] = useState<RoomFileAccess | { status: 'loading' } | { status: 'sent'; by: string | null }>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    api.call(API.roomFileAccess, { params: { id: room.roomId, messageId: room.messageId }, query: { path } }).then(
      (r) => live && setState(r),
      () => live && setState({ status: 'no' }),
    )
    return () => { live = false }
  }, [room.roomId, room.messageId, path])
  if (state.status === 'loading') return <PreviewLoading label={t('common.loading')} />
  // shared with me now: the file's own link opens it
  if (state.status === 'open' && state.link)
    return (
      <div className="flex flex-col items-start gap-3 p-6" data-testid="room-file-ask" data-state="open">
        <Button variant="primary" onClick={() => navigate(`/f/${state.link}`)} data-testid="room-file-ask-open">{t('roomFileAsk.open')}</Button>
      </div>
    )
  if (state.status === 'no' || state.status === 'open') return <FileMoved path={path} fallback={fallback} />
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.requestRoomFile, { params: { id: room.roomId, messageId: room.messageId }, body: { path } })
      if (r.status === 'open') return setState(r.link ? { status: 'open', link: r.link } : { status: 'no' })
      setState({ status: 'sent', by: state.by })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-start gap-3 p-6" data-testid="room-file-ask" data-state={state.status}>
      <p className="text-sm leading-6 font-medium break-keep text-ink">{t('roomFileAsk.title')}</p>
      <p className="text-sm leading-6 break-keep text-muted">{state.by ? t('roomFileAsk.byName', { name: state.by }) : t('roomFileAsk.byAdmin')}</p>
      {state.status === 'ask' ? (
        <Button variant="primary" busy={busy} onClick={() => void send()} data-testid="room-file-ask-send">{t('roomFileAsk.ask')}</Button>
      ) : (
        <p role="status" className="text-sm leading-6 break-keep text-muted" data-testid="room-file-ask-sent">
          {state.status === 'sent' ? t('linkAccess.sent') : t('linkAccess.asked', { date: formatDate(state.askedAt, locale) })}
        </p>
      )}
      {error && <p role="alert" className="text-sm break-keep text-danger" data-testid="room-file-ask-error">{error}</p>}
    </div>
  )
}
