// What the composer's engine / model picker may offer this person (GET /api/engines). The engine and model are the
// admin's choice (Admin > AI providers): owner and admins always pick; other people only when the admin allows them.
// Everyone else never sees a picker and never sends an engine or model (the server would refuse it).
import { create } from 'zustand'
import type { EngineId } from '@mycel/shared/api'
import { api, API } from '../lib/api'

type Models = { id: string; label: string }[]

interface EnginesState {
  loaded: boolean
  canChoose: boolean
  /** engines this person may pick (switched on), in order */
  engines: EngineId[]
  models: Partial<Record<EngineId, Models>>
  defaultEngine: EngineId
  defaultModel: string | null
  load: (force?: boolean) => Promise<void>
  /** signed out, or another person signed in in this window: nothing of the last person's list stays */
  reset: () => void
}

// the request on its way: everything that asks while it is (each answer's "answered by" button) waits for that one
let loading: Promise<void> | null = null
/** the list in hand is the server's answer: a failed read shows no picker but is asked again by the next load() */
let answered = false
/** bumped by reset: an answer to a request made before it (the last person's) is dropped */
let generation = 0

const EMPTY = { loaded: false, canChoose: false, engines: [] as EngineId[], models: {}, defaultEngine: 'claude-code' as EngineId, defaultModel: null }

export const useEngines = create<EnginesState>((set, get) => ({
  ...EMPTY,
  load(force) {
    if (get().loaded && answered && !force) return Promise.resolve()
    if (loading && !force) return loading
    const gen = generation
    const run: Promise<void> = api.call(API.chatEngines).then((r) => {
      if (gen !== generation) return
      const models: EnginesState['models'] = {}
      for (const e of r.engines) models[e.id] = e.models
      answered = true
      set({ loaded: true, canChoose: r.canChoose, engines: r.engines.map((e) => e.id), models, defaultEngine: r.defaultEngine, defaultModel: r.defaultModel })
    }, () => {
      if (gen !== generation) return
      answered = false
      set({ loaded: true, canChoose: false, engines: [], models: {} })
    }).finally(() => {
      if (loading === run) loading = null
    })
    loading = run
    return run
  },
  reset() {
    generation++
    loading = null
    answered = false
    set({ ...EMPTY })
  },
}))
