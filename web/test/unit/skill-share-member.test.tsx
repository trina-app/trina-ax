// A member and a team skill someone made from their own work (docs/DECISIONS.md "S"):
// - joining with a link to a skill lands on Home, also when an older server's answer names the skill's form and its
//   maker (docs/DECISIONS.md "A new member lands on Home"); the form has no maker line (the chat footer says who sees
//   new chats);
// - the answer's receipt names the maker: "김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개".
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { SkillInfo } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { TeamJoin } from '../../src/pages/Auth'
import Steps from '../../src/components/chat/Steps'
import { SkillFormDialog } from '../../src/components/skills/SkillForm'
import { forgetStarters } from '../../src/lib/starter'
import { forgetTeamAttach } from '../../src/lib/teamAttach'
import { forgetSkillList } from '../../src/lib/skillTitles'
import { teamLinkMessage } from '../../src/lib/team-link'
import { fileLabel } from '../../src/components/onboarding/SkillShareCard'
import { translate } from '../../src/i18n'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const QUOTE: SkillInfo = { path: 'skills/general/gyeonjeokseo-sseugi/SKILL.md', name: 'gyeonjeokseo-sseugi', title: '견적서 쓰기', description: '견적서 쓰기 — 팀 양식으로 견적서를 만들어요', inputs: [{ name: 'customer', label: '고객사', required: true }, { name: 'items', label: '품목' }] }
const BRIEF = { path: 'skills/general/bogoseo-yoyak/SKILL.md', name: 'bogoseo-yoyak', title: '보고서 요약' }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (id: string, name: string) => ({
  user: { id, username: id, name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})

let calls: { key: string; body: any }[] = []
const routes: Record<string, (body: any) => Response> = {
  'GET /api/me/ai-access': () => json(200, { usable: true, action: 'ask_owner', requested: false }),
  'GET /api/skills': () => json(200, { items: [QUOTE, { ...BRIEF, description: '보고서 요약' }] }),
  'GET /api/skills/popular': () => json(200, { items: [] }),
  'GET /api/onboarding/welcome': () => json(200, { progress: null }),
  'GET /api/onboarding/goal': () => json(200, { goal: null }),
  'GET /api/onboarding/profile': () => json(200, { profile: null }),
}
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status, signedIn: useSession.getState().signedIn }
beforeAll(() => {
  // another file can leave its skill list in memory; this file's receipt needs the titles from its own /api/skills
  forgetSkillList()
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  calls = []
  forgetStarters()
  forgetTeamAttach()
  sessionStorage.clear()
  localStorage.clear()
  useChats.getState().reset()
  useAiAccess.getState().reset()
  useWelcome.getState().reset()
})
afterAll(() => {
  globalThis.fetch = realFetch
  // the stores first: a component still on the page re-renders on their change and needs the window
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status, signedIn: before.signedIn })
  forgetSkillList()
  removeDom()
})
function Where() { const l = useLocation(); return <p data-testid="where">{`${l.pathname}${l.search}`}</p> }

