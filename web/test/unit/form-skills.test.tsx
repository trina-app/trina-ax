// The setup's forms become team skills on the 팀 파일 result screen (components/onboarding/FormSkills.tsx;
// docs/DECISIONS.md "Setup 팀 파일: forms become skills"): owners and admins get one question naming the forms (with the
// right Korean particle) and what a teammate would say; members nothing. [만들기] starts a draft per form from its file
// and shows S's card for each (the form's folder and "the newest named like it"); [팀에 공유] leaves one line, the
// card's 나중에 drops that form, the question's 나중에 drops it all; the state stays when the screen comes back.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { FormSkills, useFormSkills } from '../../src/components/onboarding/FormSkills'
import { forgetSkillDrafts } from '../../src/components/onboarding/SkillShareCard'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
const QUOTE = 'shared/양식/견적서_양식.xlsx'
const WEEKLY = 'shared/양식/주간보고_양식.docx'
const DRAFTS: Record<string, string> = { [QUOTE]: '01900000-0000-7000-8000-0000000000f1', [WEEKLY]: '01900000-0000-7000-8000-0000000000f2' }
const cardOf = (p: string) => {
  const like = p.includes('견적') ? '견적서 양식' : '주간보고 양식'
  return { title: p.includes('견적') ? '견적서 만들기' : '주간보고 만들기', description: '팀 양식을 채워 새 문서를 만들어요', recurring: false,
    inputs: [{ name: 'customer', label: '고객사', required: true }, { name: 'items', label: '품목' }], files: [{ path: 'shared/양식', latest: true, like }] }
}

let calls: { key: string; body: any }[] = []
const called = (key: string) => calls.filter((c) => c.key === key)
const routes: Record<string, (body: any) => Response> = {
  'POST /api/onboarding/skill-draft/from-form': (b: { path: string }) => json(201, { draftChatId: DRAFTS[b.path] }),
}
for (const [p, id] of Object.entries(DRAFTS)) {
  let reads = 0
  routes[`GET /api/onboarding/skill-draft/${id}`] = () => json(200, ++reads < 2 ? { status: 'running', draft: null, problem: null, saved: null } : { status: 'done', draft: cardOf(p), problem: null, saved: null })
  routes[`POST /api/onboarding/skill-draft/${id}/save`] = (b: { title: string }) => json(200, { path: 'skills/general/x/SKILL.md', name: 'x', title: b.title })
}

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = { status: useSession.getState().status, signedIn: useSession.getState().signedIn }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { calls = []; forgetSkillDrafts(); useFormSkills.setState({ key: null, step: 'ask', done: {} }) })
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState(sessionBefore as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})
const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)

describe('forms → team skills on the result screen', () => {
  test('the question names the forms with the right particle and what a teammate says; members see nothing', async () => {
    signIn('owner')
    let m = await mount(<FormSkills forms={[QUOTE, WEEKLY]} phone={false} />)
    try {
      expect(m.get('form-skills-question').textContent).toBe('견적서 양식, 주간보고 양식을 스킬로 만들어둘까요?')
      expect(m.get('form-skills-hint').textContent).toBe("팀원이 '견적서 만들어줘' 하면 이 양식대로 채워요.")
      expect(m.get('form-skills-make').textContent).toBe('만들기')
      expect(m.get('form-skills-later').textContent).toBe('나중에')
      expect(called('POST /api/onboarding/skill-draft/from-form')).toEqual([])
    } finally { await m.unmount() }
    // a vowel at the end: 를
    m = await mount(<FormSkills forms={['shared/양식/신청서 템플릿 서류.hwp']} phone={false} />)
    try { expect(m.get('form-skills-question').textContent).toBe('신청서 템플릿 서류를 스킬로 만들어둘까요?') } finally { await m.unmount() }
    signIn('member')
    m = await mount(<FormSkills forms={[QUOTE]} phone={false} />)
    try { expect(m.find('form-skills')).toBeNull() } finally { await m.unmount() }
    signIn('admin')
    m = await mount(<FormSkills forms={[]} phone={false} />)
    try { expect(m.find('form-skills')).toBeNull() } finally { await m.unmount() }
  })

  test('[만들기]: a draft per form from its file, S\'s card each; one shared, one put off; the screen back keeps it', async () => {
    signIn('admin')
    let m = await mount(<FormSkills forms={[QUOTE, WEEKLY]} phone />)
    try {
      await m.click('form-skills-make')
      await m.until(() => m.container.querySelectorAll('[data-testid="skill-share"][data-state="ready"]').length === 2, 'two cards', 8000)
      expect(called('POST /api/onboarding/skill-draft/from-form').map((c) => c.body)).toEqual([{ path: QUOTE }, { path: WEEKLY }])
      const cards = m.container.querySelectorAll('[data-testid="form-skill"]')
      expect(cards.map((c) => c.getAttribute('data-path'))).toEqual([QUOTE, WEEKLY])
      expect(cards[0]!.textContent).toContain('견적서 만들기')
      expect(cards[0]!.textContent).toContain('팀원에게 물어볼 것:고객사 · 품목')
      expect(cards[0]!.textContent).toContain('쓰는 자료:양식 폴더의 가장 최근 견적서 양식')
      // share the first: one line in its place
      await m.click(cards[0]!.querySelector('[data-testid="skill-share-share"]')!)
      await m.until(() => m.find('form-skills-shared'), 'the shared line')
      expect(m.get('form-skills-shared').textContent).toContain("'견적서 만들기' 스킬을 팀에 공유했어요")
      expect(called(`POST /api/onboarding/skill-draft/${DRAFTS[QUOTE]}/save`).map((c) => c.body)).toEqual([{ title: '견적서 만들기' }])
      // put off the second: gone
      const weekly = m.container.querySelectorAll('[data-testid="form-skill"]').find((c) => c.getAttribute('data-path') === WEEKLY)!
      await m.click(weekly.querySelector('[data-testid="skill-share-later"]')!)
      await m.until(() => !m.container.querySelector('[data-testid="form-skill"]'), 'the card gone')
    } finally { await m.unmount() }
    // the result screen again (another step and back): the same state, no new draft
    const before = calls.length
    m = await mount(<FormSkills forms={[QUOTE, WEEKLY]} phone />)
    try {
      expect(m.get('form-skills-shared').textContent).toContain('견적서 만들기')
      expect(m.find('form-skill')).toBeNull()
      expect(calls.length).toBe(before)
    } finally { await m.unmount() }
  })

  test('나중에 drops the question; nothing is drafted', async () => {
    signIn('owner')
    const m = await mount(<FormSkills forms={[QUOTE]} phone={false} />)
    try {
      await m.click('form-skills-later')
      expect(m.find('form-skills')).toBeNull()
      expect(called('POST /api/onboarding/skill-draft/from-form')).toEqual([])
    } finally { await m.unmount() }
  })

  test('the strings exist in every language', () => {
    for (const l of ['en', 'ko', 'ja', 'es', 'id'] as const) for (const k of ['welcome.forms.ask', 'welcome.forms.hint', 'welcome.forms.make', 'welcome.forms.shared'] as const) expect(translate(l, k, { names: 'X', kind: 'Y', title: 'Z' })).not.toContain('welcome.forms')
    expect(translate('en', 'welcome.forms.ask', { names: 'Quote template' })).toBe('Make team skills from Quote template?')
  })
})
