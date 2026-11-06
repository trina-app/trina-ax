// Keeps the rooms list (store/rooms.ts) and the people directory (store/people.ts) loaded while the app shell is on
// screen (Layout.tsx): read once, and again when the server could not resume this window after a gap (reset / resync:
// the room events in between are lost, so the list, the open room's newest page and its members are read again).
import { useEffect } from 'react'
import { reloadAsked } from '../../store/live'
import { usePeople } from '../../store/people'
import { useRooms } from '../../store/rooms'

export function useRoomsSync() {
  useEffect(() => {
    if (!useRooms.getState().loaded) void useRooms.getState().loadRooms()
    return reloadAsked.on(() => {
      void useRooms.getState().resync()
      if (usePeople.getState().people) void usePeople.getState().load(true)
    })
  }, [])
}
