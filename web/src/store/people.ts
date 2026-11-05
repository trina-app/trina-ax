// The people directory (GET /api/people): names, titles, statuses and photo versions of the team, for lists, mentions
// and chat. Loaded when first needed; the realtime notice profile_changed (store/live.ts) loads it again.
import { create } from 'zustand'
import type { Person } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface PeopleState {
  people: Person[]
  loaded: boolean
  load: (force?: boolean) => Promise<void>
}

export const usePeople = create<PeopleState>((set, get) => ({
  people: [],
  loaded: false,
  async load(force = false) {
    if (get().loaded && !force) return
    try {
      const r = await api.call(API.listPeople)
      set({ people: r.people, loaded: true })
    } catch { /* the list stays as it was */ }
  },
}))
