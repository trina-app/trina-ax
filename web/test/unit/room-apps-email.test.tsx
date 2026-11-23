// Email into rooms, the web screens (plan docs/AGENTS/plan/20261123-0421-room-email.md): the picker shows the Email row
// only when the server says email can be added (RoomAppList.mail), and why not otherwise; the Email guide says
// "Setting up the address…" and keeps Copy off until the mail service has the address; the settings show the last
// forwarding confirmation with its code, the email address row, and the Email words for "Get a new address".
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { useLocaleStore } from '../../src/i18n'
import { AppsDialog } from '../../src/components/rooms/apps/AppsDialog'
import { useRoomApps } from '../../src/store/roomApps'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const ROOM = '01900000-0000-7000-8000-0000000000e1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ADDRESS = 'k7q2m9x4p8w3t6v5n1c4hj2abd@in.trina.app'
const emailApp = (o: Record<string, unknown> = {}) => ({
  id: 'app-email', roomId: ROOM, kind: 'other', preset: 'email', name: 'Email', events: { mail: true, auto_replies: false }, quiet: false, signed: false,
  createdBy: { id: 'mia', name: 'Mia' }, createdAt: new Date(Date.now() - 30_000).toISOString(), firstOkAt: null, lastOkAt: null, lastRefusal: null,
  pausedUntil: null, canResume: false, today: 0, eventsSeen: [], mail: { state: 'ready' }, ...o,
})
let list: Record<string, unknown> = { items: [], available: true, max: 10 }
let role = 'owner'
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const signIn = () => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === `/api/rooms/${ROOM}/apps`) return json(200, list)
    if (method === 'GET' && path.endsWith('/address')) return json(200, { address: ADDRESS })
    return json(404, { error: { code: 'not_found', message: path } })
  }) as unknown as typeof fetch
})
afterEach(() => { useRoomApps.setState({ lists: {}, dialog: null }); role = 'owner' })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})

const open = (start: Parameters<typeof AppsDialog>[0]['start']) => mount(<MemoryRouter><AppsDialog roomId={ROOM} start={start} /></MemoryRouter>)

test('the picker: the Email row only when the server says email can be added; an older server shows none', async () => {
  signIn()
  list = { items: [], available: true, max: 10, mail: { available: true } }
  const a = await open({ view: 'pick' })
  await a.until(() => a.find('apps-picker'), 'the picker', 3000)
  expect(a.find('apps-pick-email')).toBeTruthy()
  expect(a.find('apps-email-unavailable')).toBeFalsy()
  await a.unmount()
  useRoomApps.setState({ lists: {}, dialog: null })
  list = { items: [], available: true, max: 10 }
  const b = await open({ view: 'pick' })
  await b.until(() => b.find('apps-picker'), 'the picker', 3000)
  expect(b.find('apps-pick-email')).toBeFalsy()
  expect(b.find('apps-email-unavailable')).toBeFalsy()
  await b.unmount()
})

test('the picker: email turned off says an admin must turn it on (with the way to Team settings for admins); not connected says so', async () => {
  signIn()
  list = { items: [], available: true, max: 10, mail: { available: false, reason: 'off' } }
  const a = await open({ view: 'pick' })
  await a.until(() => a.find('apps-email-unavailable'), 'the line', 3000)
  expect(a.find('apps-pick-email')).toBeFalsy()
  expect(a.get('apps-email-unavailable').textContent).toContain('Let rooms get email')
  expect(a.get('apps-email-open-settings').getAttribute('href')).toBe('/admin/settings#ts-room-email')
  await a.unmount()
  useRoomApps.setState({ lists: {}, dialog: null })
  role = 'member'
  signIn()
  const m = await open({ view: 'pick' })
  await m.until(() => m.find('apps-email-unavailable'), 'the line', 3000)
  expect(m.find('apps-email-open-settings')).toBeFalsy()
  await m.unmount()
  useRoomApps.setState({ lists: {}, dialog: null })
  list = { items: [], available: true, max: 10, mail: { available: false, reason: 'not_connected' } }
  const n = await open({ view: 'pick' })
  await n.until(() => n.find('apps-email-unavailable'), 'the line', 3000)
  expect(n.get('apps-email-unavailable').textContent).toContain('connected to the Trina service')
  await n.unmount()
})

