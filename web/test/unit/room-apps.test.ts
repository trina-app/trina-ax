// Apps posting in rooms, the web parts (docs/DECISIONS.md "Apps posting in rooms"): Trina's own words never say
// "webhook" in any language (the services' screen labels, roomApps.vendorLabel.*, are quoted as they are), who may
// manage a room's apps, the room menu's item, the status line, the side chat's chip, plain text of a card, the paused
// notice's time and the address cut in its middle.
import { expect, test } from 'bun:test'
import { DICTS } from '../../src/i18n'
import { appChip, appPlainText, appStatus, unescapeAppBody } from '../../src/lib/roomApps'
import { mayManageApps } from '../../src/store/roomApps'
import { roomMenuActions } from '../../src/components/rooms/RoomMenu'
import { startsAtTime } from '../../src/components/rooms/apps/PausedNotice'
import { middleCut } from '../../src/components/rooms/apps/AppsDialog'

const WEBHOOK = /web\s*-?\s*hook|웹\s*훅|ウェブフック|webフック|网络钩子|网钩|webhook/i

test('no "webhook" in Trina\'s own words of the apps screens, in any language; vendor labels are quoted as they are', () => {
  for (const [locale, dict] of Object.entries(DICTS)) {
    for (const [key, text] of Object.entries(dict)) {
      if (!key.startsWith('roomApps.') || key.startsWith('roomApps.vendorLabel.')) continue
      expect({ locale, key, hit: WEBHOOK.test(text) }).toEqual({ locale, key, hit: false })
    }
    expect(dict['roomApps.vendorLabel.sentryUrl' as never]).toBe('Webhook URL')
    expect(dict['roomApps.tag' as never]).toBeTruthy()
  }
})

test('who manages a room\'s apps: owners and admins in team rooms, everyone in 1:1s and group chats', () => {
  const as = (role: 'owner' | 'admin' | 'member') => ({ user: { role } }) as never
  expect(mayManageApps({ kind: 'team' }, as('owner'))).toBe(true)
  expect(mayManageApps({ kind: 'all' }, as('admin'))).toBe(true)
  expect(mayManageApps({ kind: 'team' }, as('member'))).toBe(false)
  expect(mayManageApps({ kind: 'group' }, as('member'))).toBe(true)
  expect(mayManageApps({ kind: 'dm' }, as('member'))).toBe(true)
  expect(mayManageApps(null, as('owner'))).toBe(false)
})

test('the room menu has the apps item after rename, only for those who manage them', () => {
  expect(roomMenuActions({ kind: 'team', canRename: true }, true)).toEqual(['pin', 'notify', 'rename', 'apps', 'copyLink', 'hide'])
  expect(roomMenuActions({ kind: 'team', canRename: false })).toEqual(['pin', 'notify', 'copyLink', 'hide'])
})

test('the status line: paused, a refusal newer than the last message, connected, nothing yet', () => {
  const base = { lastRefusal: null, firstOkAt: null, lastOkAt: null, pausedUntil: null }
  expect(appStatus(base).kind).toBe('none')
  expect(appStatus({ ...base, firstOkAt: '2026-11-05T10:00:00Z', lastOkAt: '2026-11-05T10:05:00Z' }).kind).toBe('ok')
  expect(appStatus({ ...base, firstOkAt: '2026-11-05T10:00:00Z', lastOkAt: '2026-11-05T10:05:00Z', lastRefusal: { at: '2026-11-05T10:06:00Z', reason: 'signature' } })).toEqual({ kind: 'refused', at: '2026-11-05T10:06:00Z', reason: 'signature' })
  expect(appStatus({ ...base, firstOkAt: '2026-11-05T10:00:00Z', lastOkAt: '2026-11-05T10:07:00Z', lastRefusal: { at: '2026-11-05T10:06:00Z', reason: 'signature' } }).kind).toBe('ok')
  expect(appStatus({ ...base, pausedUntil: '2099-01-01T00:00:00Z' }).kind).toBe('paused')
})

test('the side chat\'s chip follows the apps that posted: forms only, else what happened today; none without apps', () => {
  expect(appChip([{}])).toBeNull()
  expect(appChip([{ app: { id: 'a', name: 'Form', kind: 'google_forms' } }])).toBe('forms')
  expect(appChip([{ app: { id: 'a', name: 'Form', kind: 'google_forms' } }, { app: { id: 'b', name: 'Sentry', kind: 'sentry' } }])).toBe('today')
  // an example card is no app posting here yet
  expect(appChip([{ app: { id: 'b', name: 'Sentry', kind: 'sentry', example: true } }])).toBeNull()
})

test('an app message as plain text: the card\'s lines and its link; the body\'s escapes undone', () => {
  expect(appPlainText({ body: 'x', appCard: { kind: 'New issue', title: 'TypeError', details: ['in a.ts'], status: 'Status: Unresolved', link: { url: 'https://sentry.io/i/1', host: 'sentry.io' } } })).toBe('New issue · TypeError\nin a.ts\nStatus: Unresolved\nhttps://sentry.io/i/1')
  expect(unescapeAppBody('Sentry: see https:\\/\\/a.example \\*not bold\\* \\@all\n<https://sentry.io/i/1>')).toBe('Sentry: see https://a.example *not bold* @all\nhttps://sentry.io/i/1')
})

test('the pause ends "tomorrow" at the reader\'s midnight, else at a time; the address is cut in its middle', () => {
  expect(startsAtTime('2026-11-06T00:00:00.000Z', 'en', 'UTC')).toBeNull()
  expect(startsAtTime('2026-11-05T17:00:00.000Z', 'en', 'UTC')).toBe('5:00 PM')
  const a = `https://acme.trina.app/in/tax_in_${'A'.repeat(43)}`
  expect(middleCut(a)).toBe(`${a.slice(0, 34)}…${a.slice(-6)}`)
  expect(middleCut('https://x/in/short')).toBe('https://x/in/short')
})
