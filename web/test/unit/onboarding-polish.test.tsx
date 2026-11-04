// Onboarding polish: skills named by their title (metadata `title`, "광고 문구") wherever a person reads them, the
// command still "/<name>"; the team link's one primary action ("메시지 복사") with the rest as plain text; the owner
// checklist counting a working team link as "팀원 초대하기" done.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { skillTitle, type PopularSkills, type SkillInfo, type TeamLinkResponse } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { teamLinkMessage } from '../../src/lib/team-link'
import { TeamLinkView } from '../../src/components/onboarding/TeamLinkPanel'
import { InviteStep } from '../../src/components/onboarding/InviteStep'
import { PopularSkillsList } from '../../src/components/PopularSkills'
import { matchSkills } from '../../src/components/chat/SkillMenu'
import { OwnerChecklist } from '../../src/pages/Home'
import { installDom, mount, removeDom } from './dom-host'

const URL_ = 'https://acme.example/join#t=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const AD: SkillInfo = { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', title: '광고 문구', description: '광고 문구 — 알릴 제품과 실을 곳을 받아 3안을 써요.' }
const PLAIN: SkillInfo = { path: 'skills/weekly/SKILL.md', name: 'weekly', description: 'Weekly notes.' }
const link = (over: Partial<NonNullable<TeamLinkResponse['link']>> = {}): TeamLinkResponse => ({
  link: { id: '01900000-0000-7000-8000-000000000001', url: URL_, groupIds: [], skill: { path: AD.path, name: 'ad-copy', title: '광고 문구' }, maxUses: 20, uses: 0, createdBy: { id: 'olga', name: 'Olga' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active', ...over },
  seats: { used: 1, limit: null },
})
const noop = () => {}
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => useLocaleStore.setState({ locale: 'ko' }))
afterAll(() => useLocaleStore.setState({ locale: localeBefore }))
const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
// a static render reads the language store's first state (English); the mounted ones read Korean
const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;')

describe('a skill by its title', () => {
  test('the title, else the name', () => {
    expect(skillTitle(AD)).toBe('광고 문구')
    expect(skillTitle(PLAIN)).toBe('weekly')
  })

  test('the ready-made message and the link\'s lines name the skill by its title; an older answer without one, by name', () => {
    const html = renderToStaticMarkup(<TeamLinkView data={link()} inviter="김팀장" groups={[]} skills={null} busy={false} onCreate={noop} onRevoke={noop} />)
    expect(teamLinkMessage(ko, { name: '김팀장', url: URL_, skill: '광고 문구' })).toBe(`김팀장님이 ${PRODUCT.displayName}에서 함께 일하자고 초대했어요. '광고 문구' 스킬을 같이 써 보자고 해요. 링크로 바로 들어올 수 있어요: ${URL_}`)
    expect(html).toContain(esc(teamLinkMessage(en, { name: '김팀장', url: URL_, skill: '광고 문구' })))
    expect(html).toContain('data-testid="team-link-skill-name">광고 문구<')
    expect(html).not.toContain('ad-copy')
    const older = renderToStaticMarkup(<TeamLinkView data={link({ skill: { path: AD.path, name: 'ad-copy' } })} inviter="김팀장" groups={[]} skills={null} busy={false} onCreate={noop} onRevoke={noop} />)
    expect(older).toContain(esc("'ad-copy' skill"))
  })

  test('the link form\'s skill picker lists titles', () => {
    const html = renderToStaticMarkup(<TeamLinkView data={{ link: null, seats: { used: 1, limit: null } }} inviter="김팀장" groups={[]} skills={[AD, PLAIN]} busy={false} onCreate={noop} onRevoke={noop} />)
    expect(html).toContain(`<option value="${AD.path}">광고 문구</option>`)
    expect(html).toContain(`<option value="${PLAIN.path}">weekly</option>`)
  })

  test('Home\'s frequent skills: the title and the description without the repeated lead; choosing still writes "/ad-copy "', async () => {
    const result: PopularSkills = { items: [{ ...AD, uses: 3, users: 2 }], days: 30 }
    const html = renderToStaticMarkup(<MemoryRouter><PopularSkillsList result={result} onChoose={noop} /></MemoryRouter>)
    expect(html).toContain('>광고 문구</button>')
    expect(html).toContain('>알릴 제품과 실을 곳을 받아 3안을 써요.</p>')
    expect(html).not.toContain('ad-copy')
    installDom()
    try {
      const chosen: string[] = []
      const m = await mount(<MemoryRouter><PopularSkillsList result={result} onChoose={(p) => chosen.push(p)} /></MemoryRouter>)
      try {
        const button = m.container.querySelector('button')!
        await m.click(button)
        expect(chosen).toEqual(['/ad-copy '])
      } finally { await m.unmount() }
    } finally { removeDom() }
  })

  test('the "/" menu finds a skill by its title too', () => {
    expect(matchSkills([AD, PLAIN], '/광고')?.map((s) => s.name)).toEqual(['ad-copy'])
    expect(matchSkills([AD, PLAIN], '/ad')?.map((s) => s.name)).toEqual(['ad-copy'])
    // once chosen, the command and its input: the menu is done
    expect(matchSkills([AD, PLAIN], '/ad-copy 신제품')).toBeNull()
  })
})

describe('the team link on a phone: one primary action, no boxes', () => {
  test('"메시지 복사" is the only primary; the link is plain text with quiet "링크만 복사" and "QR 코드"; the message a quote', () => {
    const html = renderToStaticMarkup(<TeamLinkView data={link()} inviter="김팀장" groups={[]} skills={null} busy={false} onCreate={noop} onRevoke={noop} />)
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((b) => b[0])
    expect(buttons.filter((b) => b.includes('bg-accent '))).toHaveLength(1)
    expect(buttons.find((b) => b.includes('bg-accent '))).toContain('data-testid="team-link-copy-message"')
    expect(html).toContain(` ${en('teamLink.copyMessage')}</button>`)
    expect(ko('teamLink.copyLink')).toBe('링크만 복사')
    expect(html).toContain(` ${en('teamLink.copyLink')}</button>`)
    expect(buttons.find((b) => b.includes('team-link-copy-link'))).toContain('text-muted')
    expect(buttons.find((b) => b.includes('team-link-qr'))).toContain('text-muted')
    // the link and the message have no frame of their own (a hairline beside the quote only)
    expect(/<p[^>]*data-testid="team-link-url"/.exec(html)?.[0]).not.toContain('border')
    expect(/<blockquote[^>]*data-testid="team-link-message"/.exec(html)?.[0]).toContain('border-l-2')
    expect(/<blockquote[^>]*data-testid="team-link-message"/.exec(html)?.[0]).not.toContain('rounded')
    // the facts as quiet lines: uses, expiry, the skill; the member note without a badge
    expect(html).toContain(`data-testid="team-link-uses">${en('teamLink.uses', { used: 0, max: 20 })}<`)
    expect(html).toContain(en('teamLink.memberNote'))
    expect(html).not.toContain('<dl')
    // the date says what it is in every language ("Works until Nov 18, …", "사용 기한 …까지")
    expect(html).toContain(`${en('teamLink.expiresLabel')} <span class="text-ink" data-testid="team-link-expires">`)
  })

  test('the groups line: the names; how many while the groups load; "no group" only on a team that has groups', () => {
    const G = { id: '01900000-0000-7000-8000-0000000000aa', name: '디자인팀' }
    const html = (l: TeamLinkResponse, groups: { id: string; name: string }[]) =>
      renderToStaticMarkup(<TeamLinkView data={l} inviter="김팀장" groups={groups as never} skills={null} busy={false} onCreate={noop} onRevoke={noop} />)
    expect(html(link({ groupIds: [G.id] }), [G])).toContain('data-testid="team-link-groups">디자인팀<')
    expect(html(link({ groupIds: [G.id] }), [])).toContain('data-testid="team-link-groups">1<')
    expect(html(link(), [G])).toContain(en('members.noGroups'))
    expect(html(link(), [])).not.toContain(en('members.noGroups'))
  })

  test('two skills that read the same are told apart in the picker', () => {
    const twin: SkillInfo = { path: 'skills/광고-문구.md', name: '광고 문구', description: '' }
    const html = renderToStaticMarkup(<TeamLinkView data={{ link: null, seats: { used: 1, limit: null } }} inviter="김팀장" groups={[]} skills={[AD, twin]} busy={false} onCreate={noop} onRevoke={noop} />)
    expect(html).toContain(`>광고 문구 · ${AD.path}</option>`)
    expect(html).toContain(`>광고 문구 · ${twin.path}</option>`)
  })

  test('the invite step\'s "다 했어요" is not a second primary', async () => {
    installDom()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      const body = u.includes('/api/admin/team-link') ? link() : u.includes('/api/admin/groups') ? { items: [] } : null
      return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      const m = await mount(<MemoryRouter><InviteStep onDone={noop} onSkip={noop} /></MemoryRouter>)
      try {
        await m.until(() => m.find('team-link-url'), 'the link')
        const primaries = [...m.html().matchAll(/<button[^>]*>/g)].map((b) => b[0]).filter((b) => b.includes('bg-accent '))
        expect(primaries).toHaveLength(1)
        expect(primaries[0]).toContain('team-link-copy-message')
        expect(m.get('invite-step-done').getAttribute('class')).not.toContain('bg-accent ')
      } finally { await m.unmount() }
    } finally {
      globalThis.fetch = realFetch
      removeDom()
    }
  })
})

