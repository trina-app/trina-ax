// Who is signed in (GET /api/me), first-run setup state, and the person's language / theme.
import { create } from 'zustand'
import type { Locale, Me, Theme, UserPrefs } from '@mycel/shared/api'
import { api, API, isApiError } from '../lib/api'
import { applyTheme, storedTheme, storeTheme } from '../lib/theme'
import { pickLocale, storedLocale, storeLocale, useLocaleStore } from '../i18n'
import { forgetTeamAttach } from '../lib/teamAttach'
import { applyTeamIcon } from '../lib/team-icon'

export type AuthStatus =
  | { kind: 'loading' }
  | { kind: 'setup'; teamName: string | null }
  | { kind: 'signed-out'; reason?: 'expired' | 'ended' }
  | { kind: 'signed-in'; me: Me }
  | { kind: 'error'; error: unknown }

interface SessionState {
  status: AuthStatus
  load: () => Promise<void>
  /** after sign-in; `adoptPick`: a language picked on the sign-in screen becomes the account's own when it has none */
  signedIn: (me: Me, opts?: { adoptPick?: boolean }) => void
  signedOut: (reason?: 'expired' | 'ended') => void
  /** the team default or the person's language may have changed elsewhere (admin, another window): ask again */
  refreshMe: () => Promise<void>
  /** the language switcher of the sign-in style screens (also shown signed in: forced password change, reset) */
  pickLocale: (l: Locale) => void
  /** engine / model null = back to the team default */
  updatePrefs: (prefs: Omit<Partial<UserPrefs>, 'engine' | 'model'> & { engine?: UserPrefs['engine'] | null; model?: string | null }) => Promise<void>
  /** the person's language: one of their own, or null = follow the team default */
  setLocale: (l: Locale | null) => Promise<void>
  setTheme: (t: Theme) => Promise<void>
}

function applyMe(me: Me) {
  // the server sends the language the person sees (own choice, else the team default)
  useLocaleStore.getState().setLocale(pickLocale(pendingPick ?? me.user.locale, me.team.defaultLocale))
  const theme = me.user.prefs.theme ?? storedTheme()
  storeTheme(theme)
  applyTheme(theme)
  // the team's logo as the tab icon (or the default mark again after an admin removed it)
  applyTeamIcon(me.team.iconVersion)
}

/**
 * A language picked on a sign-in style screen that is still to be saved to the account: picked before signing in
 * by a person without a language of their own, or picked on the forced password change screen (the account can only
 * be changed once the password is). Saved by the first applyMe that can; shown meanwhile.
 */
let pendingPick: Locale | null = null
/** the visitor used the switcher on this page before signing in (an older pick on this browser may be someone else's) */
let pickedBeforeSignIn = false
/** team default as last seen, for the sign-in screen after a sign-out */
let lastTeamDefault: Locale | null = null

export const useSession = create<SessionState>((set, get) => ({
  status: { kind: 'loading' },

  async load() {
    try {
      const me = await api.call(API.me)
      get().signedIn(me)
    } catch (e) {
      if (isApiError(e, 'unauthorized') || (isApiError(e) && e.status === 401)) {
        try {
          const s = await api.call(API.setupStatus)
          lastTeamDefault = s.defaultLocale ?? null
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

  signedIn(me, opts) {
    lastTeamDefault = me.team.defaultLocale
    const picked = storedLocale()
    if (opts?.adoptPick && pickedBeforeSignIn && picked && me.user.localeChoice === null && picked !== me.user.locale) pendingPick = picked
    pickedBeforeSignIn = false
    applyMe(me)
    set({ status: { kind: 'signed-in', me } })
    if (pendingPick && !me.user.mustChangePassword) {
      const l = pendingPick
      pendingPick = null
      void get().setLocale(l).catch(() => {
        /* kept on screen; Settings > Language can save it again */
      })
    }
  },

  signedOut(reason) {
    // the next person in this tab gets nothing of this one's composer chips, draft chats or last chat
    forgetTeamAttach()
    pendingPick = null
    pickedBeforeSignIn = false
    // the sign-in screen shows this browser's pick, else the team default: not the previous person's language
    // (requests before sign-in carry the screen's language, so their errors follow too)
    useLocaleStore.getState().setLocale(pickLocale(storedLocale(), lastTeamDefault))
    set({ status: { kind: 'signed-out', reason } })
  },

  async refreshMe() {
    if (get().status.kind !== 'signed-in') return
    try {
      const me = await api.call(API.me)
      if (get().status.kind === 'signed-in') get().signedIn(me)
    } catch {
      /* signed out or offline: the realtime connection reports that */
    }
  },

  pickLocale(l) {
    storeLocale(l)
    const st = get().status
    if (st.kind !== 'signed-in') {
      pickedBeforeSignIn = true
      useLocaleStore.getState().setLocale(l)
      return
    }
    if (st.me.user.mustChangePassword) {
      // the account cannot be changed before the password is: show it now, save it right after
      pendingPick = l
      useLocaleStore.getState().setLocale(l)
      return
    }
    void get().setLocale(l).catch(() => {})
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
/** may pick the AI engine / model (composer picker, "retry with another model", own default): owner and admins always,
 * others when Admin > AI engines allows them. The server enforces it; an older server without the field: admins only. */
export const canChooseEngine = (me: Me | null) => !!me && (me.user.canChooseEngine ?? isAdmin(me))
