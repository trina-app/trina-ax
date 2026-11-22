// Guest walkthrough fixes on the screens (docs/DECISIONS.md "Guest walkthrough A"): the guest's ended sign-in says
// whether they left or were taken out, with the team (S5, S6); a guest link's ready-to-paste message (S7); the guest cap
// read with the links that hold a place (M4); a guest's AI switched off while signed in says so once (N7).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ApiError, type GuestInviteLimit, type Me } from '@mycel/shared/api'
import { t, translate, useLocaleStore } from '../../src/i18n'
import { guestRemoval } from '../../src/lib/signedOut'
import { removedFrom, removedHow, useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { guestCap, guestLinkMessage, guestsFullOf } from '../../src/components/GuestInvite'

const originalFetch = globalThis.fetch
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const session = () => useSession.getState()
const mockFetch = (handler: () => Promise<Response>) => Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: handler })
const unauthorized = (params?: Record<string, string>) => async () =>
  Response.json({ error: { code: 'unauthorized', message: 'Please sign in.', ...(params ? { params } : {}) } }, { status: 401 })
const settle = () => new Promise((r) => setTimeout(r, 20))
const status = () => session().status

beforeEach(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) }, removeItem: (k: string) => { values.delete(k) },
  } })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  useSession.setState({ status: { kind: 'loading' } })
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('a guest whose sign-in ended with their account (S5, S6)', () => {
  test('the 401 says left or removed, with the team; anyone else, nothing', () => {
    const e = (params?: Record<string, string>) => new ApiError(401, { code: 'unauthorized', message: 'Please sign in.', ...(params ? { params } : {}) })
    expect(guestRemoval(e({ reason: 'account_removed', guest: 'left', team: 'Acme' }))).toEqual({ how: 'left', team: 'Acme' })
    expect(guestRemoval(e({ reason: 'account_removed', guest: 'removed' }))).toEqual({ how: 'removed', team: null })
    expect(guestRemoval(e({ reason: 'account_removed' }))).toBeNull()
    expect(guestRemoval(e({ guest: 'left' }))).toBeNull()
    expect(guestRemoval(e())).toBeNull()
  })

  test('opening the app after being taken out: the guest screen at once, remembered for a later visit', async () => {
    let n = 0
    mockFetch(async () => (n++ === 0 ? unauthorized({ reason: 'account_removed', guest: 'removed', team: 'Acme' })() : Response.json({ needed: false, teamName: null, defaultLocale: 'en' })))
    await session().load()
    expect(status()).toEqual({ kind: 'signed-out', reason: 'removed', team: 'Acme' })
    expect(removedFrom()).toBe('Acme')
    expect(removedHow()).toBe('removed')
  })

  test('the live link ends a guest who left: the screen says they left', async () => {
    mockFetch(unauthorized({ reason: 'account_removed', guest: 'left', team: 'Acme' }))
    session().signedOut('removed', 'Acme')
    await settle()
    expect(status()).toEqual({ kind: 'signed-out', reason: 'left', team: 'Acme' })
    expect(removedHow()).toBe('left')
    expect(t('auth.guestLeftTitle', { team: 'Acme' })).toBe('You left Acme')
  })

  test("the guest's screen speaks their browser's language, not the team's, unless they picked one here", async () => {
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['ko-KR', 'en-US'], language: 'ko-KR' } })
    try {
      useLocaleStore.getState().setLocale('en')
      let n = 0
      mockFetch(async () => (n++ === 0 ? unauthorized({ reason: 'account_removed', guest: 'removed', team: 'Acme' })() : Response.json({ needed: false, teamName: null, defaultLocale: 'en' })))
      await session().load()
      await settle()
      expect(status()).toEqual({ kind: 'signed-out', reason: 'removed', team: 'Acme' })
      expect(useLocaleStore.getState().locale).toBe('ko')
      // picked on this browser: that stays
      localStorage.setItem('mycel.locale', 'en')
      useLocaleStore.getState().setLocale('en')
      mockFetch(unauthorized({ reason: 'account_removed', guest: 'left', team: 'Acme' }))
      session().signedOut('removed', 'Acme')
      await settle()
      expect(status()).toEqual({ kind: 'signed-out', reason: 'left', team: 'Acme' })
      expect(useLocaleStore.getState().locale).toBe('en')
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      else Reflect.deleteProperty(globalThis, 'navigator')
      useLocaleStore.getState().setLocale('en')
    }
  })

  test("a removed member's sign-in page speaks their browser's language too, not the team's (QA rerun E)", async () => {
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['ko-KR', 'en-US'], language: 'ko-KR' } })
    try {
      useLocaleStore.getState().setLocale('en')
      let n = 0
      mockFetch(async () => (n++ === 0 ? unauthorized({ reason: 'account_removed' })() : Response.json({ needed: false, teamName: null, defaultLocale: 'en' })))
      await session().load()
      await settle()
      expect(status()).toEqual({ kind: 'signed-out', reason: 'removed' })
      expect(useLocaleStore.getState().locale).toBe('ko')
      // the live link ends a member: the same
      useLocaleStore.getState().setLocale('en')
      mockFetch(unauthorized({ reason: 'account_removed' }))
      session().signedOut('removed')
      await settle()
      expect(useLocaleStore.getState().locale).toBe('ko')
      // a plain sign-out keeps the team's language
      useLocaleStore.getState().setLocale('en')
      mockFetch(unauthorized())
      session().signedOut('ended')
      await settle()
      expect(useLocaleStore.getState().locale).toBe('en')
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      else Reflect.deleteProperty(globalThis, 'navigator')
      useLocaleStore.getState().setLocale('en')
    }
  })

  test('a removed member keeps the plain removed line', async () => {
    mockFetch(unauthorized({ reason: 'account_removed' }))
    session().signedOut('removed')
    await settle()
    expect(status()).toEqual({ kind: 'signed-out', reason: 'removed' })
  })
})

