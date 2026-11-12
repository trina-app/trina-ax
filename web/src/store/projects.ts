// Projects as this window last saw them, by id: a rename or a new project saved in one place (the project dialog, the
// Projects page) shows at once wherever the project is named (the chat header, Trina history's headers). Not a full
// list: places that list projects still ask the server.
//
// `listed`: the projects the latest plain read of the list (GET /api/projects, no `manage`) returned, so the ones the
// person sees now (docs/DECISIONS.md "Trina history by project"). One read for every sidebar in this window (the
// computer's column and the phone's drawer, which mounts again each time ☰ opens): `readProjectList` keeps one request
// in flight and, when asked with `minAgeMs` (a window coming back to the front), skips a read that recent.
import { create } from 'zustand'
import type { Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface ProjectsState {
  byId: Record<string, Project>
  /** the ids of the latest plain list read; null before the first one ends (a failed read: an empty set) */
  listed: ReadonlySet<string> | null
  /** what the server answered for these projects */
  put: (...items: Project[]) => void
  /** gone, or no longer the person's to see */
  drop: (id: string) => void
  /** a project the person was just shown in a fresh list (the move dialog's): seen at once */
  see: (p: Project) => void
  /** signed out (App.tsx): nothing of one person's projects stays for the next */
  reset: () => void
}

/** a read started before a reset (another person signed in since) never lands */
let generation = 0
let inFlight: Promise<void> | null = null
let lastRead = 0
/** project ids a chat named that no read had: read once more for each, never again */
const askedFor = new Set<string>()

export const useProjects = create<ProjectsState>((set) => ({
  byId: {},
  listed: null,
  put: (...items) => set((s) => ({ byId: { ...s.byId, ...Object.fromEntries(items.map((p) => [p.id, p])) } })),
  drop: (id) => set((s) => {
    if (!(id in s.byId)) return s
    const byId = { ...s.byId }
    delete byId[id]
    return { byId }
  }),
  see: (p) => set((s) => ({ byId: { ...s.byId, [p.id]: p }, listed: new Set([...(s.listed ?? []), p.id]) })),
  reset: () => {
    generation++
    inFlight = null
    lastRead = 0
    askedFor.clear()
    set({ byId: {}, listed: null })
  },
}))

/** Read the project list the person sees (one request at a time; with `minAgeMs`, not again that soon). `covers`: the
 * projects the chats name now, which this read answers for (one it leaves out is not asked about again). */
export function readProjectList(o: { minAgeMs?: number; covers?: readonly string[] } = {}): Promise<void> {
  if (inFlight) return inFlight
  if (o.minAgeMs && lastRead && Date.now() - lastRead < o.minAgeMs) return Promise.resolve()
  for (const id of o.covers ?? []) askedFor.add(id)
  const mine = generation
  // a failed read does not count as one for `minAgeMs`: the window coming back to the front tries again at once
  const done = (ok: boolean) => {
    if (mine !== generation) return
    inFlight = null
    if (ok) lastRead = Date.now()
  }
  inFlight = api.call(API.listProjects).then(
    (r) => {
      if (mine !== generation) return
      done(true)
      useProjects.getState().put(...r.items)
      useProjects.setState({ listed: new Set(r.items.map((p) => p.id)) })
    },
    // nothing known: every chat is with the other chats (no name is ever guessed)
    () => {
      if (mine !== generation) return
      done(false)
      useProjects.setState((s) => ({ listed: s.listed ?? new Set() }))
    },
  )
  return inFlight
}

/** Chats name these projects: read the list again once for any that no read had (a project made, or a chat moved into
 * one, elsewhere); one the person cannot see is asked about once, never in a loop. */
export function readForUnknown(ids: readonly string[]) {
  // a read on its way may have started before that project was there: look again once it is in
  if (inFlight) return void inFlight.then(() => readForUnknown(ids))
  const listed = useProjects.getState().listed
  if (!listed) return
  const unknown = ids.filter((id) => !listed.has(id) && !askedFor.has(id))
  if (!unknown.length) return
  for (const id of unknown) askedFor.add(id)
  void readProjectList()
}
