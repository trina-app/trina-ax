// [받기 ▾] on an intro deck (components/ArtifactPanel.tsx DeckGetButton; docs/DECISIONS.md "D2"): one button whose menu
// lists only the files this server can make (GET /api/intro-decks/:id → pptx, pdf), never a line that cannot work: the
// PDF line hidden where it says pdf: false, no button at all when the info cannot be read. A line starts the download of
// that file under the deck's title. The menu is a keyboard menu (Esc closes it and gives the focus back; a click
// outside closes it). In the panel the deck, like the promo video, is the server's page: no code tab, no copy, no page
// download, no type label, and, unlike the video, no "save to the team folder" (the deck must never become a source).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, uuidv7, type Artifact, type IntroDeckInfo, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import ArtifactPanel, { DeckGetButton } from '../../src/components/ArtifactPanel'
import { TYPE_LABEL } from '../../src/components/artifactLabels'
import { useSession } from '../../src/store/session'
import { FakeElement, FakeEvent, installDom, mount as mountUi, removeDom, type FakeDocument, type Mounted } from './dom-host'

const ID = '01900000-0000-7000-8000-0000000000d1'
const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const info = (o: Partial<IntroDeckInfo> = {}): IntroDeckInfo => ({
  artifactId: ID, chatId: '01900000-0000-7000-8000-0000000000c1', title: 'Acme 회사 소개서', theme: 'paper', slides: 8, pptx: true, pdf: true, ...o,
})
const say = (k: MessageKey) => translate(useLocaleStore.getState().locale, k)

let calls: string[] = []
let answer: () => Response = () => json(info())
/** the downloads startDownload started (lib/api.ts: a link with download=name, clicked) */
let downloads: { path: string; name: string }[] = []
let doc: FakeDocument
let artifacts = new Map<string, Artifact>()
/** everything mounted in a test, taken down after it even when it failed half-way (no leftovers for the next test) */
let mounted: Mounted[] = []
const mount = async (ui: Parameters<typeof mountUi>[0]) => {
  const m = await mountUi(ui)
  mounted.push(m)
  return m
}

const onLinkClick = (e: FakeEvent) => {
  const a = e.target as (FakeElement & { href?: string; download?: string }) | null
  if (a instanceof FakeElement && a.localName === 'a') downloads.push({ path: new URL(a.href ?? '', 'http://team.localhost').pathname, name: a.download ?? '' })
}

beforeAll(() => {
  doc = installDom().document
  // the fake DOM has no Element.remove(); startDownload removes its link after the click
  if (!('remove' in FakeElement.prototype)) Object.defineProperty(FakeElement.prototype, 'remove', { configurable: true, value(this: FakeElement) { this.parentNode?.removeChild(this) } })
  doc.addEventListener('click', onLinkClick, true)
})
afterAll(() => {
  doc.removeEventListener('click', onLinkClick, { capture: true })
  delete (FakeElement.prototype as { remove?: unknown }).remove
  removeDom()
})
beforeEach(() => {
  calls = []
  downloads = []
  answer = () => json(info())
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const call = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(call)
    if (call === `GET /api/intro-decks/${ID}`) return answer()
    // the panel: a chat's saved artifacts and one version's content
    const list = /^GET \/api\/chats\/([^/]+)\/artifacts$/.exec(call)
    if (list) {
      const items = [...artifacts.values()].filter((a) => a.chatId === list[1]).map(({ content, ...a }) => ({ key: a.key, versions: [{ ...a, size: content.length }] }))
      return json({ items })
    }
    const one = /^GET \/api\/artifacts\/([^/]+)$/.exec(call)
    if (one && artifacts.has(one[1]!)) return json(artifacts.get(one[1]!))
    // the chat itself (is it confidential?): left unanswered, so the panel's body waits and only its header is tested
    if (/^GET \/api\/chats\/[^/]+$/.test(call)) return new Promise<Response>(() => {})
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount()
  globalThis.fetch = realFetch
})

const lines = () => doc.body.querySelectorAll('[role="menuitem"]').map((e) => e.textContent?.trim())

