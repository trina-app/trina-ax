// Who is signed in (GET /api/me), first-run setup state, and the person's language / theme / text size.
import { create } from 'zustand'
import { SETUP_TOKEN_HEADER, type Locale, type Me, type TextSize, type Theme, type UserPrefs } from '@mycel/shared/api'
import { api, API, isApiError } from '../lib/api'
import { optimistic, optimisticPending, optimisticPendingKeys } from '../lib/optimistic'
import { applyTheme, storedTheme, storeTheme } from '../lib/theme'
import { applyTextSize, pickTextSize, storedTextSize, storeTextSize, textSizeFailed, textSizeSettled, unsavedTextSize } from '../lib/textSize'
import { toast } from './ui'
import { browserLocale, loadLocale, pickLocale, t as tNow, recentLocale, storedLocale, storeLocale, storeRecentLocale, useLocaleStore } from '../i18n'
import { recoveryLocale } from '../i18n/recovery-locale'
import { forgetSetupToken, keptSetupToken, readSetupLink, rememberSetupToken } from '../lib/setupLink'
import { forgetFileUploads } from '../lib/fileUploads'
import { forgetFolderUploads } from '../lib/folderRuns'
import { forgetTeamAttach } from '../lib/teamAttach'
import { forgetStarters } from '../lib/starter'
import { forgetSkillList } from '../lib/skillTitles'
import { accountRemoved, guestRemoval, type SignedOutReason } from '../lib/signedOut'
import { meGuest, myUploadMax } from '../lib/guests'
import { freeRoamNow, useDemo } from './demo'

export type AuthStatus =
  | { kind: 'loading' }
  | { kind: 'setup'; teamName: string | null }
  // 'removed': an account taken out of the team. A guest turned off while signed in carries the team's name for the
  // sign-in page's guest line; a removed member (TC-1974, lib/signedOut.ts) has none (pages/Auth.tsx Login)
  // ownerRecoveryUrl: a hosted team's console page where its owner resets a forgotten password (GET /api/setup; the
  // sign-in page adds ?team=<its own host>); left out when the server sent none
  | { kind: 'signed-out'; reason?: SignedOutReason; team?: string; ownerRecoveryUrl?: string }
  | { kind: 'signed-in'; me: Me }
  | { kind: 'error'; error: unknown }

interface SessionState {
  status: AuthStatus
  load: () => Promise<void>
  /** after sign-in; `adoptPick`: a language picked on the sign-in screen becomes the account's own when it has none */
  signedIn: (me: Me, opts?: { adoptPick?: boolean }) => void
  signedOut: (reason?: SignedOutReason, team?: string) => void
  /** the team default or the person's language may have changed elsewhere (admin, another window): ask again */
  refreshMe: () => Promise<void>
  /** the language switcher of the sign-in style screens (also shown signed in: forced password change, reset) */
  pickLocale: (l: Locale) => void
  /** engine / model null = back to the team default. Shown at once; throws when refused (the screen is back to what the
   * account has); false: a newer pick replaced this one (its answer decides; nothing to say) */
  updatePrefs: (prefs: Omit<Partial<UserPrefs>, 'engine' | 'model' | 'away' | 'mentionAllAsk' | 'goalCard' | 'preparedCard' | 'autoMemory'> & { autoMemory?: 'off' | null; engine?: UserPrefs['engine'] | null; model?: string | null; mentionAllAsk?: 'off' | null; goalCard?: 'hidden' | null; preparedCard?: 'hidden' | null }) => Promise<boolean>
  /** the person's language: one of their own, or null = follow the team default */
  setLocale: (l: Locale | null) => Promise<void>
  setTheme: (t: Theme) => Promise<void>
  /** set myself away, or back to automatic (the account menu; docs/DECISIONS.md "접속 상태") */
  setAway: (away: boolean) => Promise<void>
  /** shown at once on this device; the account keeps it for the others */
  setTextSize: (s: TextSize) => Promise<void>
  /** What this module keeps beside the state, as at page load: the team default last seen, a language pick still to
   * save, a theme pick being saved, the first load. Only the web tests' file start calls it (test/unit/preload.ts runs
   * each store's reset()): without it, a file that signed in to a Korean team left the next file's sign-out in Korean. */
  reset: () => void
}

/** A guest turned off while signed in: the team's name, kept in this browser until the next sign-in, so the sign-in page
 * still says why on a later visit (the server's answer to their password is only "wrong"). */
