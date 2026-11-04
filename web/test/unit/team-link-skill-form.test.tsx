// Onboarding E + C: the whole way of a team link that names a skill. The new member joins on /join (E), lands on
// /skills?run=<path> (the address the server named, kept by joinNext) and the Skills page opens that skill's form (C)
// with its fields, the company profile filled in where a field asks for it (D); closing the form takes ?run= out of
// the address. The API is a stub here; tests/unit/a-team-links.test.ts checks the server's side of the same path.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { SkillInfo } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { TeamJoin } from '../../src/pages/Auth'
import Skills from '../../src/pages/Skills'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const PATH = 'skills/marketing/ad-copy/SKILL.md'
const skill: SkillInfo = {
  path: PATH, name: 'ad-copy', title: '광고 문구', description: '광고 문구 — 세 가지',
  inputs: [
    { name: 'product', label: '알릴 제품·서비스', required: true, prefill: 'company.products' },
    { name: 'tone', label: '말투', prefill: 'company.tone' },
  ],
}
const me = {
  user: { id: 'hana', username: 'hana', name: '김하나', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
}
const profile = {
  website: 'https://www.acme.example/', oneLine: 'Acme makes planners', products: '종이 플래너\n데스크 매트', audience: '', tone: ['친근하게', '짧게'],
  avoid: '', sources: [], updatedAt: '2026-11-04T00:00:00.000Z',
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const routes: Record<string, () => Response> = {
  'POST /api/team-link/info': () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: 'ad-copy', skillTitle: '광고 문구' }),
  'POST /api/team-link/join': () => json(201, { me, next: `/skills?run=${encodeURIComponent(PATH)}` }),
  'GET /api/skills': () => json(200, { items: [skill] }),
  'GET /api/onboarding/profile': () => json(200, { profile }),
}

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const g = globalThis as Record<string, unknown>
const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
const session = { status: useSession.getState().status, signedIn: useSession.getState().signedIn }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  // anything the Skills page asks for beside these (overview, suggestions, issues) fails: the form does not need it
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    return routes[key]?.() ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
  Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}`, origin: 'https://acme.example', href: `https://acme.example/join#t=${TOKEN}` } })
  Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
  // the store's own sign-in (theme, team icon, realtime) is not what this tests: it only becomes signed in
  useSession.setState({ signedIn: (m) => useSession.setState({ status: { kind: 'signed-in', me: m } } as never) })
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
  useSession.setState(session as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }

test('join with a link that names a skill: the Skills page opens that skill\'s form, prefilled; closing it drops ?run=', async () => {
  let m: Mounted | null = null
  try {
    m = await mount(
      <MemoryRouter initialEntries={['/join']}>
        <Routes>
          <Route path="/join" element={<TeamJoin />} />
          <Route path="/skills" element={<><Skills /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    )
    await m.until(() => m!.find('join-form'), 'the join form')
    // the join page names the skill as people read it (its title), never its folder name
    expect(m.html()).toContain('광고 문구')
    expect(m.html()).not.toContain('ad-copy')
    await m.type('invite-name', '김하나')
    await m.type('invite-username', 'hana')
    await m.type('invite-password', 'tulip meadow 2026')
    await m.click('invite-submit')

    const form = await m.until(() => m!.find('skill-form'), 'the skill form on the Skills page', 3000)
    expect(m.get('where').textContent).toBe(`/skills?run=${encodeURIComponent(PATH)}`)
    expect(form.getAttribute('data-path')).toBe(PATH)
    // the dialog names it by its title once the person's list has it, and the description drops the repeated lead
    await m.until(() => m!.html().includes(translate('ko', 'skillForm.title', { name: '광고 문구' })), 'the title in the dialog', 3000)
    expect(m.html()).not.toContain(translate('ko', 'skillForm.title', { name: 'ad-copy' }))
    expect(form.textContent).toContain('세 가지')
    expect(form.textContent).not.toContain('광고 문구 — 세 가지')
    // its own fields, the profile in the ones that ask for it, and Run once the list says /ad-copy runs this skill
    await m.until(() => (m!.get('skill-input-product') as unknown as { value: string }).value !== '', 'the prefill', 3000)
    expect((m.get('skill-input-product') as unknown as { value: string }).value).toBe('종이 플래너, 데스크 매트')
    expect((m.get('skill-input-tone') as unknown as { value: string }).value).toBe('친근하게, 짧게')
    await m.until(() => !m!.get('skill-form-run').hasAttribute('disabled'), 'Run on', 3000)

    // closing the form takes ?run= out of the address
    const dialog = (globalThis.document as unknown as { body: { querySelector: (s: string) => Mounted['container'] | null } }).body.querySelector('[role="dialog"]')
    const close = dialog?.querySelector(`button[aria-label="${translate('ko', 'common.close')}"]`)
    expect(close).toBeTruthy()
    await m.click(close!)
    await m.until(() => !m!.find('skill-form'), 'the form closed', 3000)
    expect(m.get('where').textContent).toBe('/skills')
  } finally { await m?.unmount() }
})