describe('a guest link and the cap (S7, M4)', () => {
  test('the message names who sends it, the one place, their own AI when it is theirs, and the link with its end', () => {
    const place = { kind: 'room' as const, id: 'r', name: 'Quote prep' }
    const m = guestLinkMessage(t, { name: 'Mia', place, url: 'https://acme.example/invite/abc', until: 'Nov 22', ownAi: false })
    expect(m.split('\n')[0]).toContain("Hi, it's Mia. I'm inviting you to our 'Quote prep' group chat on ")
    expect(m).toContain("You'll see only this group chat.")
    expect(m.endsWith('until Nov 22:\nhttps://acme.example/invite/abc')).toBe(true)
    const own = guestLinkMessage(t, { name: '', place: { ...place, kind: 'project' }, url: 'u', until: 'd', ownAi: true })
    expect(own.startsWith("Hi! I'm inviting you to our 'Quote prep' project on ")).toBe(true)
    expect(own).toContain(t('teamLink.msg.ownAi'))
    const ko = guestLinkMessage((k, p) => translate('ko', k, p), { name: '미아', place, url: 'u', until: '11월 22일', ownAi: false })
    expect(ko).toContain("'Quote prep' 그룹 대화에 초대할게요. 이 그룹 대화만 보여요.")
    // a room with a name of its own is a private channel, and the message says so (TC-4461)
    const channel = { ...place, privateChannel: true }
    expect(guestLinkMessage(t, { name: 'Mia', place: channel, url: 'u', until: 'd', ownAi: false })).toContain("I'm inviting you to our 'Quote prep' private channel on ")
    expect(guestLinkMessage(t, { name: '', place: channel, url: 'u', until: 'd', ownAi: false })).toContain("You'll see only this private channel.")
    expect(guestLinkMessage((k, p) => translate('ko', k, p), { name: '미아', place: channel, url: 'u', until: 'd', ownAi: false })).toContain("'Quote prep' 비공개 채널에 초대할게요. 이 비공개 채널만 보여요.")
  })

  test('the links that hold a place come with a full cap, from the read and from a refused Create link', () => {
    const limit: GuestInviteLimit = { full: true, limit: 3, pending: 2 }
    expect(guestsFullOf(limit)).toEqual({ n: 3, pending: 2 })
    expect(guestsFullOf({ full: false, limit: 3 })).toBeNull()
    const refused = new ApiError(409, { code: 'plan_limit', message: 'full', params: { reason: 'guest_limit', limit: 3, pending: 1 } })
    expect(guestCap(refused)).toEqual({ n: 3, pending: 1 })
    expect(guestCap(new ApiError(409, { code: 'plan_limit', message: 'full', params: { reason: 'guest_limit', limit: 3 } }))).toEqual({ n: 3 })
    expect(t('guest.fullPending', { n: 2 })).toBe('This includes 2 invite links nobody has used yet.')
  })
})

describe("a guest's AI switched off while signed in (N7)", () => {
  test('one quiet line, once; not for a member nor for a Team AI account that was deleted', async () => {
    const me = (ai: string, extra: Record<string, unknown> = {}) => ({
      user: { id: 'g', username: 'gus', name: 'Gus', email: null, role: 'guest', locale: 'en', localeChoice: 'en', mustChangePassword: false, prefs: {} },
      team: { name: 'Acme', defaultLocale: 'en' }, groups: [],
      session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' },
      server: { version: 'test', dev: true },
      guest: { places: [{ kind: 'room', id: 'r', name: 'Quote prep' }], ai: ai === 'team' ? { mode: 'team', credentialId: 'c', limitUsd: 20 } : { mode: ai }, ...extra },
    }) as unknown as Me
    const toasts = () => useUi.getState().toasts.map((x) => x.text)
    useUi.setState({ toasts: [] })
    const before = 0
    useSession.setState({ status: { kind: 'signed-in', me: me('team') } })
    mockFetch(async () => Response.json(me('none')))
    await session().refreshMe()
    expect(toasts().slice(before)).toEqual([t('guest.aiTurnedOff')])
    // already off: nothing more
    await session().refreshMe()
    expect(toasts().length).toBe(before + 1)
    // a deleted Team AI account keeps the AI place (meGuest says 'team'): no line
    useSession.setState({ status: { kind: 'signed-in', me: me('team') } })
    mockFetch(async () => Response.json(me('none', { teamAiGone: true })))
    await session().refreshMe()
    expect(toasts().length).toBe(before + 1)
  })
})