const REMOVED_KEY = 'mycel.removedFrom'
/** ...and 'left' when the guest left their place themselves (guest walkthrough S5) */
const REMOVED_HOW_KEY = 'mycel.removedHow'
export function removedFrom(): string | null {
  try { return localStorage.getItem(REMOVED_KEY) } catch { return null }
}
export function removedHow(): 'left' | 'removed' {
  try { return localStorage.getItem(REMOVED_HOW_KEY) === 'left' ? 'left' : 'removed' } catch { return 'removed' }
}
function rememberRemoved(team: string | null, how: 'left' | 'removed' = 'removed') {
  try {
    if (team) { localStorage.setItem(REMOVED_KEY, team); localStorage.setItem(REMOVED_HOW_KEY, how) }
    else { localStorage.removeItem(REMOVED_KEY); localStorage.removeItem(REMOVED_HOW_KEY) }
  } catch { /* storage blocked: said only this time */ }
}
/** A guest's own screen (their account ended), or a removed member's sign-in page, in their language: their browser's (one of ours) unless they picked one
 * here, as their invite page was (guest walkthrough S10), not the team's (QA TC-3225/3226: a Korean guest of an English
 * team read English). */
function ownLanguage() {
  const mine = storedLocale() ? null : browserLocale(typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language])
  if (mine && mine !== useLocaleStore.getState().locale) useLocaleStore.getState().setLocale(mine)
}
/** The signed-out status for a member whose account was taken out of the team (not a guest): the sign-in page in their
 * browser's language too (QA rerun E: a removed member in a Korean browser read an English page of an English team),
 * unless they picked one here. */
function memberRemoved(): Extract<AuthStatus, { kind: 'signed-out' }> {
  ownLanguage()
  return { kind: 'signed-out', reason: 'removed' }
}
/** The signed-out status for a guest whose account ended (the 401 said so): their own screen, before any password. */
function guestSignedOut(g: { how: 'left' | 'removed'; team: string | null }, team?: string): Extract<AuthStatus, { kind: 'signed-out' }> {
  const name = g.team ?? team ?? null
  if (name) rememberRemoved(name, g.how)
  ownLanguage()
  return { kind: 'signed-out', reason: g.how, ...(name ? { team: name } : {}) }
}

function applyMe(me: Me) {
  // the server sends the language the person sees (own choice, else the team default)
  const locale = pickLocale(pendingPick ?? me.user.locale, me.team.defaultLocale)
  useLocaleStore.getState().setLocale(locale)
  storeRecentLocale(locale)
  const theme = me.user.prefs.theme ?? storedTheme()
  storeTheme(theme)
  applyTheme(theme)
  // the same way: the account's text size, else this device's (an account that never picked one keeps it); one the
  // person just picked and is still saving wins over an answer that left the server before it
  const textSize = unsavedTextSize() ?? me.user.prefs.textSize ?? storedTextSize()
  storeTextSize(textSize)
  applyTextSize(textSize)
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
/** the team default as last seen (GET /api/setup before sign-in, the account after); null while not known */
export const teamDefaultLocale = (): Locale | null => lastTeamDefault
/** GET /api/setup's ownerRecoveryUrl as last seen (null: none, or not asked yet), kept for the sign-in screen */
let lastOwnerRecovery: string | null = null
/** a signed-out status with the hosted team's owner-recovery page, when the server named one */
const withRecovery = <T extends Extract<AuthStatus, { kind: 'signed-out' }>>(st: T): T => (lastOwnerRecovery ? { ...st, ownerRecoveryUrl: lastOwnerRecovery } : st)
/** the latest theme pick still being saved (setTheme), and the theme in use before the picks not saved yet */
let themePick: { back: Theme } | null = null

/** The next person in this tab gets nothing of this one's composer chips, draft chats, last chat or uploads: on sign-out
 * and when another person signs in over this one (App.tsx useSessionLifecycle). */
export function forgetPersonInTab() {
  forgetTeamAttach()
  forgetStarters()
  forgetSkillList()
  forgetFileUploads()
  forgetFolderUploads()
}

/** What a sign-out empties in this window (App.tsx sets it: the live connection, the stores). It runs before another
 * person's sign-in over the signed-in one is shown, so no screen of the new person mounts on the last one's data. */
let beforePersonSwitch: () => void = () => {}
export function setBeforePersonSwitch(fn: () => void) {
  beforePersonSwitch = fn
}

/** The first read of who is signed in (main.tsx starts it before the first render, the app's Gate asks again on mount):
 * one request, shared while the screen still waits for it. A later load (Retry, after setup) always asks again. */
let booting: Promise<void> | null = null
/** The language a screen is about to show, loaded before the screen changes (index.ts loadLocale): the signed-in app
 * or the sign-in page comes up in its own words, not English first. A language that cannot load is shown later, or
 * not at all (the switch then keeps the language on screen). */
const wordsFor = (l: Locale) => loadLocale(l).catch(() => {})

type PrefsPatch = Partial<Record<keyof UserPrefs, unknown>>
/** the queues of preference changes: `me:prefs:<field>[,<field>]` */
const PREFS_KEY = 'me:prefs:'
/** my status (components/StatusMessage.tsx): its queue's key */
export const MY_STATUS_KEY = 'me:status'

/** the account with these preferences (null: back to the default, as the server leaves it out) */
function withPrefs(me: Me, v: PrefsPatch): Me {
  const prefs = { ...me.user.prefs } as Record<string, unknown>
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined) delete prefs[k]
    else prefs[k] = x
  }
  return { ...me, user: { ...me.user, prefs: prefs as UserPrefs } }
}

