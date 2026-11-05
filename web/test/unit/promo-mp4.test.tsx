// [영상 파일로 받기] on a promo video (components/ArtifactPanel.tsx PromoMp4Button; docs/DECISIONS.md "V"): shown only
// where the server says it can make the MP4 (GET /api/promo-videos/:id → mp4.available), never a button that cannot
// work: hidden when it says no, and when the info cannot be read. A press on one never made asks the server to make it
// and says so while it is made.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { PromoVideoInfo } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { PromoMp4Button } from '../../src/components/ArtifactPanel'
import { installDom, mount, removeDom } from './dom-host'

const ID = '01900000-0000-7000-8000-0000000000a1'
const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const info = (mp4: Partial<PromoVideoInfo['mp4']> = {}): PromoVideoInfo => ({
  artifactId: ID, chatId: '01900000-0000-7000-8000-0000000000c1', title: 'Acme promo video', style: 'editorial', duration: 14.2,
  mp4: { available: true, state: 'none', seconds: null, bytes: null, ...mp4 },
})
const say = (k: 'promo.mp4.get' | 'promo.mp4.making') => translate(useLocaleStore.getState().locale, k)

let calls: string[] = []
let answer: () => Response = () => json(info())
let rendered: () => Response = () => json(info({ state: 'rendering' }), 202)

beforeAll(() => { installDom() })
afterAll(() => removeDom())
beforeEach(() => {
  calls = []
  answer = () => json(info())
  rendered = () => json(info({ state: 'rendering' }), 202)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const call = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(call)
    if (call === `GET /api/promo-videos/${ID}`) return answer()
    if (call === `POST /api/promo-videos/${ID}/mp4`) return rendered()
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

describe('the MP4 button', () => {
  test('hidden where the server cannot make the MP4 (available: false)', async () => {
    answer = () => json(info({ available: false }))
    const m = await mount(<PromoMp4Button id={ID} />)
    await m.until(() => calls.includes(`GET /api/promo-videos/${ID}`), 'the info request')
    await m.settle(50)
    expect(m.find('promo-mp4')).toBeNull()
    await m.unmount()
  })

  test('hidden when the info cannot be read', async () => {
    answer = () => json({ error: { code: 'not_found', message: 'not here' } }, 404)
    const m = await mount(<PromoMp4Button id={ID} />)
    await m.until(() => calls.includes(`GET /api/promo-videos/${ID}`), 'the info request')
    await m.settle(50)
    expect(m.find('promo-mp4')).toBeNull()
    await m.unmount()
  })

  test('shown where it can; a press asks the server to make it and says so meanwhile', async () => {
    const m = await mount(<PromoMp4Button id={ID} />)
    const button = await m.until(() => m.find('promo-mp4'), 'the button')
    expect(button.textContent?.trim()).toBe(say('promo.mp4.get'))
    await m.click('promo-mp4')
    await m.until(() => calls.includes(`POST /api/promo-videos/${ID}/mp4`), 'the render request')
    await m.until(() => m.find('promo-mp4')?.textContent?.includes(say('promo.mp4.making')), 'the making label')
    expect(m.get('promo-mp4').hasAttribute('disabled')).toBe(true)
    await m.unmount()
  })
})
