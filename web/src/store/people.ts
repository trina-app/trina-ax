// The team's people directory (GET /api/people: name, title, status, photo version), read once per sign-in and again
// after the server could not resume this window (components/rooms/useRoomsSync.ts). The rooms use it for photos (a
// room's members and authors carry a name only) and the "new 1:1 chat" list.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { Person, UserRef } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface PeopleState {
  people: Person[] | null
  byId: Record<string, Person>
  failed: boolean
  load: (force?: boolean) => Promise<void>
  reset: () => void
}

let inflight: Promise<void> | null = null

export const usePeople = create<PeopleState>((set, get) => ({
  people: null,
  byId: {},
  failed: false,
  load(force) {
    if (inflight) return inflight
    if (get().people && !force) return Promise.resolve()
    inflight = api
      .call(API.listPeople)
      .then(
        (r) => set({ people: r.people, byId: Object.fromEntries(r.people.map((p) => [p.id, p])), failed: false }),
        () => set((s) => ({ failed: true, people: s.people ?? [] })),
      )
      .finally(() => {
        inflight = null
      })
    return inflight
  },
  reset: () => set({ people: null, byId: {}, failed: false }),
}))

/** The directory, asked for the first time a screen needs it. */
export function usePeopleList(): Person[] | null {
  const people = usePeople((s) => s.people)
  useEffect(() => {
    void usePeople.getState().load()
  }, [])
  return people
}

/** A name from a message or a member list with the person's photo version, when the directory has one. */
export function useAvatarOf(ref: UserRef | null | undefined): { id: string; name: string; avatarVersion?: number } | null {
  const person = usePeople((s) => (ref ? s.byId[ref.id] : undefined))
  if (!ref) return null
  return { id: ref.id, name: ref.name, avatarVersion: person?.avatarVersion }
}