test('the Email guide: setting up keeps Copy off; ready shows the address, the Gmail and Outlook steps and who sees the mails', async () => {
  signIn()
  list = { items: [emailApp({ mail: { state: 'setting_up' } })], available: true, max: 10, mail: { available: true } }
  const a = await open({ view: 'guide', service: 'email', appId: 'app-email' })
  await a.until(() => a.find('apps-guide'), 'the guide', 3000)
  expect(a.get('apps-guide').getAttribute('data-kind')).toBe('email')
  expect(a.get('apps-address').textContent).toBe('Setting up the address…')
  expect((a.get('apps-copy-address') as unknown as { disabled: boolean }).disabled).toBe(true)
  expect(a.find('apps-email-gmail')).toBeTruthy()
  expect(a.find('apps-email-outlook')).toBeTruthy()
  expect(a.get('apps-email-outlook-admin').textContent).toContain('IT admin')
  expect(a.get('apps-email-privacy').textContent).toContain('also people who join later')
  // no Webhook URL words, no signing secret
  expect(a.get('apps-guide').textContent).not.toContain('Webhook')
  expect(a.find('apps-safer')).toBeFalsy()
  await a.unmount()
  useRoomApps.setState({ lists: {}, dialog: null })
  list = { items: [emailApp()], available: true, max: 10, mail: { available: true } }
  const b = await open({ view: 'guide', service: 'email', appId: 'app-email' })
  await b.until(() => b.find('apps-address')?.textContent?.includes('@in.trina.app'), 'the address', 3000)
  expect((b.get('apps-copy-address') as unknown as { disabled: boolean }).disabled).toBe(false)
  await b.unmount()
})

test('the Email settings: the forwarding confirmation with its code, the email address row, unavailable said once', async () => {
  signIn()
  const at = new Date().toISOString()
  list = { items: [emailApp({ mail: { state: 'unavailable', confirmation: { provider: 'gmail', from: 'mina@example.com', code: '123456789', at } } })], available: false, max: 10, mail: { available: true } }
  const a = await open({ view: 'settings', appId: 'app-email' })
  await a.until(() => a.find('apps-settings'), 'the settings', 3000)
  expect(a.get('apps-mail-confirmation').getAttribute('data-provider')).toBe('gmail')
  expect(a.get('apps-mail-confirmation-code').textContent).toBe('123456789')
  expect(a.get('apps-mail-confirmation-from').textContent).toContain('(unverified)')
  expect(a.find('apps-warning-mail-unavailable')).toBeTruthy()
  // an Email app needs no internet address: that warning is not said
  expect(a.find('apps-warning-no-address')).toBeFalsy()
  expect(a.get('apps-address-row').textContent).toContain('Email address')
  expect((a.get('apps-settings-copy') as unknown as { disabled: boolean }).disabled).toBe(true)
  // its two switches
  expect(a.find('apps-switch-mail')).toBeTruthy()
  expect(a.find('apps-switch-auto_replies')).toBeTruthy()
  await a.unmount()
  useRoomApps.setState({ lists: {}, dialog: null })
  list = { items: [emailApp({ mail: { state: 'ready', confirmation: { provider: 'outlook', from: 'it@example.com', code: null, at } } })], available: true, max: 10, mail: { available: true } }
  const b = await open({ view: 'settings', appId: 'app-email' })
  await b.until(() => b.find('apps-settings'), 'the settings', 3000)
  expect(b.get('apps-mail-confirmation-nocode').textContent).toContain('Open the confirmation mail')
  expect((b.get('apps-settings-copy') as unknown as { disabled: boolean }).disabled).toBe(false)
  await b.unmount()
})