describe('the owner checklist', () => {
  const realFetch = globalThis.fetch
  let teamLink: TeamLinkResponse | null = null
  beforeAll(() => {
    installDom()
    try { localStorage.removeItem('mycel.ownerChecklistHidden') } catch { /* no storage */ }
    // only the team link answers: no member joined and no invite waits (those fail and count as not done)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/api/admin/team-link') && teamLink) return new Response(JSON.stringify(teamLink), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
  })
  const invited = async (l: TeamLinkResponse | null) => {
    teamLink = l
    const m = await mount(<MemoryRouter><OwnerChecklist /></MemoryRouter>)
    try {
      const list = await m.until(() => m.find('owner-checklist'), 'the checklist')
      const row = [...list.querySelectorAll('li')].find((li) => li.textContent?.includes(ko('owner.check.members')))!
      return row.querySelector(`[aria-label="${ko('common.done')}"]`) !== null
    } finally { await m.unmount() }
  }

  test('"팀원 초대하기" is done once a team link works; an expired or used-up one, or none, is not', async () => {
    expect(await invited(link())).toBe(true)
    expect(await invited(link({ state: 'expired' }))).toBe(false)
    expect(await invited(link({ state: 'used_up' }))).toBe(false)
    expect(await invited({ link: null, seats: { used: 1, limit: null } })).toBe(false)
    expect(await invited(null)).toBe(false)
  })
})
