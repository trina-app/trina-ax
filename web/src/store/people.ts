// The team's people directory (GET /api/people: name, title, status, photo version), read when a screen first needs it,
// again after the server could not resume this window (components/rooms/useRoomsSync.ts) and when someone changes their
// profile (the quiet profile_changed notice, store/live.ts). The rooms use it for photos (a room's members and authors
// carry a name only) and the "new 1:1 chat" list.
import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import type { Person, UserRef } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface PeopleState {
  /** null until the first answer */
  people: Person[] | null
  /** a screen has read the list (a profile change then reads it again; before, nobody needs it) */
  loaded: boolean
  byId: Record<string, Person>
  failed: boolean
  load: (force?: boolean) => Promise<void>
  reset: () => void
}

let inflight: Promise<void> | null = null
/** a forced read was asked for while one was on its way (a profile notice): that read may predate the change */
let again = false

export const usePeople = create<PeopleState>((set, get) => ({
  people: null,
  loaded: false,
  byId: {},
  failed: false,
  load(force) {
    if (inflight) {
      if (force) again = true
      return inflight
    }
    if (get().people && !force) return Promise.resolve()
    inflight = api
      .call(API.listPeople)
      .then(
        (r) => set({ people: r.people, loaded: true, byId: Object.fromEntries(r.people.map((p) => [p.id, p])), failed: false }),
        () => set((s) => ({ failed: true, loaded: true, people: s.people ?? [] })),
      )
      .finally(() => {
        inflight = null
        // one more read for a change that came while this one was on its way
        if (again) {
          again = false
          void get().load(true)
        }
      })
    return inflight
  },
  reset: () => {
    again = false
    set({ people: null, loaded: false, byId: {}, failed: false })
  },
}))

/** The directory, asked for the first time a screen needs it. */
export function usePeopleList(): Person[] | null {
  const people = usePeople((s) => s.people)
  useEffect(() => {
    void usePeople.getState().load()
  }, [])
  return people
}

/** A person's name as it is now: the directory's (it reloads when someone changes their profile, so a new name shows
 * at once), else the one a message or a member list carried. */
export function useNameOf(): (ref: UserRef | null | undefined) => string | null {
  const byId = usePeople((s) => s.byId)
  return useCallback((ref) => (ref ? byId[ref.id]?.name ?? ref.name : null), [byId])
}

/** A name from a message or a member list with the person's photo version, when the directory has one. */
export function useAvatarOf(ref: UserRef | null | undefined): { id: string; name: string; avatarVersion?: number } | null {
  const person = usePeople((s) => (ref ? s.byId[ref.id] : undefined))
  if (!ref) return null
  return { id: ref.id, name: ref.name, avatarVersion: person?.avatarVersion }
}

/** A face for someone a list names by id and name (Admin › Folder permissions, Groups, the Team skills page's editors):
 * the name as the list has it, with the directory's photo version (the directory is read the first time a screen asks);
 * someone not in it (switched off) gets the letter. */
export function useFaceOf(): (ref: { id: string; name: string }) => { id: string; name: string; avatarVersion?: number } {
  usePeopleList()
  const byId = usePeople((s) => s.byId)
  return useCallback((ref) => ({ id: ref.id, name: ref.name, avatarVersion: byId[ref.id]?.avatarVersion }), [byId])
}
