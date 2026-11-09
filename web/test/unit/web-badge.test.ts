// An installed web app's icon badge (store/sessionMarkers.ts, the Badging API): the same n as the tab title and the
// desktop app's Dock (chats and rooms that want me, a hidden room never), set once a burst of changes settles; at 0 the
// browser's dot while a room I did not turn off or hide has unread messages n does not count, else cleared, and when
// this window stops; never inside the desktop app (its own badge) or the phone app; no API, a refusal or a throw changes
// nothing. The settings line (components/settings/PushNotifications.tsx badgeHintKey): only on an
// installed web app that can badge, with the place for its system.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Chat, type Me } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { currentCount, startSessionMarkers, stopSessionMarkers, useSessionMarkers, WEB_BADGE_MS } from '../../src/store/sessionMarkers'
import { badgeHintKey } from '../../src/components/settings/PushNotifications'
import { ME, room } from './rooms-fixtures'
import { MOBILE_CAPABILITIES, type MobileConfig } from '../../../mobile/src/protocol'

const chat = (o: Partial<Chat> = {}): Chat => ({ id: uuidv7(), projectId: null, title: 'Weekly report', engine: 'claude-code', model: null, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:10.000Z', deletedAt: null, runState: 'idle', ...o })
const settle = () => new Promise((r) => setTimeout(r, WEB_BADGE_MS + 30))

describe('the icon of an installed web app', () => {
  const g = globalThis as Record<string, unknown>
  let saved: Record<string, PropertyDescriptor | undefined> = {}
  const stub = (name: string, value: unknown) => {
    if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  let calls: (number | 'clear' | 'dot')[] = []
  /** navigator with the Badging API; `answer` decides how each call ends */
  let answer: () => Promise<void> = async () => {}
  const badging = (o: { clear?: boolean } = {}) => ({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130',
    setAppBadge: (n?: number) => { calls.push(n === undefined ? 'dot' : n); return answer() },
    ...(o.clear === false ? {} : { clearAppBadge: () => { calls.push('clear'); return answer() } }),
  })
  beforeEach(() => {
    saved = {}
    calls = []
    answer = async () => {}
    stub('document', { visibilityState: 'visible', hidden: false, hasFocus: () => true, addEventListener: () => {}, removeEventListener: () => {} })
    stub('window', { matchMedia: () => ({ matches: false }) })
    useChats.setState({ chats: [], requests: {}, chatsLoaded: true })
    useRooms.setState({ rooms: [], openRoomId: null, alerts: null })
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as Me } })
  })
  afterEach(() => {
    stopSessionMarkers()
    for (const [name, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, name, d)
      else delete g[name]
    }
    useSessionMarkers.setState({ visible: false, onScreen: null })
    useChats.getState().reset()
    useRooms.setState({ rooms: [], openRoomId: null, alerts: null })
    useSession.getState().signedOut()
  })

  test('the same n as the tab title and the Dock, once a burst settles; 0 clears it; a hidden room never counts', async () => {
    stub('navigator', badging())
    startSessionMarkers()
    useSessionMarkers.setState({ visible: true, onScreen: null })
    // at once on start: the worker's dot becomes the exact count (none: cleared)
    expect(calls).toEqual(['clear'])
    const c = chat({ unseen: true })
    useChats.setState({ chats: [c, chat({ waiting: true, runState: 'running' })] })
    useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 }), room({ kind: 'team', unreadCount: 5 }), room({ kind: 'dm', unreadCount: 4, hidden: true })] })
    expect(currentCount().n).toBe(3)
    // a burst: nothing yet, then one call with the settled n
    expect(calls).toEqual(['clear'])
    await settle()
    expect(calls).toEqual(['clear', 3])
    // the same n again: no call
    useRooms.setState({ rooms: [...useRooms.getState().rooms] })
    await settle()
    expect(calls).toEqual(['clear', 3])
    useSessionMarkers.getState().setOnScreen(c.id)
    await settle()
    expect(calls).toEqual(['clear', 3, 2])
    useChats.setState({ chats: [] })
    useRooms.setState({ rooms: [] })
    await settle()
    expect(calls).toEqual(['clear', 3, 2, 'clear'])
  })

  test('n 0 with a plain team-room message unread: the browser\'s dot (no number); a muted room or reading it clears it', async () => {
    stub('navigator', badging())
    const plain = room({ kind: 'team', unreadCount: 2 })
    useRooms.setState({ rooms: [plain] })
    startSessionMarkers()
    expect(calls).toEqual(['dot'])
    useRooms.setState({ rooms: [plain, room({ kind: 'team', unreadCount: 1, mentioned: true })] })
    await settle()
    expect(calls).toEqual(['dot', 1])
    useRooms.setState({ rooms: [plain] })
    await settle()
    expect(calls).toEqual(['dot', 1, 'dot'])
    useRooms.setState({ rooms: [{ ...plain, muted: true }] })
    await settle()
    expect(calls).toEqual(['dot', 1, 'dot', 'clear'])
    useRooms.setState({ rooms: [plain] })
    await settle()
    useRooms.setState({ rooms: [{ ...plain, unreadCount: 0 }] })
    await settle()
    expect(calls).toEqual(['dot', 1, 'dot', 'clear', 'dot', 'clear'])
  })

  test('signed out (this window stops): the count leaves the icon', async () => {
    stub('navigator', badging())
    useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 })] })
    startSessionMarkers()
    expect(calls).toEqual([1])
    stopSessionMarkers()
    expect(calls).toEqual([1, 'clear'])
  })

  test('a browser with setAppBadge only: 0 is setAppBadge(0)', async () => {
    stub('navigator', badging({ clear: false }))
    startSessionMarkers()
    expect(calls).toEqual([0])
  })

  test('a refusal or a throw changes nothing: no unhandled rejection, the next change still goes out', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => { unhandled.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      answer = () => Promise.reject(new DOMException('not allowed', 'NotAllowedError'))
      stub('navigator', badging())
      useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 })] })
      startSessionMarkers()
      answer = () => { throw new Error('half there') }
      useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 }), room({ kind: 'dm', unreadCount: 1 })] })
      await settle()
      answer = async () => {}
      useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 }), room({ kind: 'dm', unreadCount: 1 }), room({ kind: 'dm', unreadCount: 1 })] })
      await settle()
      expect(calls).toEqual([1, 2, 3])
      expect(unhandled).toEqual([])
    } finally { process.off('unhandledRejection', onUnhandled) }
  })

  test('inside the desktop app: its own Dock badge, never the web one', () => {
    const dock: number[] = []
    stub('navigator', badging())
    stub('mycelDesktop', { bridgeVersion: 1, notify: () => {}, setBadgeCount: (n: number) => dock.push(n) })
    useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 })] })
    startSessionMarkers()
    stopSessionMarkers()
    expect(dock).toEqual([1, 0])
    expect(calls).toEqual([])
  })

  test('inside the phone app: no web badge (the app has its own)', () => {
    const config: MobileConfig = { protocol: 1, appVersion: '0.4.0', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
    const win: Record<string, unknown> = { matchMedia: () => ({ matches: false }), mycelMobile: { ...config }, ReactNativeWebView: { postMessage: () => {} } }
    win.top = win; win.self = win
    stub('window', win)
    stub('navigator', badging())
    useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 })] })
    startSessionMarkers()
    stopSessionMarkers()
    expect(calls).toEqual([])
  })

  test('no Badging API (Firefox, a phone browser tab): nothing, and nothing throws', () => {
    stub('navigator', { userAgent: 'Mozilla/5.0 Firefox/130' })
    useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 })] })
    expect(() => { startSessionMarkers(); stopSessionMarkers() }).not.toThrow()
    expect(calls).toEqual([])
  })
})

