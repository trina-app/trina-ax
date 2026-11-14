// Apps posting in rooms, the web parts (docs/DECISIONS.md "Apps posting in rooms"): Slack's words (Webhook URL, Copy,
// Regenerate) in every language, the presets (picker groups, service of an app, the shared contracts, words), who may
// manage a room's apps, the room menu's item, the status line, the side chat's chip, plain text of a card, the paused
// notice's time and the address cut in its middle.
import { expect, test } from 'bun:test'
import { DICTS } from '../../src/i18n'
import { ROOM_APP_PRESET_NEEDS, ROOM_APP_PRESET_SIGNING, ROOM_APP_PRESET_SWITCHES, RoomAppPreset } from '@mycel/shared/api'
import { appChip, appPlainText, appStatus, HUBSPOT_ROWS, isPreset, kindOf, MAKE_BODY, MORE_SERVICES, needsOf, notSetUp, PICKER_GROUPS, serviceOf, signingOf, STRIPE_EVENTS, switchesOf, TOSS_EVENTS, unescapeAppBody } from '../../src/lib/roomApps'
import { mayManageApps } from '../../src/store/roomApps'
import { roomMenuActions } from '../../src/components/rooms/RoomMenu'
import { pausedNoticeText, startsAtTime } from '../../src/components/rooms/apps/PausedNotice'
import { translate } from '../../src/i18n'
import { middleCut } from '../../src/components/rooms/apps/AppsDialog'

test('the apps screens use Slack\'s words in every language: "Webhook URL" with Copy and Regenerate (owner decision 3, plan 20261114-1522)', () => {
  const words: Record<string, { copy: string; regenerate: string }> = {
    en: { copy: 'Copy', regenerate: 'Regenerate' },
    ko: { copy: '복사', regenerate: '다시 만들기' },
  }
  for (const [locale, dict] of Object.entries(DICTS)) {
    const d = dict as Record<string, string>
    // the address is named the way Slack and the services name it, untranslated
    expect({ locale, label: d['roomApps.addressLabel'], row: d['roomApps.address'] }).toEqual({ locale, label: 'Webhook URL', row: 'Webhook URL' })
    expect(d['roomApps.vendorLabel.sentryUrl']).toBe('Webhook URL')
    expect(d['roomApps.copyAddress']).toBeTruthy()
    expect(d['roomApps.newAddress']).toBeTruthy()
    expect(d['roomApps.newAddressConfirm']).toBe(d['roomApps.newAddress'])
    if (words[locale]) expect({ locale, copy: d['roomApps.copyAddress'], regenerate: d['roomApps.newAddress'] }).toEqual({ locale, ...words[locale] })
    // Other's one line names the three chat apps whose webhook URL it takes
    for (const name of ['Slack', 'Discord']) expect(d['roomApps.otherWhere']).toContain(name)
    expect(d['roomApps.otherWhere']).toMatch(/JANDI|잔디/)
    expect(d['roomApps.tag']).toBeTruthy()
  }
})

