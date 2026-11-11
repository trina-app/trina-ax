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
}

// the request on its way: everything that asks while it is (each answer's "answered by" button) waits for that one
let loading: Promise<void> | null = null

export const useEngines = create<EnginesState>((set, get) => ({
  loaded: false,
  canChoose: false,
  engines: [],
  models: {},
  defaultEngine: 'claude-code',
  defaultModel: null,
  load(force) {
    if (get().loaded && !force) return Promise.resolve()
    if (loading && !force) return loading
    const run: Promise<void> = api.call(API.chatEngines).then((r) => {
      const models: EnginesState['models'] = {}
      for (const e of r.engines) models[e.id] = e.models
      set({ loaded: true, canChoose: r.canChoose, engines: r.engines.map((e) => e.id), models, defaultEngine: r.defaultEngine, defaultModel: r.defaultModel })
    }, () => {
      set({ loaded: true, canChoose: false, engines: [], models: {} })
    }).finally(() => {
      if (loading === run) loading = null
    })
    loading = run
    return run
  },
}))
