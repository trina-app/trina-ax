// The skill form people land on (components/skills/SkillForm.tsx; docs/DECISIONS.md "W5"): a member who joins through
// the invite and the owner's "'{skill}' 먼저 써 보기" both open it (/skills?run=<path>).
// - a skill without fields starts its box with the skill's own example (metadata `example`, else the first request its
//   description quotes), which is what 실행 sends; what the person typed is never replaced; the "/" menu (onCompose)
//   keeps an empty box;
// - while no AI answers the person (GET /api/me/ai-access), the run button's place holds the one connect / ask line
//   the message box shows (내 AI 연결하기 for connect_own, 팀장에게 알리기 for ask_owner); the "/" menu keeps its button;
// - a skill without a title is named on the member's way in as the invite and the goal card name it (shared
//   skillLabel: "quote maker", never "quote-maker"): the form's title, the team skills row and its run button, the
//   chip of what the form sends, the answer's receipt; the "/" command keeps the folder name.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { skillExample, type SkillInfo } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { SkillForm, SkillFormDialog } from '../../src/components/skills/SkillForm'
import { AvailableSkillsList } from '../../src/components/AvailableSkills'
import { UserMessage, UserText } from '../../src/components/chat/Messages'
import Steps from '../../src/components/chat/Steps'
import { forgetSkillList } from '../../src/lib/skillTitles'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)

const quoted: SkillInfo = { path: 'skills/general/meeting-notes/SKILL.md', name: 'meeting-notes', title: '회의록 정리', description: '회의록 정리 — 회의록을 읽고 정리해요. "이번 주 회의록 정리해 줘"처럼 물을 때 써요.' }
const own: SkillInfo = { ...quoted, example: '지난주 회의록에서 결정만 뽑아 줘' }
const withFields: SkillInfo = { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: 'Ad copy "make three"', inputs: [{ name: 'product', label: 'Product' }] }

let skills: SkillInfo[] = [quoted]
let aiAccess: { usable: boolean; action: 'connect_team' | 'connect_own' | 'ask_owner'; requested: boolean } | null = null
let sent: unknown[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'u1', name: '민지', role: 'member', prefs: {} }, team: { name: 'Acme' } } } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(input).split('?')[0]
    if (method === 'GET' && path === '/api/skills') return json(200, { items: skills })
    if (method === 'GET' && path === '/api/me/ai-access') return aiAccess ? json(200, aiAccess) : json(404, { error: { code: 'not_found', message: 'x' } })
    if (method !== 'GET' && typeof init?.body === 'string') sent.push(JSON.parse(init.body))
    return json(404, { error: { code: 'not_found', message: 'not found' } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  skills = [quoted]
  aiAccess = null
  sent = []
  useAiAccess.getState().reset()
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})

const box = (m: Awaited<ReturnType<typeof mount>>) => m.get('skill-input-free') as unknown as { value: string }