test('presets: the picker\'s groups, Other last, no email row, the service of an app, the shared contracts', () => {
  const picked = PICKER_GROUPS.flatMap((g) => g.items)
  expect(PICKER_GROUPS.map((g) => g.key)).toEqual(['forms', 'payments', 'work', 'developers'])
  expect(picked).toEqual(['google_forms', 'typeform', 'tally', 'jotform', 'stripe', 'shopify', 'notion', 'zendesk', 'jira', 'hubspot', 'github', 'sentry'])
  // "Show more services": the regional ones, folded, the same for everyone
  expect(MORE_SERVICES).toEqual(['toss_payments', 'channel_talk', 'portone'])
  // every preset this build knows is in a group or under "Show more services"; Other comes after them (the divider),
  // Email not before P2
  expect([...RoomAppPreset.options].sort()).toEqual([...picked, ...MORE_SERVICES].filter(isPreset).sort())
  expect(picked).not.toContain('other')
  expect(picked).not.toContain('email' as never)
  expect(serviceOf({ kind: 'other', preset: 'stripe' })).toBe('stripe')
  expect(serviceOf({ kind: 'other' })).toBe('other')
  // a preset a newer server knows and this build doesn't shows as a plain Other app
  expect(serviceOf({ kind: 'other', preset: 'email' })).toBe('other')
  expect(serviceOf({ kind: 'other', preset: 'toss_payments' })).toBe('toss_payments')
  expect(serviceOf({ kind: 'sentry', preset: 'stripe' })).toBe('sentry')
  expect(kindOf('zendesk')).toBe('other')
  expect(kindOf('github')).toBe('github')
  for (const p of RoomAppPreset.options) {
    expect(switchesOf(p).map((s) => [s.key, s.on])).toEqual(ROOM_APP_PRESET_SWITCHES[p].map((s) => [s.key, s.on]))
    expect(signingOf(p)).toBe(ROOM_APP_PRESET_SIGNING[p].signing)
    expect(needsOf(p)).toBe(ROOM_APP_PRESET_NEEDS[p] ?? null)
  }
  expect(signingOf('github')).toBe('trina_makes')
  expect(signingOf('sentry')).toBe('paste')
  expect(signingOf('other')).toBe('none')
  // the optional events of the guides: only those can say "Not set up in Shopify", and only when the server says
  expect(switchesOf('shopify').filter((s) => s.optional).map((s) => s.key)).toEqual(['paid', 'cancelled', 'refund', 'fulfilled'])
  expect(switchesOf('jira').filter((s) => s.optional).map((s) => s.key)).toEqual(['transitioned', 'commented'])
  expect(switchesOf('hubspot').filter((s) => s.optional).map((s) => s.key)).toEqual(['contact', 'ticket'])
  // HubSpot's rows name the object first and the record id; Jira, HubSpot sign nothing, the regional services paste
  for (const rows of Object.values(HUBSPOT_ROWS)) expect(rows.slice(0, 2).map((r) => r[0])).toEqual(['object', 'id'])
  expect(['jira', 'hubspot'].map((p) => signingOf(p as never))).toEqual(['none', 'none'])
  expect(['toss_payments', 'channel_talk', 'portone'].map((p) => signingOf(p as never))).toEqual(['paste', 'paste', 'paste'])
  expect(TOSS_EVENTS).toEqual(['PAYMENT_STATUS_CHANGED'])
  expect([...notSetUp('shopify', {})]).toEqual([])
  expect([...notSetUp('shopify', { eventsSeen: ['order', 'paid'] })]).toEqual(['cancelled', 'refund', 'fulfilled'])
  expect([...notSetUp('stripe', { eventsSeen: [] })]).toEqual([])
  // Stripe's chips cover each switch
  for (const s of switchesOf('stripe')) expect(STRIPE_EVENTS[s.key]?.length).toBeGreaterThan(0)
  // the forms posts Summarize today's responses
  expect(appChip([{ app: { id: 'a', name: 'Survey', kind: 'other', preset: 'typeform' } }, { app: { id: 'b', name: 'Form', kind: 'google_forms' } }])).toBe('forms')
  expect(appChip([{ app: { id: 'a', name: 'Stripe', kind: 'other', preset: 'stripe' } }])).toBe('today')
  // Make's example body is JSON with the fields Other reads
  expect(Object.keys(JSON.parse(MAKE_BODY))).toEqual(['title', 'text', 'link', 'thread'])
})

