// The team's people directory (GET /api/people: name, title, status, photo version), read when a screen first needs it,
// again after the server could not resume this window (components/rooms/useRoomsSync.ts) and when someone changes their
// profile (the quiet profile_changed notice, store/live.ts). The rooms use it for photos (a room's members and authors
// carry a name only) and the "new 1:1 chat" list.
import { useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { Person, UserRef } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface PeopleState {
  /** null until the first answer */
  people: Person[] | null
  /** a screen has read the list (a profile change then reads it again; before, nobody needs it) */
  loaded: boolean
  byId: Record<string, Person>
  /** guests a list other than the directory said are guests (a project's people, GET /api/projects/:id/people): an
   * owner or admin outside a guest's one place has them in that list but not in the directory. Only added to: a guest
   * made a member keeps the tag until the next sign-in or reload (rare; reset() clears it) */
  guestIds: Record<string, true>
  failed: boolean
  load: (force?: boolean) => Promise<void>
  /** these people are guests (from such a list) */
  noteGuests: (ids: readonly string[]) => void
  reset: () => void
}

let inflight: Promise<void> | null = null
/** a forced read was asked for while one was on its way (a profile notice): that read may predate the change */
let again = false

export const usePeople = create<PeopleState>((set, get) => ({
  people: null,
  loaded: false,
  byId: {},
  guestIds: {},
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
  noteGuests(ids) {
    const known = get().guestIds
    if (ids.every((id) => known[id])) return
    set({ guestIds: { ...known, ...Object.fromEntries(ids.map((id) => [id, true as const])) } })
  },
  reset: () => {
    again = false
    set({ people: null, loaded: false, byId: {}, guestIds: {}, failed: false })
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

/** The directory, read again (once for each person) when a list names someone it does not have: a person who joined a
 * room a moment ago. Who is a guest comes from the directory (components/GuestTag.tsx), so without this a guest who joins
 * a room while it is open has no "Guest" tag and no "Includes 1 guest" until the page is reloaded. Only once the
 * directory has been read, and one read for each unknown person (someone it never lists, a switched-off account, does not
 * make a read on every change). */
export function useReadPeopleFor(ids: readonly string[] | null | undefined): void {
  const loaded = usePeople((s) => s.loaded)
  const byId = usePeople((s) => s.byId)
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (!loaded || !ids) return
    const unknown = ids.filter((id) => !byId[id] && !asked.current.has(id))
    if (!unknown.length) return
    for (const id of unknown) asked.current.add(id)
    // a read that failed is asked again at the next change (not in a loop: `failed` does not change byId)
    void usePeople.getState().load(true).then(() => {
      if (usePeople.getState().failed) for (const id of unknown) asked.current.delete(id)
    })
  }, [ids, byId, loaded])
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
