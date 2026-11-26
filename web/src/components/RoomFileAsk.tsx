// The side panel's answer to a team-file link that does not open for me in a place where I may ask to view it (QA
// S-120, docs/decisions/20261122-room-link-ask-and-team-file-names.md): a room message's link (RoomFileAsk), and since
// QA after #651 any team file linked in a shared chat that its creator cannot add (ChatFileAsk, `view`). "You don't
// have access to this file." with who answers (the person who linked it by name when it is their file, else "the file's
// owner or an admin") and [Ask to view], an ordinary file access request (its answer comes in Activity). "Request
// sent…" / "You asked on …" while it waits; shared with me since: the file's link opens it. Anything else (the server
// answers 'no' for every other reason alike): today's line, through FileMoved (a file someone moved or put in the trash
// says so), with nothing about the file.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RoomFileAccess, RoomFileRequestResult } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDate } from '../lib/format'
import type { RoomLinkFrom } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { FileMoved } from './FileMoved'
import { Button, PreviewLoading } from './ui'

/** What the place's file-access answered, in the room's words (a chat's view / viewAsked read as ask / asked). */
export type ViewAccess = RoomFileAccess

/** The ask's body once the place answered: `request` sends it (the place's POST). `testId`: the frame's test id, its
 * parts' ids start with it. */
export function ViewAsk({ initial, request, path, chatId, fallback, testId = 'room-file-ask' }: {
  initial: ViewAccess
  request: () => Promise<RoomFileRequestResult>
  path: string
  /** the chat it is asked from, for FileMoved's Open */
  chatId?: string
  fallback: string
  testId?: string
}) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  // (a new path or place: the caller shows its loading line first, so this mounts again with the new answer)
  const [state, setState] = useState<ViewAccess | { status: 'sent'; by: string | null }>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // shared with me now: the file's own link opens it
  if (state.status === 'open' && state.link)
    return (
      <div className="flex flex-col items-start gap-3 p-6" data-testid={testId} data-state="open">
        <Button variant="primary" onClick={() => navigate(`/f/${state.link}`)} data-testid={`${testId}-open`}>{t('roomFileAsk.open')}</Button>
      </div>
    )
  if (state.status === 'no' || state.status === 'open') return <FileMoved path={path} {...(chatId ? { chatId } : {})} fallback={fallback} />
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await request()
      if (r.status === 'open') return setState(r.link ? { status: 'open', link: r.link } : { status: 'no' })
      setState({ status: 'sent', by: state.by })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-start gap-3 p-6" data-testid={testId} data-state={state.status}>
      <p className="text-sm leading-6 font-medium break-keep text-ink">{t('roomFileAsk.title')}</p>
      <p className="text-sm leading-6 break-keep text-muted">{state.by ? t('roomFileAsk.byName', { name: state.by }) : t('roomFileAsk.byAdmin')}</p>
      {state.status === 'ask' ? (
        <Button variant="primary" busy={busy} onClick={() => void send()} data-testid={`${testId}-send`}>{t('roomFileAsk.ask')}</Button>
      ) : (
        <p role="status" className="text-sm leading-6 break-keep text-muted" data-testid={`${testId}-sent`}>
          {state.status === 'sent' ? t('linkAccess.sent') : t('linkAccess.asked', { date: formatDate(state.askedAt, locale) })}
        </p>
      )}
      {error && <p role="alert" className="text-sm break-keep text-danger" data-testid={`${testId}-error`}>{error}</p>}
    </div>
  )
}

export function RoomFileAsk({ room, path, fallback }: { room: RoomLinkFrom; path: string; fallback: string }) {
  const t = useT()
  const [state, setState] = useState<ViewAccess | { status: 'loading' }>({ status: 'loading' })
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
  return <ViewAsk initial={state} path={path} fallback={fallback} request={() => api.call(API.requestRoomFile, { params: { id: room.roomId, messageId: room.messageId }, body: { path } })} />
}