describe('the deck button', () => {
  test('a menu with both files where the server can make the PDF', async () => {
    const m = await mount(<DeckGetButton id={ID} />)
    const button = await m.until(() => m.find('deck-get'), 'the button')
    expect(button.textContent?.trim()).toBe(say('deck.get'))
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(m.find('deck-menu')).toBeNull()
    await m.click('deck-get')
    expect(m.get('deck-get').getAttribute('aria-expanded')).toBe('true')
    expect(m.get('deck-menu').getAttribute('role')).toBe('menu')
    expect(lines()).toEqual([say('deck.pptx'), say('deck.pdf')])
    // the first line has the focus, so the arrows and Enter work at once
    expect(doc.activeElement).toBe(m.get('deck-get-pptx'))
  })

  test('only PowerPoint where the server has no PDF (pdf: false)', async () => {
    answer = () => json(info({ pdf: false }))
    const m = await mount(<DeckGetButton id={ID} />)
    await m.until(() => m.find('deck-get'), 'the button')
    await m.click('deck-get')
    expect(lines()).toEqual([say('deck.pptx')])
    expect(m.find('deck-get-pdf')).toBeNull()
  })

  test('no button when the info cannot be read', async () => {
    answer = () => json({ error: { code: 'not_found', message: 'not here' } }, 404)
    const m = await mount(<DeckGetButton id={ID} />)
    await m.until(() => calls.includes(`GET /api/intro-decks/${ID}`), 'the info request')
    await m.settle(50)
    expect(m.find('deck-get')).toBeNull()
  })

  test('a line downloads that file under the deck\'s title and closes the menu', async () => {
    const m = await mount(<DeckGetButton id={ID} />)
    await m.until(() => m.find('deck-get'), 'the button')
    await m.click('deck-get')
    await m.click('deck-get-pptx')
    expect(downloads).toEqual([{ path: `/api/intro-decks/${ID}/pptx`, name: 'Acme 회사 소개서.pptx' }])
    expect(m.find('deck-menu')).toBeNull()
    expect(doc.activeElement).toBe(m.get('deck-get'))
    await m.click('deck-get')
    await m.click('deck-get-pdf')
    expect(downloads.at(-1)).toEqual({ path: `/api/intro-decks/${ID}/pdf`, name: 'Acme 회사 소개서.pdf' })
    // the server builds the file for the link: nothing else is asked first
    expect(calls).toEqual([`GET /api/intro-decks/${ID}`])
  })

  test('arrows move between the lines; Esc closes the menu and gives the focus back to the button', async () => {
    const m = await mount(<DeckGetButton id={ID} />)
    await m.until(() => m.find('deck-get'), 'the button')
    await m.click('deck-get')
    const key = (k: string) => act(async () => { (doc.activeElement as FakeElement).dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
    await key('ArrowDown')
    expect(doc.activeElement).toBe(m.get('deck-get-pdf'))
    await key('ArrowDown')
    expect(doc.activeElement).toBe(m.get('deck-get-pptx'))
    await key('End')
    expect(doc.activeElement).toBe(m.get('deck-get-pdf'))
    // Esc stays in the menu: the panel around it (Layout closes it on Esc) does not see it
    let reached = false
    const panel = (e: FakeEvent) => { if (e.key === 'Escape') reached = true }
    doc.addEventListener('keydown', panel)
    await key('Escape')
    doc.removeEventListener('keydown', panel)
    expect(reached).toBe(false)
    expect(m.find('deck-menu')).toBeNull()
    expect(m.get('deck-get').getAttribute('aria-expanded')).toBe('false')
    expect(doc.activeElement).toBe(m.get('deck-get'))
    expect(downloads).toEqual([])
  })

  test('a click outside closes the menu', async () => {
    const m = await mount(<DeckGetButton id={ID} />)
    await m.until(() => m.find('deck-get'), 'the button')
    await m.click('deck-get')
    expect(m.find('deck-menu')).not.toBeNull()
    await act(async () => { doc.body.dispatchEvent(new FakeEvent('mousedown', { bubbles: true })) })
    expect(m.find('deck-menu')).toBeNull()
    expect(downloads).toEqual([])
  })
})

describe('the artifact panel', () => {
  const me = { user: { id: 'alex', username: 'alex', name: 'Alex Kim', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'self' } } as unknown as Me
  let sessionBefore: unknown
  let locationBefore: PropertyDescriptor | undefined
  beforeAll(() => {
    sessionBefore = useSession.getState().status
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    // lib/artifacts.ts builds the frame's page with location.origin
    locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: 'http://team.localhost/' } })
  })
  afterAll(() => {
    useSession.setState({ status: sessionBefore } as never)
    if (locationBefore) Object.defineProperty(globalThis, 'location', locationBefore)
    else delete (globalThis as { location?: unknown }).location
    artifacts = new Map()
  })

  /** the panel's header for a saved HTML artifact with this key, once its content has loaded */
  async function header(key: string, id = uuidv7()) {
    const chatId = uuidv7()
    const a: Artifact = { id, chatId, messageId: null, key, version: 1, type: 'html', title: 'Acme', language: null, content: '<h1>Acme</h1>', createdAt: '2026-11-06T00:00:00.000Z' }
    artifacts.set(id, a)
    const m = await mount(<ArtifactPanel chatId={chatId} artifactKey={key} onClose={() => {}} />)
    await m.until(() => calls.includes(`GET /api/artifacts/${id}`), 'the content request')
    await m.settle(50)
    const label = (k: MessageKey) => !!doc.body.querySelector(`[aria-label="${say(k)}"]`)
    const seen = {
      copy: label('common.copy'),
      pageDownload: label('common.download'),
      saveToTeam: label('artifact.saveToTeam'),
      codeTab: !!doc.body.querySelector('[role="tablist"]'),
      typeLabel: m.get('artifact-panel').querySelector('header')!.textContent!.includes(say(TYPE_LABEL.html)),
      deckGet: !!m.find('deck-get'),
    }
    return seen
  }

  test('a page of the AI keeps its code tab, copy, page download and "save to the team folder" (the control)', async () => {
    expect(await header('report')).toEqual({ copy: true, pageDownload: true, saveToTeam: true, codeTab: true, typeLabel: true, deckGet: false })
  })

  test('the deck: only [받기 ▾]; no code tab, no copy, no page download, no type label, no "save to the team folder"', async () => {
    expect(await header(DECK_ARTIFACT_KEY, ID)).toEqual({ copy: false, pageDownload: false, saveToTeam: false, codeTab: false, typeLabel: false, deckGet: true })
  })

  test('the promo video keeps "save to the team folder" and gets no deck button', async () => {
    expect(await header(PROMO_ARTIFACT_KEY)).toEqual({ copy: false, pageDownload: false, saveToTeam: true, codeTab: false, typeLabel: false, deckGet: false })
  })
})
