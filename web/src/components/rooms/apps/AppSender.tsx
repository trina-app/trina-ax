// An app's name over its messages, with the "App" tag (SenderTag). A tap on the name opens, under it, who set it up: the people
// who manage the room's apps get "Manage" (its settings); everyone else "Ask Mina to change what shows here." ("Ask an
// admin…" when that person has left, or in a team room once the app is gone). No per-person mute in v1 (plan "What is
// NOT in v1"). The name is the app's, never a person's: it is not linked to anyone's profile.
import { Settings2 } from 'lucide-react'
import type { RoomAppRef } from '@mycel/shared/api'
import { useT } from '../../../i18n'
import { useRooms } from '../../../store/rooms'
import { mayManageApps, useRoomApps } from '../../../store/roomApps'
import { useMe } from '../../../store/session'
import { MenuButton } from '../MenuButton'
import { SenderTag, useAppName } from './AppParts'

export function AppSender({ roomId, app }: { roomId: string; app: RoomAppRef }) {
  const t = useT()
  const me = useMe()
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const name = useAppName()(app)
  const manages = mayManageApps(room, me)
  const by = app.by ?? null
  const heading = by ? t('roomApps.setUpBy', { name: by.name }) : t('roomApps.setUpByGone')
  const ask = by && by.id !== me?.user.id ? t('roomApps.askToChange', { name: by.name }) : t('roomApps.askAdmin')
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" data-testid="app-sender">
      <MenuButton
        label={t('roomApps.senderMenu', { app: name })}
        tip={name}
        compact
        icon={<span className="truncate" data-testid="app-sender-name">{name}</span>}
        // the name as the run's name looks: no button padding, the words in ink
        buttonClassName="min-w-0 max-w-full truncate rounded-sm p-0! text-sm! font-medium text-ink! hover:underline hover:bg-transparent! max-sm:p-0!"
        className="min-w-0"
        heading={heading}
        startAligned
        testId="app-sender-button"
        items={manages && app.id ? [{ label: t('roomApps.manage'), icon: <Settings2 size={14} aria-hidden />, onSelect: () => useRoomApps.getState().open(roomId, { view: 'settings', appId: app.id! }), testId: 'app-sender-manage' }] : []}
        footer={manages ? undefined : <p className="max-w-64 px-2 pb-1.5 text-sm text-ink max-md:max-w-none max-md:px-3 max-md:pb-2" data-testid="app-sender-ask">{ask}</p>}
      />
      <SenderTag example={!!app.example} />
    </span>
  )
}
