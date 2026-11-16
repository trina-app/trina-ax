// A post the AI made to a room (post_to_room, `Step.posted`) in the one card frame of what the AI did for the person
// (ActionCard.tsx; docs/decisions/20261116-ai-share-card-and-stop.md): "Posted in Sales" and View, which goes where the
// step row's own View goes (the room at the message, or the thread at the reply; a room's side chat passes its own way:
// Steps.tsx StepPostView). The room is named only when the viewer has it in their own list; the record holds ids alone,
// and only the person whose turn it was gets it. Under the title: what went, from the posted message itself (its first
// words, the files sent with it), so the card says what and where without opening the room.
import { useContext } from 'react'
import type { Step } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { navigateTo } from '../../lib/nav'
import { useRooms } from '../../store/rooms'
import { useRoomTitle } from '../rooms/RoomIcon'
import { Button } from '../ui'
import { ListRow } from '../list/List'
import { ActionCard, ActionNote, ActionRows } from './ActionCard'
import { FileKindIcon } from './TeamFilePicker'
import { postPath, StepPostView } from './Steps'

export default function PostedCard({ posted }: { posted: NonNullable<Step['posted']> }) {
  const t = useT()
  const viewPost = useContext(StepPostView)
  const room = useRooms((s) => s.rooms.find((r) => r.id === posted.roomId))
  const titleOf = useRoomTitle()
  const title = room ? t('shareCard.posted', { room: titleOf(room) }) : t('shareCard.postedPlain')
  return (
    <ActionCard title={title} label={title} testId="posted-card" state="done" kind="post"
      footer={<Button size="sm" variant="secondary" onClick={() => (viewPost ? viewPost(posted) : navigateTo(postPath(posted)))} aria-label={t('steps.postViewLabel')} data-testid="posted-card-view">{t('steps.postView')}</Button>}>
      {posted.preview && <ActionNote testId="posted-card-preview">“{posted.preview}”</ActionNote>}
      {!!posted.files?.length && (
        <ActionRows testId="posted-card-files">
          {posted.files.map((name, i) => <ListRow key={i} icon={<FileKindIcon name={name} />} name={name} nameTitle={name} testId="posted-card-file" />)}
        </ActionRows>
      )}
    </ActionCard>
  )
}