describe('the example a skill form starts with', () => {
  test('skillExample: the metadata example first, else the first request the description quotes, else none', () => {
    expect(skillExample(own)).toBe('지난주 회의록에서 결정만 뽑아 줘')
    expect(skillExample(quoted)).toBe('이번 주 회의록 정리해 줘')
    expect(skillExample({ description: '할 일 정리 — 회의록을 읽고 할 일을 정리해요. “내 할 일 정리해 줘”처럼 물을 때 써요.' })).toBe('내 할 일 정리해 줘')
    expect(skillExample({ description: 'No quotes here' })).toBeNull()
    // an example that is not one line is not taken
    expect(skillExample({ description: 'x', example: 'a\nb' })).toBeNull()
  })

  test('skillExample: control or text-direction characters in the quoted request or the example: the box starts empty', () => {
    // the description is the skill author's text: a right-to-left override would turn what 실행 sends around on screen
    for (const bad of ['‮줘 해 리정 록의회', '회의록\u0007 정리해 줘', '회의록 ⁦정리⁩해 줘', '회의록‏ 정리해 줘', '회의록\u0085 정리해 줘', '회의록 정리해 줘']) {
      expect({ bad, got: skillExample({ description: `회의록 정리 — "${bad}"처럼 물을 때 써요.` }) }).toEqual({ bad, got: null })
      expect({ bad, got: skillExample({ description: '할 일 정리', example: bad }) }).toEqual({ bad, got: null })
    }
    // a bad example is left out like a long one (the quote stands in), and a normal quote still works
    expect(skillExample({ description: '회의록 정리 — "이번 주 회의록 정리해 줘"처럼 물을 때 써요.', example: '‮evil' })).toBe('이번 주 회의록 정리해 줘')
    expect(skillExample({ description: 'Meeting notes — use it for "summarise this week\'s notes".' })).toBe('summarise this week\'s notes')
  })

  test('a skill without fields: the box starts with its example, and 실행 sends it', async () => {
    // the chat store's send, as the form calls it (the message is what matters here)
    const realSend = useChats.getState().send
    useChats.setState({ send: (async (o: unknown) => { sent.push(o); return { chatId: 'c1' } }) as never })
    const m = await mount(<MemoryRouter><SkillForm path={quoted.path} skill={quoted} /></MemoryRouter>)
    try {
      await m.until(() => !m.get('skill-form-run').hasAttribute('disabled'), 'Run on')
      expect(box(m).value).toBe('이번 주 회의록 정리해 줘')
      await m.click('skill-form-run')
      await m.until(() => sent.length > 0, 'the run')
      expect((sent[0] as { content: string }).content).toBe('/meeting-notes 이번 주 회의록 정리해 줘')
    } finally { await m.unmount(); useChats.setState({ send: realSend }) }
  })

  test('what the person typed stays, even when the skill\'s own example arrives later', async () => {
    skills = [own]
    let answer!: () => void
    const held = new Promise<void>((r) => { answer = r })
    const before = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).split('?')[0] === '/api/skills') await held
      return before(input, init)
    }) as unknown as typeof fetch
    // shown at once from the skill passed in (its quoted request), the list with the example still on its way
    const m = await mount(<MemoryRouter><SkillForm path={quoted.path} skill={quoted} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-input-free'), 'the box')
      expect(box(m).value).toBe('이번 주 회의록 정리해 줘')
      await m.type('skill-input-free', '내 할 일만 정리해 줘')
      answer()
      await m.until(() => !m.get('skill-form-run').hasAttribute('disabled'), 'Run on')
      await m.settle(30)
      expect(box(m).value).toBe('내 할 일만 정리해 줘')
    } finally { await m.unmount(); globalThis.fetch = before }
  })

  test('a skill with fields keeps its fields; the "/" menu keeps an empty box', async () => {
    skills = [withFields, quoted]
    let m = await mount(<MemoryRouter><SkillForm path={withFields.path} skill={withFields} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-input-product'), 'the field')
      expect(m.find('skill-input-free')).toBeNull()
    } finally { await m.unmount() }
    m = await mount(<MemoryRouter><SkillForm path={quoted.path} skill={quoted} onCompose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-input-free'), 'the box')
      await m.settle(30)
      expect(box(m).value).toBe('')
    } finally { await m.unmount() }
  })
})