/** A read of my account (or an answer) that may be from before a change still on its way: the preferences and the
 * status of those changes stay as on screen. */
function keepPendingPrefs(me: Me, shown: SessionState['status']): Me {
  if (shown.kind !== 'signed-in' || shown.me.user.id !== me.user.id) return me
  let out = me
  for (const key of optimisticPendingKeys((k) => k.startsWith(PREFS_KEY))) {
    const fields = key.slice(PREFS_KEY.length).split(',') as (keyof UserPrefs)[]
    out = withPrefs(out, Object.fromEntries(fields.map((k) => [k, shown.me.user.prefs[k] ?? null])))
  }
  if (optimisticPending(MY_STATUS_KEY)) {
    const user = { ...out.user }
    if (shown.me.user.statusMessage) user.statusMessage = shown.me.user.statusMessage
    else delete user.statusMessage
    out = { ...out, user }
  }
  return out
}

export const useSession = create<SessionState>((set, get) => ({
  status: { kind: 'loading' },

  reset() {
    pendingPick = null
    pickedBeforeSignIn = false
    lastTeamDefault = null
    lastOwnerRecovery = null
    themePick = null
    booting = null
  },

  load() {
    if (booting && get().status.kind === 'loading') return booting
    const p = readMe(get, set)
    if (get().status.kind === 'loading') {
      booting = p
      const done = () => { if (booting === p) booting = null }
      p.then(done, done)
    }
    return p
  },

  signedIn(me, opts) {
    rememberRemoved(null)
    lastTeamDefault = me.team.defaultLocale
    const picked = storedLocale()
    if (opts?.adoptPick && pickedBeforeSignIn && picked && me.user.localeChoice === null && picked !== me.user.locale) pendingPick = picked
    pickedBeforeSignIn = false
    const before = get().status
    if (before.kind === 'signed-in' && before.me.user.id !== me.user.id) {
      // another person signed in over this one (a reset link on a shared computer): a sign-out first
      forgetPersonInTab()
      beforePersonSwitch()
    }
    // a read of my account from before a change still on its way (a preference, my status) keeps what is on screen
    const kept = keepPendingPrefs(me, before)
    applyMe(kept)
    set({ status: { kind: 'signed-in', me: kept } })
    if (pendingPick && !me.user.mustChangePassword) {
      const l = pendingPick
      pendingPick = null
      void get().setLocale(l).catch(() => {
        /* kept on screen; Settings > Language can save it again */
      })
    }
  },

  signedOut(reason, team) {
    forgetPersonInTab()
    pendingPick = null
    pickedBeforeSignIn = false
    storeRecentLocale(null)
    // the sign-in screen shows this browser's pick, else the team default: not the previous person's language
    // (requests before sign-in carry the screen's language, so their errors follow too)
    useLocaleStore.getState().setLocale(pickLocale(storedLocale(), lastTeamDefault))
    // a guest's (only a guest's 'removed' carries the team)
    if ((reason === 'removed' || reason === 'left') && team) { rememberRemoved(team, reason); ownLanguage() }
    // a member taken out of the team (the live link said so): their browser's language too (memberRemoved)
    else if (reason === 'removed') ownLanguage()
    set({ status: withRecovery({ kind: 'signed-out', reason, ...(team ? { team } : {}) }) })
    // ended from elsewhere (the live link said so, or it was refused): the server tells this sign-in's own holder when
    // the account was removed from the team, so the page does not say "you signed out elsewhere" (TC-1974); a guest
    // also learns whether they left their place themselves (guest walkthrough S5)
    if (reason === 'ended' || reason === 'expired' || reason === 'removed') {
      api.call(API.me).then(() => {}, (e) => {
        const st = get().status
        if (st.kind !== 'signed-out' || st.reason !== reason) return
        const g = guestRemoval(e)
        if (g) set({ status: withRecovery(guestSignedOut(g, st.team)) })
        else if (accountRemoved(e) && reason !== 'removed') set({ status: withRecovery(memberRemoved()) })
      })
    }
  },

  async refreshMe() {
    if (get().status.kind !== 'signed-in') return
    try {
      const me = await api.call(API.me)
      // the account as this window has it right now (a read that came in while this one was on its way already took the
      // change: no second toast)
      const before = get().status
      if (before.kind === 'signed-in') {
        get().signedIn(me)
        // an admin made this guest a team member while they are signed in: said once, in words (their windows already widen)
        if (before.kind === 'signed-in' && before.me.user.role === 'guest' && me.user.role !== 'guest') toast({ level: 'info', text: tNow('guest.nowMember') })
        // their AI was switched off meanwhile: the AI place leaves the menu, so one quiet line says why (guest walkthrough
        // N7), not a tab that is simply gone
        else {
          const was = meGuest(before.me)?.ai, now = meGuest(me)?.ai
          if (was && was !== 'none' && now === 'none') toast({ level: 'info', text: tNow('guest.aiTurnedOff') })
        }
      }
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
    if (st.kind !== 'signed-in') return false
    // shown at once (lib/optimistic.ts), one queue per set of fields (the engine with its model): a refusal puts back
    // what the account last had and is thrown for the caller to say; an older pick refused under a newer one says
    // nothing. Only what changed is sent: the server merges it into the rest (routes/auth.ts), so two saves close
    // together (the text size and then the theme) never put back each other's old value
    const fields = Object.keys(prefs).sort() as (keyof UserPrefs)[]
    const from = Object.fromEntries(fields.map((k) => [k, st.me.user.prefs[k] ?? null])) as PrefsPatch
    const r = await optimistic({
      key: `${PREFS_KEY}${fields.join(',')}`, from, to: prefs as PrefsPatch,
      show: (v) => {
        const cur = get().status
        if (cur.kind === 'signed-in') set({ status: { kind: 'signed-in', me: withPrefs(cur.me, v) } })
      },
      send: () => api.call(API.updateMe, { body: { prefs } }),
      confirmed: (me) => Object.fromEntries(fields.map((k) => [k, me.user.prefs[k] ?? null])) as PrefsPatch,
      // the account as the server has it, but with what another pick still being saved shows
      settle: (me) => set({ status: { kind: 'signed-in', me: keepPendingPrefs(me, get().status) } }),
      failText: false,
    })
    if (!r.ok && r.newest) throw r.error
    return r.ok && r.newest
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
    // shown at once. A save that fails (offline) puts back the theme in use before, else the screen would stay in a
    // theme the account does not have and go back to the old one at the next reload or in another tab, with no word;
    // the caller says why (QA TC-239). Only the latest pick decides: an earlier pick's answer never undoes a later one
    const pick = { back: themePick?.back ?? storedTheme() }
    themePick = pick
    storeTheme(theme)
    applyTheme(theme)
    try {
      await get().updatePrefs({ theme })
      if (themePick === pick) themePick = null
    } catch (e) {
      if (themePick === pick) {
        themePick = null
        // what the account has (an earlier pick may have been saved meanwhile), else what this device used
        const st = get().status
        const back = (st.kind === 'signed-in' ? st.me.user.prefs.theme : undefined) ?? pick.back
        storeTheme(back)
        applyTheme(back)
      }
      throw e
    }
  },

  async setAway(away) {
    const st = get().status
    if (st.kind !== 'signed-in') return
    const put = (v: boolean) => {
      const cur = get().status
      if (cur.kind === 'signed-in') set({ status: { kind: 'signed-in', me: { ...cur.me, user: { ...cur.me.user, prefs: { ...cur.me.user.prefs, away: v || undefined } } } } })
    }
    // the menu's word follows at once; the server keeps it and tells the team
    const before = !!st.me.user.prefs.away
    put(away)
    try {
      await api.call(API.setMyAway, { body: { away } })
    } catch (e) {
      put(before)
      throw e
    }
  },

  async setTextSize(textSize) {
    pickTextSize(textSize)
    try {
      await get().updatePrefs({ textSize })
      textSizeSettled(textSize)
    } catch (e) {
      // back to the account's size (the caller says why); a later pick still being saved is left alone
      const st = get().status
      textSizeFailed(textSize, st.kind === 'signed-in' ? st.me.user.prefs.textSize : undefined)
      throw e
    }
  },
}))

type Get = () => SessionState
type Set = (s: Partial<SessionState>) => void

/** GET /api/me and what follows from its answer (useSession.load). */
async function readMe(get: Get, set: Set): Promise<void> {
  try {
    const me = await api.call(API.me)
    await wordsFor(pickLocale(pendingPick ?? me.user.locale, me.team.defaultLocale))
    get().signedIn(me)
  } catch (e) {
    if (isApiError(e, 'unauthorized') || (isApiError(e) && e.status === 401)) {
      storeRecentLocale(null)
      // Even if setup cannot be fetched, a retired account's recovery language must not reach sign-in.
      useLocaleStore.getState().setLocale(pickLocale(storedLocale(), lastTeamDefault))
      try {
        // the setup link's token, if this tab was opened with one (kept for a reload: lib/setupLink.ts): through the
        // relay the server says setup is still needed only to a visitor who has it (server/src/auth/accounts.ts
        // setupStatusFor)
        const link = typeof location === 'undefined' ? null : readSetupLink(location)
        const linked = link?.token ?? null
        rememberSetupToken(linked, link?.team ? { team: link.team, lang: link.lang } : null)
        const token = linked ?? keptSetupToken()
        const s = await api.call(API.setupStatus, token ? { headers: { [SETUP_TOKEN_HEADER]: token } } : {})
        // a kept token the server did not take (spent, or wrong) is not sent again: each try counts toward the
        // per-address token limit that everyone behind this address shares
        if (!s.needed) forgetSetupToken()
        lastTeamDefault = s.defaultLocale ?? null
        lastOwnerRecovery = s.ownerRecoveryUrl ?? null
        // before sign-in: the visitor's pick on this browser, else the team default (also tells the desktop app)
        const locale = pickLocale(storedLocale(), s.defaultLocale)
        await wordsFor(locale)
        useLocaleStore.getState().setLocale(locale)
        // a guest switched off while away: their own screen at once, not a plain sign-in (guest walkthrough S6)
        const g = guestRemoval(e)
        set({ status: s.needed ? { kind: 'setup', teamName: s.teamName } : withRecovery(g ? guestSignedOut(g) : accountRemoved(e) ? memberRemoved() : { kind: 'signed-out' }) })
      } catch {
        // a free-roam demo's gate denies GET /api/setup (demo-gate DENY_PATHS): the instance's language comes from
        // GET /api/demo, which the gate lets through (QA TC-6790: a ja instance's sign-in page was English only)
        const own = await demoLocale()
        if (own) {
          lastTeamDefault = own
          const locale = pickLocale(storedLocale(), own)
          await wordsFor(locale)
          useLocaleStore.getState().setLocale(locale)
        }
        const g = guestRemoval(e)
        set({ status: g ? guestSignedOut(g) : accountRemoved(e) ? memberRemoved() : { kind: 'signed-out' } })
      }
      return
    }
    // Only the error screen uses the recovery hint. A server response still decides account/team language.
    const locale = recoveryLocale(recentLocale(), storedLocale())
    await wordsFor(locale)
    useLocaleStore.getState().setLocale(locale)
    set({ status: { kind: 'error', error: e } })
  }
}

/** The team default language a demo server says (GET /api/demo `locale`), or null: not a demo server, an older one,
 * or no answer. Read through the demo store, so the page asks once. */
async function demoLocale(): Promise<Locale | null> {
  try { return (await useDemo.getState().load())?.locale ?? null } catch { return null }
}

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
/** may make team projects (projects/<name>): the owner and admins always, members when the team lets them
 * (Me.team.projectCreators, Admin › Team settings), never a guest. The server's mayCreateTeamProject decides anyway. */
export const mayMakeTeamProject = (me: Me | null) => !!me?.user && me.user.role !== 'guest' && (isAdmin(me) || me.team?.projectCreators === 'members')
/** may pick the AI engine / model (composer picker, "retry with another model", own default): owner and admins always,
 * others when Admin > AI providers allows them. The server enforces it; an older server without the field: admins only. */
// a free-roam demo's visitor never picks or sees which AI answers (docs/decisions/20261119-demo-free-roam-web.md): its
// demo info is read before the app's screens (App.tsx), so this holds from the first one
export const canChooseEngine = (me: Me | null) => !!me && !freeRoamNow() && (me.user.canChooseEngine ?? isAdmin(me))

/** The largest file whoever is signed in now may upload (lib/guests.ts myUploadMax), for code outside a component (a
 * drop handler, a folder upload's limits). */
export const myUploadMaxNow = (otherwise: number): number => {
  const st = useSession.getState().status
  return myUploadMax(st.kind === 'signed-in' ? st.me : null, otherwise)
}
