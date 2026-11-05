// The Slack one-time link page (/slack/link?t=…, docs/SLACK.md): both accounts are on the page before anything is
// linked, the token goes only in POST bodies, "Link" is the one way to link, and an account linked elsewhere gets no
// "Link" button at all.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { SlackLinkPreview } from '@mycel/shared/api'
import SlackLink from '../../src/pages/SlackLink'
import { useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const realFetch = globalThis.fetch
let calls: { method: string; path: string; url: string; raw: string }[] = []
let preview: SlackLinkPreview
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => removeDom())
beforeEach(() => {
  calls = []
  preview = { workspace: 'Acme', slack: { userId: 'U0ALICE', name: 'alice.slack', realName: 'Alice in Slack', handle: 'alice' }, me: { name: 'Bob Lee', username: 'bob' }, expiresAt: new Date(Date.now() + 600_000).toISOString(), linkedElsewhere: false }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, url: url.href, raw: typeof init?.body === 'string' ? init.body : '' })
    if (url.pathname === '/api/slack/link/preview') return json(preview)
    if (url.pathname === '/api/slack/link/confirm') return json({ available: true, workspace: 'Acme', link: { slackUserId: 'U0ALICE', slackName: 'alice.slack', linkedAt: new Date().toISOString() } })
    if (url.pathname === '/api/slack/link/cancel') return new Response(null, { status: 204 })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

const page = (search: string) => mount(<MemoryRouter initialEntries={[`/slack/link${search}`]}><Routes><Route path="/slack/link" element={<SlackLink />} /></Routes></MemoryRouter>)

describe('the Slack link page', () => {
  test('both accounts before anything is linked; the token only in POST bodies; Link links', async () => {
    const m = await page(`?t=${TOKEN}`)
    await m.until(() => m.find('slack-link-slack'), 'the accounts')
    expect(m.get('slack-link-slack').textContent).toContain('alice.slack')
    expect(m.get('slack-link-slack').textContent).toContain('U0ALICE')
    expect(m.get('slack-link-slack').textContent).toContain('Alice in Slack · @alice')
    expect(m.get('slack-link-me').textContent).toContain('Bob Lee')
    expect(m.get('slack-link-me').textContent).toContain('@bob')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/slack/link/preview'])
    await m.click('slack-link-confirm')
    await m.until(() => m.find('slack-link-done'), 'linked')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/slack/link/preview', 'POST /api/slack/link/confirm'])
    for (const c of calls) { expect(c.url).not.toContain(TOKEN); expect(JSON.parse(c.raw)).toEqual({ token: TOKEN }) }
    await m.unmount()
  })

  test('already linked to another Slack account: no Link button, a way to Settings; Cancel throws the link away', async () => {
    preview = { ...preview, linkedElsewhere: true }
    const m = await page(`?t=${TOKEN}`)
    await m.until(() => m.find('slack-link-elsewhere'), 'the note')
    expect(m.find('slack-link-confirm')).toBeNull()
    await m.click('slack-link-cancel')
    await m.until(() => m.find('slack-link-done'), 'cancelled')
    expect(calls.at(-1)!.path).toBe('/api/slack/link/cancel')
    await m.unmount()
  })

  test('a broken token is never sent', async () => {
    const m = await page('?t=short')
    await m.settle(50)
    expect(calls).toEqual([])
    expect(m.find('slack-link-confirm')).toBeNull()
    await m.unmount()
  })
})
