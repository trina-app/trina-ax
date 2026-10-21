// Who is signed in (GET /api/me), first-run setup state, and the person's language / theme.
import { create } from 'zustand'
import type { Locale, Me, Theme, UserPrefs } from '@mycel/shared/api'
import { api, API, isApiError } from '../lib/api'
import { applyTheme, storedTheme, storeTheme } from '../lib/theme'
import { pickLocale, storedLocale, useLocaleStore } from '../i18n'

export type AuthStatus =
  | { kind: 'loading' }
  | { kind: 'setup'; teamName: string | null }
  | { kind: 'signed-out'; reason?: 'expired' | 'ended' }
  | { kind: 'signed-in'; me: Me }
  | { kind: 'error'; error: unknown }

interface SessionState {
  status: AuthStatus
  load: () => Promise<void>
  signedIn: (me: Me) => void
  signedOut: (reason?: 'expired' | 'ended') => void
  updatePrefs: (prefs: Partial<UserPrefs>) => Promise<void>
  /** the person's language: one of their own, or null = follow the team default */
  setLocale: (l: Locale | null) => Promise<void>
  setTheme: (t: Theme) => Promise<void>
}

function applyMe(me: Me) {
  // the server sends the language the person sees (own choice, else the team default)
  useLocaleStore.getState().setLocale(pickLocale(me.user.locale, me.team.defaultLocale))
  const theme = me.user.prefs.theme ?? storedTheme()
  storeTheme(theme)
  applyTheme(theme)
}

export const useSession = create<SessionState>((set, get) => ({
  status: { kind: 'loading' },

  async load() {
    try {
      const me = await api.call(API.me)
      applyMe(me)
      set({ status: { kind: 'signed-in', me } })
    } catch (e) {
      if (isApiError(e, 'unauthorized') || (isApiError(e) && e.status === 401)) {
        try {
          const s = await api.call(API.setupStatus)
          // before sign-in: the visitor's pick on this browser, else the team default (also tells the desktop app)
          useLocaleStore.getState().setLocale(pickLocale(storedLocale(), s.defaultLocale))
          set({ status: s.needed ? { kind: 'setup', teamName: s.teamName } : { kind: 'signed-out' } })
        } catch {
          set({ status: { kind: 'signed-out' } })
        }
        return
      }
      set({ status: { kind: 'error', error: e } })
    }
  },

  signedIn(me) {
    applyMe(me)
    set({ status: { kind: 'signed-in', me } })
  },

  signedOut(reason) {
    set({ status: { kind: 'signed-out', reason } })
  },

  async updatePrefs(prefs) {
    const st = get().status
    if (st.kind !== 'signed-in') return
    const me = await api.call(API.updateMe, { body: { prefs: { ...st.me.user.prefs, ...prefs } } })
    set({ status: { kind: 'signed-in', me } })
  },

  async setLocale(choice) {
    const st = get().status
    if (st.kind !== 'signed-in') {
      if (choice) useLocaleStore.getState().setLocale(choice)
      return
    }
    // show it at once; the server's answer (the language it will use for this person) settles it
    const before = useLocaleStore.getState().locale
    useLocaleStore.getState().setLocale(choice ?? st.me.team.defaultLocale)
    try {
      const me = await api.call(API.updateMe, { body: { locale: choice } })
      applyMe(me)
      set({ status: { kind: 'signed-in', me } })
    } catch (e) {
      useLocaleStore.getState().setLocale(before)
      throw e
    }
  },

  async setTheme(theme) {
    storeTheme(theme)
    applyTheme(theme)
    await get().updatePrefs({ theme })
  },
}))

export function useMe(): Me | null {
  return useSession((s) => (s.status.kind === 'signed-in' ? s.status.me : null))
}

/** For components that only render signed in. */
export function useMeStrict(): Me {
  const me = useMe()
  if (!me) throw new Error('not signed in')
  return me
}

export const isAdmin = (me: Me | null) => me?.user.role === 'admin' || me?.user.role === 'owner'
export const isOwner = (me: Me | null) => me?.user.role === 'owner'
