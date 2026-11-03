// Projects as this window last saw them, by id: a rename or a new project saved in one place (the project dialog, the
// Projects page) shows at once wherever the project is named (the chat header). Not a full list: places that list
// projects still ask the server.
import { create } from 'zustand'
import type { Project } from '@mycel/shared/api'

interface ProjectsState {
  byId: Record<string, Project>
  /** what the server answered for these projects */
  put: (...items: Project[]) => void
  /** gone, or no longer the person's to see */
  drop: (id: string) => void
}

export const useProjects = create<ProjectsState>((set) => ({
  byId: {},
  put: (...items) => set((s) => ({ byId: { ...s.byId, ...Object.fromEntries(items.map((p) => [p.id, p])) } })),
  drop: (id) => set((s) => {
    if (!(id in s.byId)) return s
    const byId = { ...s.byId }
    delete byId[id]
    return { byId }
  }),
}))
