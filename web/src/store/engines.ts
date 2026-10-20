// Engine status and models for the composer's model picker. Only admins can read /api/admin/engines; other people
// pick the engine only and get the team's default model.
import { create } from 'zustand'
import type { EngineId } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface EnginesState {
  loaded: boolean
  models: Partial<Record<EngineId, { id: string; label: string }[]>>
  load: () => Promise<void>
}

export const useEngines = create<EnginesState>((set, get) => ({
  loaded: false,
  models: {},
  async load() {
    if (get().loaded) return
    try {
      const r = await api.call(API.engines)
      const models: EnginesState['models'] = {}
      for (const e of r.engines) if (e.enabled && e.status === 'ok') models[e.id] = e.models
      set({ loaded: true, models })
    } catch {
      set({ loaded: true, models: {} })
    }
  },
}))