describe('no AI answers the person', () => {
  test('connect_own: the connect line in place of 실행', async () => {
    aiAccess = { usable: false, action: 'connect_own', requested: false }
    const m = await mount(<MemoryRouter><SkillForm path={quoted.path} skill={quoted} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-form-no-ai'), 'the line')
      expect(m.find('skill-form-run')).toBeNull()
      expect(m.get('skill-form-no-ai').querySelector('[data-testid="ai-access-banner"]')).not.toBeNull()
      expect(m.get('skill-form-no-ai').textContent).toContain(ko('aiAccess.connectOwn'))
    } finally { await m.unmount() }
  })

  test('ask_owner: the ask line in place of 실행; with AI the run button is back', async () => {
    aiAccess = { usable: false, action: 'ask_owner', requested: false }
    let m = await mount(<MemoryRouter><SkillForm path={quoted.path} skill={quoted} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-form-no-ai'), 'the line')
      expect(m.find('skill-form-run')).toBeNull()
      expect(m.get('skill-form-no-ai').textContent).toContain(ko('aiAccess.askOwner'))
    } finally { await m.unmount() }
    useAiAccess.getState().reset()
    aiAccess = { usable: true, action: 'ask_owner', requested: false }
    m = await mount(<MemoryRouter><SkillForm path={quoted.path} skill={quoted} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-form-run'), 'Run')
      expect(m.find('skill-form-no-ai')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the "/" menu fills the message box: its button stays', async () => {
    aiAccess = { usable: false, action: 'ask_owner', requested: false }
    await useAiAccess.getState().load(true)
    const m = await mount(<MemoryRouter><SkillForm path={quoted.path} skill={quoted} onCompose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-form-run'), 'the fill button')
      expect(m.find('skill-form-no-ai')).toBeNull()
    } finally { await m.unmount() }
  })
})

// the recheck of onboarding v5: the member's form read "quote-maker 실행" while the invite and the goal said 'quote maker'
describe('a skill without a title, on the member\'s way in', () => {
  const QUOTE: SkillInfo = { path: 'skills/quote-maker/SKILL.md', name: 'quote-maker', description: 'Quotes from the team template', inputs: [{ name: 'customer', label: '고객사' }] }
  const body = () => (globalThis.document as any).body

  test('the form\'s title, the team skills row and its run button, the chip of what it sends and the answer\'s receipt say "quote maker"', async () => {
    forgetSkillList()
    skills = [QUOTE]
    try {
      // the form the invite opens (/skills?run=): its title
      let m = await mount(<MemoryRouter><SkillFormDialog path={QUOTE.path} skill={QUOTE} onClose={() => {}} /></MemoryRouter>)
      try {
        await m.until(() => m.find('skill-input-customer'), 'the form')
        expect(body().querySelector('[role="dialog"]').querySelector('h2').textContent).toBe('quote maker 실행')
      } finally { await m.unmount() }
      // the team skills page behind it: the row and its run button
      m = await mount(<MemoryRouter><AvailableSkillsList items={[QUOTE]} /></MemoryRouter>)
      try {
        expect(m.get('skill-use').textContent).toContain('quote maker')
        expect(m.get('skill-run').getAttribute('aria-label')).toBe('quote maker 실행')
        expect(m.get('skill-more').getAttribute('aria-label')).toBe('quote maker 스킬 메뉴')
        expect(m.html()).not.toContain('quote-maker 실행')
      } finally { await m.unmount() }
      // what the form sends ("/quote-maker" and the answers) and a typed question: the chip
      m = await mount(<MemoryRouter><UserMessage m={{ ...msg({ role: 'user', content: '/quote-maker\n고객사: Acme' }), local: undefined } as never} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} /></MemoryRouter>)
      try {
        await m.until(() => m.find('user-form-run'), 'the run')
        expect(m.get('skill-chip').textContent).toBe('quote maker')
        // the command stays the folder name (the chip's tooltip)
        expect(m.get('skill-chip').getAttribute('title')).toBe('/quote-maker')
      } finally { await m.unmount() }
      m = await mount(<UserText content="/quote-maker 이번 주 견적 정리해 줘" clamp />)
      try {
        await m.until(() => m.find('skill-chip'), 'the chip')
        expect(m.get('skill-chip').textContent).toBe('quote maker')
      } finally { await m.unmount() }
      // the answer's receipt
      m = await mount(<Steps steps={[]} streaming={false} receipt={{ skill: { path: QUOTE.path, name: QUOTE.name, by: '지훈' }, teamFiles: 1 }} />)
      try {
        await m.until(() => m.find('steps-receipt')?.textContent === "지훈님의 팀 스킬 'quote maker' · 팀 파일 1개", 'the receipt')
      } finally { await m.unmount() }
    } finally { forgetSkillList() }
  })
})