describe('a member and a team skill someone made', () => {
  test('joining with a link to a skill: Home, even when an older server names its form and maker; nothing held', async () => {
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}`, origin: 'https://acme.example', href: `https://acme.example/join#t=${TOKEN}` } })
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
    routes['POST /api/team-link/info'] = () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: QUOTE.name, skillTitle: QUOTE.title })
    routes['POST /api/team-link/join'] = () => json(201, { me: meOf('minji', '민지'), next: `/skills?run=${encodeURIComponent(QUOTE.path)}`, skillBy: '김지훈' })
    useSession.setState({ signedIn: () => {} } as never)
    const m = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('join-form'), 'the join form')
      // the join page does not name the skill (the invite message does)
      expect(m.html()).not.toContain(QUOTE.title)
      await m.type('invite-name', '민지')
      await m.type('invite-username', 'minji')
      await m.type('invite-password', 'tulip meadow 2026')
      await m.click('invite-submit')
      await m.until(() => m.find('where'), 'the next page')
      expect(m.get('where').textContent).toBe('/')
    } finally {
      await m.unmount()
      delete routes['POST /api/team-link/info']
      delete routes['POST /api/team-link/join']
      for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    }
  })

  test('the form shows the skill\'s description and its fields, no maker line', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meOf('minji', '민지') } } as never)
    const m = await mount(<MemoryRouter><SkillFormDialog path={QUOTE.path} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-input-customer'), 'the form')
      expect(m.find('skill-form-by')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the receipt names who made the skill; without a maker as before', async () => {
    const steps = [{ id: 's1', kind: 'tool' as const, tool: 'read', label: 'read 견적서_양식.xlsx', status: 'ok' as const }]
    const m = await mount(<Steps steps={steps as never} streaming={false} receipt={{ skill: { path: QUOTE.path, name: QUOTE.name, by: '김지훈' }, teamFiles: 1 }} />)
    try {
      await m.until(() => m.find('steps-receipt')?.textContent === "김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개", 'the receipt')
    } finally { await m.unmount() }
    const plain = await mount(<Steps steps={steps as never} streaming={false} receipt={{ skill: { path: QUOTE.path, name: QUOTE.name }, teamFiles: 1 }} />)
    try {
      await plain.until(() => plain.find('steps-receipt')?.textContent === "팀 스킬 '견적서 쓰기' · 팀 파일 1개", 'the receipt')
    } finally { await plain.unmount() }
  })

  test('the lead\'s message for a skill just made is the usual invitation, in every language with the link', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate(l, k, p)
      const text = teamLinkMessage(t, { until: 'Dec 2, 2026', name: '올가', team: 'Acme 영업', url: 'https://acme.example/join#t=x', skill: '견적서 쓰기' })
      expect(text).toContain('견적서 쓰기')
      expect(text).toContain('Acme 영업')
      expect(text.endsWith('https://acme.example/join#t=x')).toBe(true)
    }
    const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
    // members land on Home: no "open the link to use it the same way" special case any more
    const m = teamLinkMessage(ko, { until: 'Dec 2, 2026', name: '올가', team: 'Acme 영업', url: 'u', skill: '견적서 쓰기' })
    expect(m).toContain('안녕하세요, 올가입니다.')
    expect(m).toContain("우리 팀용으로 '견적서 쓰기' 스킬을 준비해 뒀어요.")
    expect(m).not.toContain('같은 방식으로')
  })

  test('the card names a team file, or a folder\'s newest file of the kind the run used', () => {
    const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
    expect(fileLabel({ path: 'groups/Acme/회의록/견적서_양식.xlsx', latest: false }, t)).toBe('견적서_양식.xlsx')
    expect(fileLabel({ path: 'groups/Acme/회의록', latest: true }, t)).toBe('Acme 회의록 폴더의 가장 최근 회의록')
    expect(fileLabel({ path: 'groups/Acme/회의록', latest: true, like: '월간보고' }, t)).toBe('Acme 회의록 폴더의 가장 최근 월간보고')
    expect(fileLabel({ path: 'shared/보고서', latest: true }, t)).toBe('보고서 폴더의 가장 최근 파일')
    // English reads the team's folder as a place and the notes in plain words, not "the newest Meeting notes in the
    // Acme Marketing Meeting notes folder"
    const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
    expect(fileLabel({ path: 'groups/Acme Marketing/Meeting notes', latest: true }, en)).toBe('the newest meeting notes in Acme Marketing › Meeting notes')
    expect(fileLabel({ path: 'groups/Acme Marketing/Meeting notes', latest: true, like: 'Weekly sync' }, en)).toBe('the newest Weekly sync in Acme Marketing › Meeting notes')
    expect(fileLabel({ path: 'shared/Reports', latest: true }, en)).toBe('the newest file in Reports')
    // Spanish no longer reads "el Actas de reuniones más reciente"
    expect(fileLabel({ path: 'groups/Acme/Actas de reuniones', latest: true }, (k, p) => translate('es', k, p))).toBe('las actas de reunión más recientes de la carpeta Acme › Actas de reuniones')
    // the card news' brand images folder (docs/DECISIONS.md "N"): the whole folder, its team joined as each language
    // reads it; the company intro beside it stays a file
    expect(fileLabel({ path: 'groups/마케팅팀/브랜드/이미지', latest: false }, t)).toBe('마케팅팀 이미지 폴더의 사진')
    expect(fileLabel({ path: 'groups/Acme Marketing/Brand/Images', latest: false }, en)).toBe('the photos in Acme Marketing › Images')
    expect(fileLabel({ path: 'groups/Acme Marketing/Brand/Company intro.md', latest: false }, en)).toBe('Company intro.md')
  })
})
