// Projects as this window last saw them, by id: a rename or a new project saved in one place (the project dialog, the
// Projects page) shows at once wherever the project is named (the chat header, Trina history's headers). Not a full
// list: places that list projects still ask the server.
//
// `listed`: the projects the latest plain read of the list (GET /api/projects, no `manage`) returned, so the ones the
// person sees now (docs/DECISIONS.md "Trina history by project"). One read for every list in this window (the
// 트리나 panel, the phone's 트리나 tab, which mounts again each time it opens): `readProjectList` keeps one request
// in flight and, when asked with `minAgeMs` (a window coming back to the front), skips a read that recent.
//
// `managed`: the list the Projects page shows (GET /api/projects?manage=1: for the owner and admins also the team
// projects they manage without being members), in the server's order, as last read. Going back to the page shows it at
// once and reads it again behind it (docs/DECISIONS.md "Projects and Files lists open at once"); a save or a delete here
// changes it in place (put, drop).
//
// A rename, the trash and a restore made here show at once (`showProject`, `hideProject`; lib/optimistic.ts keys
// `project:<id>:name|trash`): a list read answered while one is on its way keeps what is on screen (`keepPendingProject`).
import { create } from 'zustand'
import type { Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { optimisticPending } from '../lib/optimistic'

interface ProjectsState {
  byId: Record<string, Project>
  /** the ids of the latest plain list read; null before the first one ends (a failed read: an empty set) */
  listed: ReadonlySet<string> | null
  /** the latest manage=1 list read, in its order; null before the first one ends */
  managed: Project[] | null
  /** the Projects page changed its list (a card deleted or in the trash, members saved) */
  setManaged: (f: (items: Project[]) => Project[]) => void
  /** what the server answered for these projects */
  put: (...items: Project[]) => void
  /** gone, or no longer the person's to see; `fromList`: off the Projects page's list too (a delete or a not_found of
   * the manage=1 read; a plain read's not_found may be a project the owner or an admin manages without being in it) */
  drop: (id: string, fromList?: boolean) => void
  /** a project the person was just shown in a fresh list (the move dialog's): seen at once */
  see: (p: Project) => void
  /** signed out (App.tsx): nothing of one person's projects stays for the next */
  reset: () => void
}

/** a read started before a reset (another person signed in since) never lands */
let generation = 0
let inFlight: Promise<void> | null = null
let lastRead = 0
let managedRead: Promise<void> | null = null
/** asked again while a read was on its way (an event, a change made here): read once more after it */
let managedAgain = false
/** changes made here to the Projects page's list: an answer to a read started before one may not have it */
let managedEdits = 0
/** project ids a chat named that no read had: read once more for each, never again */
const askedFor = new Set<string>()

export const useProjects = create<ProjectsState>((set) => ({
  byId: {},
  listed: null,
  managed: null,
  put: (...items) => set((s) => {
    const fresh = Object.fromEntries(items.map((p) => [p.id, p]))
    return { byId: { ...s.byId, ...fresh }, ...(s.managed && s.managed.some((p) => p.id in fresh) ? { managed: s.managed.map((p) => fresh[p.id] ?? p) } : {}) }
  }),
  drop: (id, fromList = false) => set((s) => {
    const listedHere = fromList && !!s.managed?.some((p) => p.id === id)
    if (listedHere) managedEdits++
    if (!(id in s.byId) && !listedHere) return s
    const byId = { ...s.byId }
    delete byId[id]
    return { byId, ...(listedHere ? { managed: s.managed!.filter((p) => p.id !== id) } : {}) }
  }),
  setManaged: (f) => set((s) => {
    if (!s.managed) return s
    managedEdits++
    return { managed: f(s.managed) }
  }),
  see: (p) => set((s) => ({ byId: { ...s.byId, [p.id]: p }, listed: new Set([...(s.listed ?? []), p.id]) })),
  reset: () => {
    generation++
    inFlight = null
    lastRead = 0
    askedFor.clear()
    managedRead = null
    managedAgain = false
    set({ byId: {}, listed: null, managed: null })
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
      useProjects.getState().put(...r.items.map((p) => keepPendingProject(p)))
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

/** Read the Projects page's list (manage=1) again: one request at a time (`fresh`, after a change such as an access
 * event, while one is on its way: once more after it; a list shown joins it); until it ends, the last one stays on screen. Rejects when it fails (the page says so; what it showed stays). */
export function readManagedList(o: { fresh?: boolean } = {}): Promise<void> {
  if (managedRead) {
    if (o.fresh) managedAgain = true
    return managedRead
  }
  const mine = generation
  const edits = managedEdits
  const read: Promise<void> = api.call(API.listProjects, { query: { manage: '1' } }).then(
    (r) => {
      if (mine !== generation) return
      // changed here while it was asked (a delete, a save): this answer may be from before it (put would write its
      // older copies back too), read once more instead
      if (edits !== managedEdits) {
        managedAgain = true
        return
      }
      // a rename or the trash still on its way stays as on screen (this answer may be from before it)
      const managed = useProjects.getState().managed
      const items = r.items.flatMap((p) => {
        if (optimisticPending(`project:${p.id}:trash`) && managed && !managed.some((x) => x.id === p.id)) return []
        return [keepPendingProject(p)]
      })
      useProjects.getState().put(...items)
      useProjects.setState({ managed: items })
    },
  ).finally(() => {
    if (managedRead === read) managedRead = null
  })
  managedRead = read
  return read.then(
    () => {
      if (!managedAgain || mine !== generation) return
      managedAgain = false
      return readManagedList()
    },
    (e: unknown) => {
      managedAgain = false
      throw e
    },
  )
}

/** A project as the server sent it, with what a change made here and still on its way shows instead (its name, its
 * trash state): `onScreen` is the copy on screen (by default the store's). */
export function keepPendingProject(p: Project, onScreen: Project | null | undefined = useProjects.getState().byId[p.id]): Project {
  if (!onScreen || onScreen.id !== p.id) return p
  const name = optimisticPending(`project:${p.id}:name`)
  const trash = optimisticPending(`project:${p.id}:trash`)
  if (!name && !trash) return p
  return { ...p, ...(name ? { name: onScreen.name } : {}), ...(trash ? { inTrash: onScreen.inTrash, member: onScreen.member } : {}) }
}

/** A change made here, on screen at once wherever the project is named or listed (a read of the list on its way may be
 * from before it: it reads again). */
export function showProject(p: Project) {
  managedEdits++
  useProjects.getState().put(p)
}

/** Off the Projects page's list at once (in the trash for someone who does not keep it there); `at` its place, for
 * `unhideProject` when the server refuses. */
export function hideProject(id: string): number {
  const at = useProjects.getState().managed?.findIndex((p) => p.id === id) ?? -1
  useProjects.getState().setManaged((xs) => xs.filter((p) => p.id !== id))
  return at
}

/** Back on the list in its place (`at`, from hideProject) and in the store. */
export function unhideProject(p: Project, at: number) {
  useProjects.getState().setManaged((xs) => (xs.some((x) => x.id === p.id) ? xs : at < 0 ? [...xs, p] : [...xs.slice(0, at), p, ...xs.slice(at)]))
  showProject(p)
}
