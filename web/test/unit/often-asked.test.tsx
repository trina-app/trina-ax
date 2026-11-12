// Home's "what my group often asks" (components/OftenAsked.tsx; docs/DECISIONS.md "Home: what my group often asks"):
// the heading for a group, several groups or the team; 3 lines, Show more opens up to 10 and Show less closes them; a
// line is chosen (the box fills, nothing is sent); nothing at all for nothing; no counts, no frame. And
// "팀에 준비된 것" giving the place up after 5 chats.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OftenAsked, TeamPrepared } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { OftenAskedList } from '../../src/components/OftenAsked'
import { PREPARED_SKILL_CHATS, preparedView } from '../../src/components/onboarding/TeamPrepared'
import { installDom, mount, removeDom } from './dom-host'

const before = useLocaleStore.getState().locale
beforeAll(() => useLocaleStore.setState({ locale: 'ko' }))
afterAll(() => useLocaleStore.setState({ locale: before }))
const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const ITEMS = ['회의록을 요약해 줘', '주간 보고서 초안 써 줘', '고객 메일 답장 써 줘', '발표 자료 목차 만들어 줘', '영어로 번역해 줘']
const noop = () => {}

describe('the list', () => {
  test('the three headings, in plain words', async () => {
    installDom()
    try {
      const heading = async (r: OftenAsked) => {
        const m = await mount(<OftenAskedList result={r} onChoose={noop} />)
        try { return m.container.querySelector('h2')!.textContent } finally { await m.unmount() }
      }
      expect(await heading({ scope: 'team', items: ITEMS })).toBe(ko('home.oftenAsked.team'))
      expect(await heading({ scope: 'group', group: '영업', items: ITEMS })).toBe('영업에서 자주 묻는 질문')
      expect(await heading({ scope: 'groups', items: ITEMS })).toBe(ko('home.oftenAsked.groups'))
    } finally { removeDom() }
    expect(translate('en', 'home.oftenAsked.group', { group: 'Sales' })).toBe('People in Sales often ask')
    expect(translate('en', 'home.oftenAsked.team')).toBe('Your team often asks')
  })

  test('nothing at all for nothing; no frame and no counts', () => {
    expect(renderToStaticMarkup(<OftenAskedList result={{ scope: 'none', items: [] }} onChoose={noop} />)).toBe('')
    expect(renderToStaticMarkup(<OftenAskedList result={null} onChoose={noop} />)).toBe('')
    const html = renderToStaticMarkup(<OftenAskedList result={{ scope: 'team', items: ITEMS.slice(0, 3) }} onChoose={noop} />)
    expect(html).not.toContain('border')
    expect(html).not.toContain('often-asked-more')
    expect(html.match(/data-testid="often-asked-item"/g)).toHaveLength(3)
  })

  test('3 lines, Show more opens the rest and Show less closes them; a line is chosen', async () => {
    installDom()
    try {
      const chosen: string[] = []
      const m = await mount(<OftenAskedList result={{ scope: 'team', items: ITEMS }} onChoose={(q) => chosen.push(q)} />)
      try {
        const items = () => m.container.querySelectorAll('[data-testid="often-asked-item"]')
        expect(items()).toHaveLength(3)
        const more = m.get('often-asked-more')
        expect(more.textContent).toBe(ko('home.oftenAsked.more'))
        expect(more.getAttribute('aria-expanded')).toBe('false')
        await m.click(more)
        expect(items()).toHaveLength(5)
        expect(m.get('often-asked-more').textContent).toBe(ko('home.oftenAsked.less'))
        expect(m.get('often-asked-more').getAttribute('aria-expanded')).toBe('true')
        await m.click(items()[4]!)
        expect(chosen).toEqual(['영어로 번역해 줘'])
        await m.click('often-asked-more')
        expect(items()).toHaveLength(3)
      } finally { await m.unmount() }
    } finally { removeDom() }
  })
})

describe('"팀에 준비된 것" gives the place up', () => {
  const data = (o: Partial<TeamPrepared> = {}): TeamPrepared => ({ skills: [{ path: 'skills/general/card-news/SKILL.md', name: 'card-news', title: '카드뉴스', summary: '카드 5장', source: { kind: 'team' } }], teamFolder: null, landing: null, ranTeamSkill: false, hasProfile: false, ...o })
  const member = { firstTime: false, admin: false, readOnly: false }
  test('the skill rows stay until a team skill ran or the person has 5 chats', () => {
    expect(PREPARED_SKILL_CHATS).toBe(5)
    expect(preparedView(data(), { ...member, chats: 4 }).shown).toBe(true)
    expect(preparedView(data(), { ...member, chats: 5 }).shown).toBe(false)
    expect(preparedView(data({ ranTeamSkill: true }), { ...member, chats: 1 }).shown).toBe(false)
  })
})
