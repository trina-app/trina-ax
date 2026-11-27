// The Slack channel relay of a conversation (docs/SLACK.md "Channel relay", plan
// docs/AGENTS/plan/20261127-0329-slack-channel-relay.md): its link as anyone in it reads it (GET /api/rooms/:id/slack),
// for the header chip, the composer's placeholder and the one Slack dialog (components/rooms/apps/SlackRelay.tsx), and
// which conversation's Slack dialog is open (the header chip opens it; Add an app › Slack shows the same panel inside
// the apps dialog). Read for team channels and projects only (the only conversations a channel links to), when the room
// opens and again whenever a Slack event line arrives there (connected, disconnected, the app removed, …).
import { create } from 'zustand'
import type { SlackRelayLink, SlackRelayStatus } from '@mycel/shared/api'
import { api, API, isApiError } from '../lib/api'

interface SlackRelayState {
  /** per room: its status; null: none to show (an older server, or not one I can read) */
  status: Record<string, SlackRelayStatus | null | undefined>
  /** the room whose Slack dialog (the header chip's) is open */
  dialog: string | null
  load: (roomId: string) => Promise<SlackRelayStatus | null>
  put: (roomId: string, s: SlackRelayStatus) => void
  open: (roomId: string) => void
  close: () => void
}

export const useSlackRelay = create<SlackRelayState>((set) => ({
  status: {},
  dialog: null,
  async load(roomId) {
    try {
      const s = await api.call(API.slackRelay, { params: { id: roomId } })
      set((st) => ({ status: { ...st.status, [roomId]: s } }))
      return s
    } catch (e) {
      // an older server has no such route (and a room I left is not mine to read): nothing to show
      if (isApiError(e, 'not_found')) {
        set((st) => ({ status: { ...st.status, [roomId]: null } }))
        return null
      }
      throw e
    }
  },
  put(roomId, s) { set((st) => ({ status: { ...st.status, [roomId]: s } })) },
  open(roomId) { set({ dialog: roomId }) },
  close() { set({ dialog: null }) },
}))

/** The conversation's Slack link, once read (null: none). */
export const useSlackLink = (roomId: string | null | undefined): SlackRelayLink | null =>
  useSlackRelay((s) => (roomId ? s.status[roomId]?.link ?? null : null))
