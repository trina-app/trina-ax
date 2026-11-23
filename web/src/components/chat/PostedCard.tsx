// A post the AI made to a room (post_to_room, `Step.posted`) in the one card frame of what the AI did for the person
// (ActionCard.tsx; docs/decisions/20261116-ai-share-card-and-stop.md): "Posted in Sales" and View, which goes where the
// step row's own View goes (the room at the message, or the thread at the reply; a room's side chat passes its own way:
// Steps.tsx StepPostView). The room is named only when the viewer has it in their own list; the record holds ids alone,
// and only the person whose turn it was gets it. Under the title: what went, from the posted message itself (its first
// words, the files sent with it), so the card says what and where without opening the room.
// Do then undo (docs/decisions/20261123-do-then-undo.md): a post that went without a card can be taken back. For
// UNDO_MS after the step ended the card offers Undo (the room's own delete of my message: its text, files and notices go
// for everyone), then Delete for as long as the message is there.
import { useContext, useEffect, useState } from 'react'
import { API, type Step } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, errorText } from '../../lib/api'
import { navigateTo } from '../../lib/nav'
import { useRooms } from '../../store/rooms'
import { useRoomTitle } from '../rooms/RoomIcon'
import { Button } from '../ui'
import { ListRow } from '../list/List'
import { ActionCard, ActionNote, ActionRows } from './ActionCard'
import { FileKindIcon } from './TeamFilePicker'
import { postPath, StepPostView } from './Steps'

/** how long a just-sent post offers Undo before the button reads Delete */
export const UNDO_MS = 10_000

export default function PostedCard({ posted, endedAt }: { posted: NonNullable<Step['posted']>; endedAt?: string | null }) {
  const t = useT()
  const locale = useLocale()
  const [undoLeft, setUndoLeft] = useState(() => (endedAt ? Math.max(0, Date.parse(endedAt) + UNDO_MS - Date.now()) : 0))
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (undoLeft <= 0) return
    const id = setTimeout(() => setUndoLeft(0), undoLeft)
    return () => clearTimeout(id)
  }, [undoLeft])
  const takeBack = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.call(API.deleteRoomMessage, { params: { id: posted.roomId, messageId: posted.messageId } })
      setGone(true)
    } catch (e) {
      setError(errorText(e, locale, t('postedCard.undoFailed')))
    } finally { setBusy(false) }
  }
  const viewPost = useContext(StepPostView)
  const room = useRooms((s) => s.rooms.find((r) => r.id === posted.roomId))
  const titleOf = useRoomTitle()
  // a team room and the everyone room with "#", as the offer under the answer and the AI's answer name them
  const where = room ? (room.kind === 'team' || room.kind === 'all' ? `#${titleOf(room)}` : titleOf(room)) : ''
  const title = gone ? t('postedCard.undone') : room ? t('shareCard.posted', { room: where }) : t('shareCard.postedPlain')
  const footer = gone ? undefined : (
    <>
      {error && <span role="alert" className="mr-auto text-xs break-keep text-danger" data-testid="posted-card-error">{error}</span>}
      <Button size="sm" variant="ghost" busy={busy} onClick={() => void takeBack()} data-testid={undoLeft > 0 ? 'posted-card-undo' : 'posted-card-delete'}>{undoLeft > 0 ? t('postedCard.undo') : t('postedCard.delete')}</Button>
      <Button size="sm" variant="secondary" onClick={() => (viewPost ? viewPost(posted) : navigateTo(postPath(posted)))} aria-label={t('steps.postViewLabel')} data-testid="posted-card-view">{t('steps.postView')}</Button>
    </>
  )
  return (
    <ActionCard title={title} label={title} testId="posted-card" state={gone ? 'undone' : 'done'} kind="post" footer={footer}>
      {posted.preview && <ActionNote testId="posted-card-preview">“{posted.preview}”</ActionNote>}
      {!!posted.files?.length && (
        <ActionRows testId="posted-card-files">
          {posted.files.map((name, i) => <ListRow key={i} icon={<FileKindIcon name={name} />} name={name} nameTitle={name} testId="posted-card-file" />)}
        </ActionRows>
      )}
    </ActionCard>
  )
}