describe('the settings line', () => {
  test('only on an installed web app that can badge, with its system\'s place', () => {
    const at = (o: Partial<Parameters<typeof badgeHintKey>[0]>) => badgeHintKey({ installed: true, badging: true, app: false, p: 'mac', ...o })
    expect(at({})).toBe('push.badgeHint.mac')
    expect(at({ p: 'windows' })).toBe('push.badgeHint.windows')
    expect(at({ p: 'ios' })).toBe('push.badgeHint.ios')
    expect(at({ p: 'other' })).toBe('push.badgeHint.other')
    expect(at({ installed: false })).toBeNull()
    expect(at({ badging: false })).toBeNull()
    expect(at({ app: true })).toBeNull()
    expect(translate('ko', 'push.badgeHint.mac')).toBe("Dock 아이콘에 숫자가 안 보이면 시스템 설정 › 알림 › Trina AX에서 '앱 아이콘에 배지 표시'를 켜 주세요.")
    expect(translate('ko', 'push.badgeHint.windows')).toContain('작업 표시줄 앱에 배지 표시')
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) for (const p of ['mac', 'windows', 'ios', 'other'] as const) {
      expect(translate(l, `push.badgeHint.${p}`)).not.toMatch(/[{}]|push\.badgeHint/)
    }
  })
})
