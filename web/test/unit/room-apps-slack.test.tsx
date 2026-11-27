// The Slack channel relay, the web screens (plan docs/AGENTS/plan/20261127-0329-slack-channel-relay.md, step 7): the one
// dialog shows only "Sign in with Slack" until my Slack account is linked; then the channels both I and the app are in
// (a taken one greyed), the sentence of who will see what, and Connect; once linked, its status and Disconnect (a
// member reads it only). A relayed message shows its Slack name and its words as plain text (never Markdown, never a
// link); my message Slack refused says so, with Retry for me only. The event lines say each state in words.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { SlackRelayStatus } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { SlackRelayPanel } from '../../src/components/rooms/apps/SlackRelay'
import { SlackRelayedBody, SlackSender, SlackSentLine, slackText } from '../../src/components/rooms/SlackMessage'
import { eventText } from '../../src/lib/rooms'
import { useSession } from '../../src/store/session'
import { useSlackRelay } from '../../src/store/slackRelay'
import { installDom, mount, removeDom } from './dom-host'

const ROOM = '01900000-0000-7000-8000-0000000000f1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const base: SlackRelayStatus = { link: null, meLinked: false, signIn: true, botName: 'trina', needsReAdd: false }
const LINK = { appId: 'app-slack', channelId: 'C0ACME01', channelName: 'client-acme', private: false, extShared: false, state: 'active' as const, createdBy: { id: 'mia', name: 'Mia' }, createdAt: new Date().toISOString(), customName: true }
let status: SlackRelayStatus = base
const calls: string[] = []
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
    calls.push(`${method} ${path}${init?.body ? ` ${String(init.body)}` : ''}`)
    if (path === `/api/rooms/${ROOM}/slack` && method === 'GET') return json(200, status)
    if (path === `/api/rooms/${ROOM}/slack/channels`) {
      return json(200, { items: [
        { id: 'C0ACME01', name: 'client-acme', private: false, extShared: false, taken: false },
        { id: 'G0ACME03', name: 'leadership', private: true, extShared: false, taken: false },
        { id: 'C0ACME04', name: 'general', private: false, extShared: false, taken: true },
      ] })
    }
    if (path === `/api/rooms/${ROOM}/slack` && method === 'POST') {
      status = { ...status, link: LINK }
      return json(201, status)
    }
    return json(404, { error: { code: 'not_found', message: path } })
  }) as unknown as typeof fetch
})
afterEach(() => { useSlackRelay.setState({ status: {}, dialog: null }); status = base; role = 'owner'; calls.length = 0 })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})

const open = () => mount(<MemoryRouter><SlackRelayPanel roomId={ROOM} /></MemoryRouter>)

test('not linked to Slack: only Sign in with Slack; without sign-in, how to link by mentioning the app', async () => {
  signIn()
  const a = await open()
  await a.until(() => a.find('slack-relay-sign-in'), 'the sign-in', 3000)
  expect(a.get('slack-relay').getAttribute('data-state')).toBe('sign-in')
  expect(a.get('slack-relay-sign-in-button').textContent).toContain('Sign in with Slack')
  expect(a.find('slack-relay-channels')).toBeFalsy()
  expect(a.find('slack-relay-connect')).toBeFalsy()
  expect(calls.some((c) => c.includes('/slack/channels'))).toBe(false)
  await a.unmount()
  useSlackRelay.setState({ status: {} })
  status = { ...base, signIn: false }
  const b = await open()
  await b.until(() => b.find('slack-relay-mention'), 'the mention line', 3000)
  expect(b.get('slack-relay-mention').textContent).toContain('@trina')
  expect(b.find('slack-relay-sign-in-button')).toBeFalsy()
  await b.unmount()
})

test('blocked: why in one line; a team without Slack gives an admin the way to set it up', async () => {
  signIn()
  status = { ...base, blocked: 'guests' }
  const a = await open()
  await a.until(() => a.find('slack-relay-blocked'), 'the line', 3000)
  expect(a.get('slack-relay-blocked').textContent).toBe("Conversations with guests can't be linked yet.")
  await a.unmount()
  useSlackRelay.setState({ status: {} })
  status = { ...base, blocked: 'not_added' }
  const b = await open()
  await b.until(() => b.find('slack-relay-open-admin'), 'the admin link', 3000)
  expect(b.get('slack-relay-open-admin').getAttribute('href')).toBe('/admin/connectors/slack')
  await b.unmount()
})

test('linked to Slack: the channels (a taken one greyed, a private one locked), the sentence, Connect', async () => {
  signIn()
  status = { ...base, meLinked: true }
  const a = await open()
  await a.until(() => a.find('slack-relay-channels'), 'the channels', 3000)
  const rows = a.container.ownerDocument!.body.querySelectorAll('[data-testid="slack-relay-channel"]')
  expect(rows.length).toBe(3)
  expect(rows[2]!.getAttribute('data-taken')).toBe('')
  expect(rows[2]!.textContent).toContain('Connected to another conversation')
  expect(a.get('slack-relay-channel-C0ACME04').disabled).toBe(true)
  expect(a.get('slack-relay-invite').textContent).toBe('Channel not here? Invite the app in Slack: /invite @trina')
  expect(a.get('slack-relay-who').textContent).toBe("Everyone in this conversation will see this channel's messages from now on, and what you write here goes to Slack under your name.")
  // nothing picked yet: Connect waits
  expect(a.get('slack-relay-connect').disabled).toBe(true)
  // a browser checks the radio before the click's listeners run, past React's value tracker (this small DOM does not)
  const radio = a.get('slack-relay-channel-C0ACME01')
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(radio), 'checked')!.set!.call(radio, true)
  await a.click(radio)
  await a.until(() => !a.get('slack-relay-connect').disabled, 'Connect on', 3000)
  await a.click('slack-relay-connect')
  await a.until(() => a.find('slack-relay-linked'), 'the status', 3000)
  expect(calls).toContain(`POST /api/rooms/${ROOM}/slack {"channelId":"C0ACME01"}`)
  expect(a.get('slack-relay-channel-name').textContent).toBe('client-acme')
  await a.unmount()
})