test('every service has its words in every language: name, the picker\'s line, the example card, its switches', () => {
  const services = [...PICKER_GROUPS.flatMap((g) => g.items), ...MORE_SERVICES, 'other'] as const
  for (const [locale, dict] of Object.entries(DICTS)) {
    const d = dict as Record<string, string>
    for (const s of services) {
      for (const k of [`roomApps.kind.${s}`, `roomApps.hint.${s}`, `roomApps.preview.${s}.title`, `roomApps.preview.${s}.detail`]) expect({ locale, k, ok: !!d[k] }).toEqual({ locale, k, ok: true })
      for (const w of switchesOf(s)) expect({ locale, s, w: w.key, ok: !!d[`roomApps.switch.${s}.${w.key}`] }).toEqual({ locale, s, w: w.key, ok: true })
      const n = needsOf(s)
      if (n) expect(d[`roomApps.needs.${n}`]).toBeTruthy()
      // a preset that signs: how to get its secret, the field's name (pasted ones) and the refused line
      if (isPreset(s) && signingOf(s) !== 'none') {
        for (const k of [`roomApps.saferPreset.${s}`, `roomApps.refusedSecret.${s}`, ...(signingOf(s) === 'paste' ? [`roomApps.secretName.${s}`] : [])]) expect({ locale, k, ok: !!d[k] }).toEqual({ locale, k, ok: true })
      }
    }
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
  expect(appStatus({ ...base, pausedUntil: '2099-01-01T00:00:00Z' })).toEqual({ kind: 'paused', until: '2099-01-01T00:00:00Z', by: 'app', cap: 500 })
  expect(appStatus({ ...base, pausedUntil: '2099-01-01T00:00:00Z', pausedBy: 'team', pausedCap: 5000, timeZone: 'Asia/Seoul' })).toEqual({ kind: 'paused', until: '2099-01-01T00:00:00Z', by: 'team', cap: 5000, timeZone: 'Asia/Seoul' })
})

test('after Regenerate the status waits for the new Webhook URL until a message arrives after it (QA TC-2086)', () => {
  const base = { lastRefusal: null, firstOkAt: '2026-11-05T10:00:00Z', lastOkAt: '2026-11-05T10:05:00Z', pausedUntil: null }
  expect(appStatus({ ...base, rotatedAt: '2026-11-05T11:00:00Z' })).toEqual({ kind: 'moved', at: '2026-11-05T11:00:00Z' })
  // never had a message: waits for the new one too
  expect(appStatus({ ...base, firstOkAt: null, lastOkAt: null, rotatedAt: '2026-11-05T11:00:00Z' }).kind).toBe('moved')
  // a refusal of the old URL does not count; one on the new URL does
  expect(appStatus({ ...base, rotatedAt: '2026-11-05T11:00:00Z', lastRefusal: { at: '2026-11-05T10:30:00Z', reason: 'signature' } }).kind).toBe('moved')
  expect(appStatus({ ...base, rotatedAt: '2026-11-05T11:00:00Z', lastRefusal: { at: '2026-11-05T11:01:00Z', reason: 'signature' } }).kind).toBe('refused')
  // the first message on the new URL
  expect(appStatus({ ...base, lastOkAt: '2026-11-05T11:02:00Z', rotatedAt: '2026-11-05T11:00:00Z' }).kind).toBe('ok')
  expect(appStatus({ ...base, rotatedAt: null }).kind).toBe('ok')
})

test("the paused notice: the app's own cap, the team's cap with its number and the end in the team's zone (QA TC-2067)", () => {
  const t = ((k: string, v?: Record<string, string | number>) => translate('en', k as never, v)) as never
  const p = { appId: 'a', name: 'A9', roomId: 'r', roomKind: 'team' as const, roomName: 'ops', kind: 'other' as const, day: '2026-11-15', skipped: 1234, canResume: false }
  expect(pausedNoticeText({ ...p, cap: 500, pausedUntil: null }, t, 'en')).toBe('A9 paused in #ops. It reached 500 messages today. 1,234 more were skipped and won\'t appear. It starts again tomorrow.')
  expect(pausedNoticeText({ ...p, cap: 5000, team: true, timeZone: 'Asia/Seoul', pausedUntil: '2026-11-15T15:00:00.000Z' }, t, 'en')).toMatch(/^A9 paused in #ops\. Your team's apps reached 5,000 messages today\. All apps are paused until Nov 16(,| at) 00:00\.$/)
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
