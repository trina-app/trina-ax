// The header's "#client-acme · Slack" in a conversation linked to a Slack channel (docs/SLACK.md "Channel relay"):
// small, Slack's mark first; the app removed from the channel in the warning colour, an archived channel muted, the
// state in words as its tooltip. It opens the Slack dialog (components/rooms/apps/SlackRelay.tsx, loaded when first
// opened): its status for everyone in the conversation, Disconnect for its owners and admins. A phone: the mark only.
// Also here: reading the link when the room opens and again whenever a Slack event line comes in.
import clsx from 'clsx'
import { lazy, Suspense, useEffect } from 'react'
import type { Room, RoomMessage } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { isProjectRoom } from '../../lib/rooms'
import { useSlackRelay } from '../../store/slackRelay'
import { Tooltip } from '../Tooltip'
import { SlackMark } from './SlackMessage'

const SlackRelayDialog = lazy(() => import('./apps/SlackRelay').then((m) => ({ default: m.SlackRelayDialog })))

/** Only a team channel or a project links to a Slack channel. */
export const relayRoom = (room: Pick<Room, 'kind'> & Partial<Pick<Room, 'project' | 'projectRoom'>>): boolean => room.kind === 'team' || isProjectRoom(room)

/** Read the conversation's link when it opens, and again after each Slack event line (connected, the app removed …). */
export function useSlackRelayWatch(room: (Pick<Room, 'id' | 'kind'> & Partial<Pick<Room, 'project' | 'projectRoom'>>) | null, messages: readonly Pick<RoomMessage, 'id' | 'event'>[]) {
  const on = !!room && relayRoom(room)
  const id = room?.id ?? null
  let line: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.event?.type === 'slack') { line = messages[i]!.id; break }
  useEffect(() => {
    if (!on || !id) return
    void useSlackRelay.getState().load(id).catch(() => { /* the chip stays as it was */ })
  }, [on, id, line])
}

export function SlackChip({ roomId }: { roomId: string }) {
  const t = useT()
  const status = useSlackRelay((s) => s.status[roomId])
  const link = status?.link ?? null
  if (!link) return null
  const bot = status?.botName ?? null
  const state = link.state === 'archived' ? t('slackRelay.state.archived') : link.state === 'bot_removed' ? (bot ? t('slackRelay.state.botRemoved', { bot }) : t('slackRelay.state.botRemovedNoBot')) : t('slackRelay.state.active')
  const words = t('slackRelay.chip', { channel: link.channelName })
  return (
    <Tooltip label={`${words}: ${state}`}>
      <button
        type="button"
        onClick={() => useSlackRelay.getState().open(roomId)}
        aria-haspopup="dialog"
        aria-label={t('slackRelay.chipLabel', { channel: link.channelName, state })}
        className={clsx(
          'touch-hit inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-hover max-md:border-0 max-md:px-1.5',
          link.state === 'bot_removed' ? 'border-warn/40 text-warn' : link.state === 'archived' ? 'border-line text-faint' : 'border-line text-muted',
        )}
        data-testid="room-slack-chip" data-state={link.state}
      >
        <SlackMark size={13} className={clsx(link.state === 'archived' && 'opacity-50 grayscale')} />
        <span className={clsx('truncate max-md:hidden', link.state === 'archived' && 'line-through')}>{words}</span>
      </button>
    </Tooltip>
  )
}

/** The chip's dialog, while it is open for this room. */
export function SlackRelayHost({ roomId }: { roomId: string }) {
  const open = useSlackRelay((s) => s.dialog === roomId)
  if (!open) return null
  return <Suspense fallback={null}><SlackRelayDialog roomId={roomId} /></Suspense>
}