test('connected: the channel, its state in words, who connected it, Disconnect; a member reads it only', async () => {
  signIn()
  status = { ...base, meLinked: true, link: { ...LINK, state: 'bot_removed' } }
  const a = await open()
  await a.until(() => a.find('slack-relay-linked'), 'the status', 3000)
  expect(a.get('slack-relay-state').textContent).toBe('The app was removed from the channel, so messages stopped. Invite it again in Slack: /invite @trina')
  expect(a.get('slack-relay-by').textContent).toContain('Connected by Mia')
  expect(a.find('slack-relay-disconnect')).toBeTruthy()
  expect(a.find('slack-relay-readd')).toBeFalsy()
  await a.unmount()
  useSlackRelay.setState({ status: {} })
  role = 'member'
  signIn()
  status = { ...base, blocked: 'not_manager', link: LINK }
  const m = await open()
  await m.until(() => m.find('slack-relay-linked'), 'the status', 3000)
  expect(m.get('slack-relay-state').textContent).toBe('Messages go both ways.')
  expect(m.find('slack-relay-disconnect')).toBeFalsy()
  await m.unmount()
})

test('a relayed message: the Slack name, External, and the words as plain text with line breaks (no Markdown, no link)', async () => {
  // the server's body: "<name>: <text>", Markdown marks escaped (rooms/apps/card.ts relayBodyOf)
  const m = { body: 'Ann Lee: \\*\\*Ship it\\*\\* today\nsee https\\:\\/\\/acme.example\\/x', slackAuthor: { name: 'Ann Lee', external: true as const, files: ['plan.pdf'], permalink: 'https://acme.slack.com/archives/C0ACME01/p1' } }
  expect(slackText(m)).toBe('**Ship it** today\nsee https://acme.example/x')
  const a = await mount(<><SlackSender author={m.slackAuthor} /><SlackRelayedBody m={m} /></>)
  expect(a.get('slack-sender-name').textContent).toBe('Ann Lee')
  expect(a.find('slack-external')).toBeTruthy()
  expect(a.find('slack-bot')).toBeFalsy()
  expect(a.get('slack-text').textContent).toBe('**Ship it** today\nsee https://acme.example/x')
  expect(a.get('slack-relayed').querySelector('strong')).toBeNull()
  expect(a.get('slack-text').querySelector('a')).toBeNull()
  expect(a.get('slack-file').textContent).toBe('plan.pdf')
  expect(a.get('slack-files-open').getAttribute('href')).toBe('https://acme.slack.com/archives/C0ACME01/p1')
  await a.unmount()
})

test('my message Slack refused: "Not sent to Slack" with Retry for me, the mark only for others; files not sent said', async () => {
  const failed = { id: 'm1', slackSent: 'failed' as const, files: [] }
  const mine = await mount(<SlackSentLine roomId={ROOM} m={failed} mine />)
  expect(mine.get('slack-not-sent').textContent).toContain('Not sent to Slack')
  await mine.click('slack-retry')
  await mine.until(() => calls.some((c) => c === `POST /api/rooms/${ROOM}/slack/messages/m1/retry`), 'the retry', 3000)
  await mine.unmount()
  const theirs = await mount(<SlackSentLine roomId={ROOM} m={failed} mine={false} />)
  expect(theirs.get('slack-not-sent').textContent).toContain('Not sent to Slack')
  expect(theirs.find('slack-retry')).toBeFalsy()
  await theirs.unmount()
  const files = await mount(<SlackSentLine roomId={ROOM} m={{ id: 'm2', slackSent: 'ok', files: [{} as never] }} mine />)
  expect(files.get('slack-not-sent').textContent).toContain('Files not sent to Slack')
  await files.unmount()
  const ok = await mount(<div data-testid="box"><SlackSentLine roomId={ROOM} m={{ id: 'm3', slackSent: 'ok', files: [] }} mine /></div>)
  expect(ok.find('slack-not-sent')).toBeFalsy()
  await ok.unmount()
})

test('the Slack event lines say each state in words', () => {
  const words: Record<string, string> = {
    'rooms.event.slackConnected': '{actor} connected #{channel} (Slack)',
    'rooms.event.slackBotRemoved': 'removed #{channel} /invite @{bot}',
    'rooms.event.slackBotRemovedNoBot': 'removed #{channel}, the app',
    'rooms.event.slackCapped': 'capped',
  }
  const t = (k: string, p: Record<string, string | number> = {}) => (words[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(p[n]))
  const w = { t: t as never, nameOf: (u: { name: string } | null) => u?.name ?? '?' }
  expect(eventText({ type: 'slack', what: 'connected', channel: 'client-acme' }, { id: 'mia', name: 'Mia' }, w)).toBe('Mia connected #client-acme (Slack)')
  expect(eventText({ type: 'slack', what: 'bot_removed', channel: 'client-acme' }, null, { ...w, bot: 'trina' })).toBe('removed #client-acme /invite @trina')
  expect(eventText({ type: 'slack', what: 'bot_removed', channel: 'client-acme' }, null, w)).toBe('removed #client-acme, the app')
  expect(eventText({ type: 'slack', what: 'capped', channel: 'client-acme' }, null, w)).toBe('capped')
})
