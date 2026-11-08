// The empty Team skills page's one admin button (docs/DECISIONS.md "DS3"): "추천 스킬 4개 넣기" installs the general pack
// and then the work pack (the four skills with a known origin), says what went in, and asks for the list again; one
// pack refused still lets the other in. Nothing else on the page offers a pack.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { AvailableSkillsList } from '../../src/components/AvailableSkills'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { skillsChanged } from '../../src/store/live'
import { installDom, mount, removeDom } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const pack = (id: 'general' | 'work', status: 'created' | 'present' | 'blocked') => ({
  pack: id, locale: 'ko',
  skills: (id === 'general' ? ['card-news', 'promo-video', 'intro-deck'] : ['humanizer']).map((name) => ({ name, path: `skills/${id}/${name}/SKILL.md`, status })),
})
let calls: string[] = []
let routes: Record<string, () => Response> = {}
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'olga', role: 'owner' }, team: { name: 'Acme', defaultLocale: 'ko' } } } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    calls.push(key)
    return routes[key]?.() ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { calls = []; routes = {}; useUi.setState({ toasts: [] }) })
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
  removeDom()
})

describe('the empty page\'s install button', () => {
  test('installs the general pack, then the work pack: four skills, one toast, the list asked again', async () => {
    routes = {
      'POST /api/onboarding/packs/general/install': () => json(200, pack('general', 'created')),
      'POST /api/onboarding/packs/work/install': () => json(200, pack('work', 'created')),
    }
    let reloads = 0
    const off = skillsChanged.on(() => { reloads++ })
    const m = await mount(<AvailableSkillsList items={[]} />)
    try {
      expect(m.get('skill-pack-install').textContent).toContain(translate('ko', 'skillPack.install', { n: 4 }))
      await m.click('skill-pack-install')
      await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
      expect(calls).toEqual(['POST /api/onboarding/packs/general/install', 'POST /api/onboarding/packs/work/install'])
      expect(useUi.getState().toasts.map((t) => [t.level, t.text])).toEqual([['success', translate('ko', 'skillPack.installed', { n: 4 })]])
      expect(reloads).toBe(1)
    } finally { off(); await m.unmount() }
  })

  test('already there: says so; one pack refused: the other still goes in, and the toast warns', async () => {
    routes = {
      'POST /api/onboarding/packs/general/install': () => json(200, pack('general', 'present')),
      'POST /api/onboarding/packs/work/install': () => json(200, pack('work', 'present')),
    }
    let m = await mount(<AvailableSkillsList items={[]} />)
    try {
      await m.click('skill-pack-install')
      await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
      expect(useUi.getState().toasts[0]!.text).toBe(translate('ko', 'skillPack.already'))
    } finally { await m.unmount() }
    useUi.setState({ toasts: [] })
    calls = []
    routes = {
      'POST /api/onboarding/packs/general/install': () => json(500, { error: { code: 'internal', message: '안 됐어요' } }),
      'POST /api/onboarding/packs/work/install': () => json(200, pack('work', 'created')),
    }
    m = await mount(<AvailableSkillsList items={[]} />)
    try {
      await m.click('skill-pack-install')
      await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
      expect(calls).toEqual(['POST /api/onboarding/packs/general/install', 'POST /api/onboarding/packs/work/install'])
      const t = useUi.getState().toasts[0]!
      expect(t.level).toBe('warn')
      expect(t.text).toContain(translate('ko', 'skillPack.installed', { n: 1 }))
    } finally { await m.unmount() }
  })
})
