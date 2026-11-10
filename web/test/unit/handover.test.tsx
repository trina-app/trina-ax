// 팀장 넘기기 (docs/DECISIONS.md "W6"; src/components/handover/): the confirm's lines (the owner's own words for whom the
// link was, or the account's name and username; never "님님" or a particle glued after a label like "김팀장 대표님"),
// the connections ticked by default, who can still reset passwords; how a refused transfer is told apart; who gets
// "팀장 넘기기" in Admin › Members' "…"; the Home card's and the Inbox rows' words; the flag only for the owner and only
// where the server offers it; the realtime notices.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ApiError, type HandoverConnection, type HandoverState, type Me, type ServerEvent, type User } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { connectionLine, HandoverView, transferRefusal } from '../../src/components/handover/HandoverDialog'
import { HandoverCard, joinedText, useLeadCard } from '../../src/components/handover/HandoverCard'
import { handoverNoticeLines, handoverNoticeNode, handoverNoticeText, type HandoverNote } from '../../src/components/handover/HandoverNotice'
import { isolate } from '../../src/components/handover/isolate'
import { LeadInvite, leadMessage } from '../../src/components/handover/LeadInvite'
import { handoverTarget } from '../../src/pages/admin/Members'
import { useSession } from '../../src/store/session'
import { markTransferredHere, transferredHere, useHandover } from '../../src/store/handover'
import { dispatch } from '../../src/store/live'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const T = ko as unknown as ReturnType<typeof import('../../src/i18n').useT>
const TEN = en as unknown as ReturnType<typeof import('../../src/i18n').useT>
const me = (role: 'owner' | 'admin' | 'member' = 'owner'): Me => ({
  user: { id: 'olga', username: 'olga', name: '지수', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
} as unknown as Me)
const CONNS: HandoverConnection[] = [
  { kind: 'team_ai', id: 'c1', label: '회사 Claude', provider: 'claude', account: null },
  { kind: 'team_ai', id: 'c2', label: 'GPT 팀', provider: 'chatgpt', account: null },
  { kind: 'drive_share', id: 's1', label: 'Acme 드라이브', provider: 'google', account: null },
]
/** rendered into the fake document (the stores' own state, not their first one as a server render would) */
const html = async (ui: ReactNode) => {
  const m = await mount(ui)
  try { return m.html() } finally { await m.unmount() }
}
const view = (o: Partial<Parameters<typeof HandoverView>[0]> = {}) => html(
  <HandoverView target={{ id: 'u1', name: '박민준', username: 'minjun.park' }} connections={CONNS} recovery={null} kept={new Set()} onToggle={() => {}} {...o} />,
)
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
const JOINED = '2026-11-08T06:12:00.000Z'
const state = (o: Partial<HandoverState> = {}): HandoverState => ({ flag: true, recovery: 'server', openLead: null, card: null, connections: [], ...o })

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => {
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
})
afterEach(() => {
  useHandover.getState().reset()
})

describe('the confirm', () => {
  test('a label that ends with an honorific gets no second 님 and the right particle; a Latin one keeps 님', async () => {
    expect(ko('handover.title', { name: '김팀장 대표님' })).toBe('김팀장 대표님을 팀장으로 정할까요?')
    expect(ko('handover.title', { name: 'Acme' })).toBe('Acme님을 팀장으로 정할까요?')
    expect(ko('handover.title', { name: '박민준' })).toBe('박민준님을 팀장으로 정할까요?')
    expect(ko('handover.moves', { name: '김팀장 대표님' })).toBe('넘기면 팀 이름·관리자 지정·업데이트와 백업은 김팀장 대표님이 맡고, 나는 관리자가 돼요.')
    expect(ko('handover.done', { name: '김팀장 대표님' })).toBe('김팀장 대표님이 팀장이 되었어요 · 나는 관리자예요')
  })

  test('with the lead link: "받는 사람: {leadFor}" with nothing after the label; without: the name and username', async () => {
    const lead = text(await view({ leadFor: '김팀장 대표님' }))
    expect(lead).toContain('받는 사람: 김팀장 대표님 · 이 사람이 맞는지 직접 확인했나요? 팀장이 되면 나를 내보낼 수도 있어요.')
    expect(lead).toContain('넘기면 팀 이름·관리자 지정·업데이트와 백업은 박민준님이 맡고, 나는 관리자가 돼요.')
    expect(text(await view({ leadFor: 'Acme' }))).toContain('받는 사람: Acme · ')
    expect(text(await view())).toContain('박민준(아이디 minjun.park) · 팀장이 되면 나를 내보낼 수도 있어요.')
    for (const leadFor of ['김팀장 대표님', 'Acme', '이사님']) for (const name of ['김 대표님', 'Acme', '민준']) expect(text(await view({ leadFor, target: { id: 'u', name, username: 'x' } }))).not.toContain('님님')
  })

  test('each of my connections is a ticked line; an unticked one says it is kept; none listed, no heading', async () => {
    const m = await mount(<HandoverView target={{ id: 'u1', name: '박민준', username: 'minjun.park' }} connections={CONNS} recovery={null} kept={new Set()} onToggle={() => {}} />)
    try {
      const h = text(m.html())
      expect(h).toContain('내 계정으로 연결된 것은 지금 내가 정해요 · 남긴 것은 박민준님이 나중에 끊을 수 있어요')
      expect(h).toContain("팀 AI '회사 Claude' (내 Claude 계정) · 넘기면 끊어요")
      expect(h).toContain("팀 AI 'GPT 팀' (내 ChatGPT 계정) · 넘기면 끊어요")
      expect(h).toContain("드라이브 공유 'Acme 드라이브' (내 구글 계정) · 넘기면 끊어요")
      for (const id of ['team_ai-c1', 'team_ai-c2', 'drive_share-s1']) expect((m.get(`handover-conn-${id}`) as unknown as { checked: boolean }).checked).toBe(true)
    } finally { await m.unmount() }
    const kept = await view({ kept: new Set(['drive_share:s1']) })
    expect(text(kept)).toContain("드라이브 공유 'Acme 드라이브' (내 구글 계정) · 남겨요")
    expect(text(kept)).toContain("팀 AI '회사 Claude' (내 Claude 계정) · 넘기면 끊어요")
    expect(await view({ connections: [] })).not.toContain('handover-connections')
    // the list could not be read: the transfer still works, the line says where to end them
    expect(text(await view({ connections: null, failed: true }))).toContain('내 계정으로 연결된 것을 읽지 못했어요')
  })

  test('who can still reset passwords: the hosting account, the server Mac, whoever installed the server', async () => {
    expect(text(await view({ recovery: 'hosted' }))).toContain('이 팀을 신청한 호스팅 계정(결제·복구 계정)으로는 넘긴 뒤에도 팀장·관리자 비밀번호를 다시 정할 수 있어요')
    expect(text(await view({ recovery: 'server_mac' }))).toContain('서버 맥의 관리자 비밀번호도 바꿔 주세요')
    expect(text(await view({ recovery: 'server' }))).toContain('이 서버를 설치한 사람은 비밀번호를 다시 정할 수 있어요')
    expect(await view({ recovery: null })).not.toContain('handover-recovery')
  })

  test('the labels are text, never markup', async () => {
    const h = await view({ leadFor: '<b>x</b>', target: { id: 'u', name: '<img src=x>', username: 'a' } })
    expect(h).not.toContain('<b>x</b>')
    expect(h).not.toContain('<img')
  })

  test('a refusal: the role moved (409 owner_changed, or my owner right is gone: a 403 not about the password) closes it; not ready, too many tries and anything else stay under the field', async () => {
    const err = (status: number, body: ConstructorParameters<typeof ApiError>[1]) => new ApiError(status, body)
    expect(transferRefusal(err(409, { code: 'conflict', message: '이미 팀장이 바뀌었어요.', params: { reason: 'owner_changed' } }))).toBe('owner_changed')
    expect(transferRefusal(err(409, { code: 'conflict', message: 'x', params: { reason: 'target_not_ready' } }))).toBe('not_ready')
    // the target disabled meanwhile: a plain 409, the server's own words
    expect(transferRefusal(err(409, { code: 'conflict', message: '사용할 수 없는 계정이에요.' }))).toBe('other')
    expect(transferRefusal(err(403, { code: 'forbidden', message: 'no' }))).toBe('owner_changed')
    expect(transferRefusal(err(403, { code: 'forbidden', message: '비밀번호가 맞지 않아요.', fields: { 'body.password': 'wrong password' } }))).toBe('other')
    expect(transferRefusal(err(429, { code: 'rate_limited', message: 'x' }))).toBe('rate_limited')
    expect(transferRefusal(new Error('offline'))).toBe('other')
  })
})

describe('Admin › Members "…" › 팀장 넘기기', () => {
  const user = (o: Partial<User> = {}): User => ({ id: 'bob', username: 'bob', name: 'Bob', email: null, role: 'member', status: 'active', mustChangePassword: false, locale: 'ko', localeChoice: null, groupIds: [], createdAt: JOINED, lastSeenAt: JOINED, ...o }) as User
  test('the owner only, to an active person other than me, past a temporary password, signed in at least once', async () => {
    expect(handoverTarget(user(), me('owner'))).toBe(true)
    expect(handoverTarget(user({ role: 'admin' }), me('owner'))).toBe(true)
    expect(handoverTarget(user(), me('admin'))).toBe(false)
    expect(handoverTarget(user(), null)).toBe(false)
    expect(handoverTarget(user({ id: 'olga' }), me('owner'))).toBe(false)
    expect(handoverTarget(user({ status: 'disabled' }), me('owner'))).toBe(false)
    expect(handoverTarget(user({ mustChangePassword: true }), me('owner'))).toBe(false)
    expect(handoverTarget(user({ lastSeenAt: null }), me('owner'))).toBe(false)
  })
})

describe('the Home card and the Inbox rows', () => {
  const card = { inviteId: '01900000-0000-7000-8000-000000000001', leadFor: '김팀장 대표님', user: { id: 'u1', name: '박민준', username: 'minjun.park' }, joinedAt: JOINED, dismissed: false }
  const time = (l: 'ko' | 'en') => new Intl.DateTimeFormat(l === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(JOINED))

  test('the card: the owner\'s words, the account\'s name, username and join time side by side, one [넘기기] and ✕', async () => {
    expect(joinedText(T, 'ko', card)).toBe(`김팀장 대표님에게 보낸 팀장 링크로 '박민준'(아이디 minjun.park)님이 ${time('ko')}에 들어왔어요`)
    expect(joinedText(TEN, 'en', card)).toBe(`'박민준' (username minjun.park) joined at ${time('en')} with the owner link you sent to 김팀장 대표님`)
    const h = await html(<HandoverCard card={card} />)
    expect(text(h)).toContain(`${joinedText(T, 'ko', card)}팀장을 넘길까요?`)
    expect(h.match(/<button/g)?.length).toBe(2)
    expect(h).toContain('aria-label="닫기"')
    expect(text(h)).not.toContain('님님')
  })

  test('the card shows only for the owner, where the flag is offered, while it holds and is not closed', async () => {
    let got: unknown = 'unset'
    const Probe = () => { got = useLeadCard(true); return null }
    const read = async (s: HandoverState | null, role: 'owner' | 'admin' = 'owner') => {
      useSession.setState({ status: { kind: 'signed-in', me: me(role) } })
      useHandover.setState({ loaded: true, state: s })
      await html(<Probe />)
      return got
    }
    expect(await read(state({ card }))).toEqual(card)
    expect(await read(state({ card, flag: false }))).toBeNull()
    expect(await read(state({ card: { ...card, dismissed: true } }))).toBeNull()
    expect(await read(state({ card: null }))).toBeNull()
    expect(await read(state({ card }), 'admin')).toBeNull()
  })

  test('lead_joined: the card\'s sentence; while it holds it asks, else "지금은 넘길 수 없어요"; a deleted account is named by nobody', async () => {
    const n = (o: Partial<Extract<HandoverNote, { kind: 'lead_joined' }>> = {}): HandoverNote => ({ kind: 'lead_joined', leadFor: '김팀장 대표님', user: card.user, joinedAt: JOINED, open: true, ...o })
    expect(handoverNoticeText(T, 'ko', n())).toBe(`${joinedText(T, 'ko', card)} · 팀장을 넘길까요?`)
    expect(handoverNoticeText(T, 'ko', n({ open: false }))).toBe(`${joinedText(T, 'ko', card)} · 지금은 넘길 수 없어요`)
    expect(handoverNoticeText(T, 'ko', n({ user: null }))).toBe(`김팀장 대표님에게 보낸 팀장 링크로 ${time('ko')}에 들어온 계정은 이제 없어요`)
  })

  test('transferred: to me, from me, to someone else; deleted accounts unnamed; what was ended; the hosted line for the two people', async () => {
    const n = (o: Partial<Extract<HandoverNote, { kind: 'transferred' }>> = {}): HandoverNote => ({ kind: 'transferred', me: 'to', from: { id: 'olga', name: '지수' }, to: { id: 'u1', name: '김 대표님' }, removable: true, setupUnfinished: true, recovery: null, ended: { teamAi: 0, driveShares: 0, failed: 0 }, ...o })
    expect(handoverNoticeText(T, 'ko', n())).toBe('지수님이 팀장을 넘겼어요 · 지수님은 관리자로 남아 있어요')
    expect(handoverNoticeText(T, 'ko', n({ from: { id: 'x', name: '이사님' } }))).toBe('이사님이 팀장을 넘겼어요 · 이사님은 관리자로 남아 있어요')
    expect(handoverNoticeText(T, 'ko', n({ me: 'from' }))).toBe('김 대표님이 팀장이 되었어요 · 나는 관리자예요')
    expect(handoverNoticeText(T, 'ko', n({ me: 'other' }))).toBe('팀장이 김 대표님으로 바뀌었어요')
    expect(handoverNoticeText(T, 'ko', n({ me: 'other', to: { id: 'b', name: 'Bob' } }))).toBe('팀장이 Bob님으로 바뀌었어요')
    expect(handoverNoticeText(T, 'ko', n({ from: null }))).toBe('팀장을 넘겨받았어요')
    expect(handoverNoticeText(T, 'ko', n({ me: 'from', to: null }))).toBe('팀장을 넘겼어요 · 나는 관리자예요')
    expect(handoverNoticeText(T, 'ko', n({ me: 'other', to: null }))).toBe('팀장이 바뀌었어요')
    expect(handoverNoticeLines(T, n())).toEqual([])
    expect(handoverNoticeLines(T, n({ ended: { teamAi: 1, driveShares: 2, failed: 1 } }))).toEqual(['끊은 연결: 팀 AI 1개 · 드라이브 공유 2개', '끊지 못한 연결 1개 · 관리자 › 제공자·커넥터에서 끊을 수 있어요'])
    expect(handoverNoticeLines(T, n({ ended: { teamAi: 0, driveShares: 1, failed: 0 } }))).toEqual(['끊은 연결: 드라이브 공유 1개'])
    expect(handoverNoticeLines(TEN, n({ ended: { teamAi: 1, driveShares: 2, failed: 0 } }))).toEqual(['Disconnected: 1 team AI · 2 Drive shares'])
    expect(handoverNoticeLines(T, n({ recovery: 'hosted' }))[0]).toStartWith('이 팀을 신청한 호스팅 계정')
    expect(handoverNoticeLines(T, n({ me: 'from', recovery: 'hosted' }))).toHaveLength(1)
    expect(handoverNoticeLines(T, n({ me: 'other', recovery: 'hosted' }))).toEqual([])
    // team connections (MCP, Higgsfield) ended; with what is still to end listed for the new owner, no second count line
    expect(handoverNoticeLines(T, n({ ended: { teamAi: 0, driveShares: 0, failed: 0, connections: 2 } }))).toEqual(['끊은 연결: 팀 연결 2개'])
    expect(handoverNoticeLines(T, n({ ended: { teamAi: 0, driveShares: 0, failed: 1 }, pending: [{ kind: 'team_ai', id: 'c', label: 'A' }] }))).toEqual([])
    expect(connectionLine(T, { kind: 'team_connection', provider: 'service', label: 'Higgsfield' })).toBe("팀 연결 'Higgsfield' (내 계정으로 로그인)")
  })

  test('reauth_locked, and the generic texts for a notice without its details', async () => {
    // any of the owner's password re-checks (팀장 넘기기, updates, restore, …): one generic sentence
    // never "change your password" first: that check is locked too; signing a device out asks for none
    expect(handoverNoticeText(T, 'ko', { kind: 'reauth_locked' })).toBe('비밀번호 확인이 여러 번 틀려서 15분 동안 막혔어요 · 내가 한 게 아니면 설정 › 보안에서 모르는 기기를 먼저 로그아웃하고, 그다음 비밀번호를 바꿔 주세요')
    expect(ko('handover.lockedLink')).toBe('설정 › 보안')
    for (const code of ['owner.lead_joined', 'owner.transferred', 'owner.reauth_locked']) expect(ko(`notifications.event.${code}` as MessageKey)).not.toBe(`notifications.event.${code}`)
  })
})

describe('names beside the join time are isolated (<bdi>)', () => {
  const card = { inviteId: '01900000-0000-7000-8000-000000000001', leadFor: '김팀장 대표님', user: { id: 'u1', name: '\u202e박민준', username: 'minjun' }, joinedAt: JOINED, dismissed: false }
  test('the same words as the text, each value in its own <bdi>, the honorific rules applied', async () => {
    const h = await html(<>{isolate('ko', 'handover.title', { name: '김팀장 대표님' }, ['name'])}</>)
    expect(h).toBe('<div><bdi>김팀장 대표님</bdi>을 팀장으로 정할까요?</div>')
    expect(await html(<>{isolate('ko', 'handover.title', { name: 'Acme' }, ['name'])}</>)).toBe('<div><bdi>Acme</bdi>님을 팀장으로 정할까요?</div>')
  })
  test('the card, the Inbox row and the confirm', async () => {
    const c = await html(<HandoverCard card={card} />)
    expect(c).toContain('<bdi>김팀장 대표님</bdi>에게 보낸 팀장 링크로 \'<bdi>\u202e박민준</bdi>\'(아이디 <bdi>minjun</bdi>)님이 ')
    const row = await html(<>{handoverNoticeNode('ko', { kind: 'lead_joined', leadFor: card.leadFor, user: card.user, joinedAt: JOINED, open: true })}</>)
    expect(row).toContain('<bdi>\u202e박민준</bdi>')
    expect(text(row)).toBe(handoverNoticeText(T, 'ko', { kind: 'lead_joined', leadFor: card.leadFor, user: card.user, joinedAt: JOINED, open: true }))
    expect(await html(<>{handoverNoticeNode('ko', { kind: 'transferred', me: 'to', from: { id: 'olga', name: '지수' }, to: null, removable: false, setupUnfinished: false, recovery: null, ended: { teamAi: 0, driveShares: 0, failed: 0 } })}</>)).toBe('<div><bdi>지수</bdi>님이 팀장을 넘겼어요 · <bdi>지수</bdi>님은 관리자로 남아 있어요</div>')
    const v = await view({ leadFor: '김팀장 대표님' })
    expect(v).toContain('받는 사람: <bdi>김팀장 대표님</bdi> · ')
    expect(await view()).toContain('<bdi>박민준</bdi>(아이디 <bdi>minjun.park</bdi>)')
  })
})

describe('the lead flag on the invite step', () => {
  const step = () => html(<MemoryRouter><LeadInvite><p data-testid="team-link-panel">panel</p></LeadInvite></MemoryRouter>)
  test('the owner, where the server offers it: the checkbox row above the team link panel', async () => {
    useHandover.setState({ loaded: true, state: state() })
    const h = await step()
    expect(h).toContain('data-testid="lead-flag"')
    expect(text(h)).toContain('이 사람이 팀장이에요 · 들어오면 팀장을 넘길지 물어볼게요')
    expect(h).toContain('data-testid="team-link-panel"')
  })
  test('not for an admin, nor where the server does not offer it (a hosted team without its safety switch)', async () => {
    useHandover.setState({ loaded: true, state: state({ flag: false }) })
    expect(await step()).not.toContain('lead-flag')
    useSession.setState({ status: { kind: 'signed-in', me: me('admin') } })
    useHandover.setState({ loaded: true, state: state() })
    expect(await step()).not.toContain('lead-flag')
    expect(await step()).toContain('team-link-panel')
  })
  test('a lead link made earlier is one quiet line', async () => {
    useHandover.setState({ loaded: true, state: state({ openLead: { inviteId: '01900000-0000-7000-8000-000000000002', leadFor: '김팀장 대표님', expiresAt: '2026-11-11T06:00:00.000Z' } }) })
    expect(text(await step())).toContain('김팀장 대표님에게 보낸 팀장 링크가 ')
  })
  test('the one-person message names who set the team up and the product, with no particle after a label', async () => {
    expect(leadMessage(T, { name: '지수', url: 'https://acme.example/invite/x' })).toBe('지수님이 Trina AX에 팀을 만들어 두었어요. 들어오면 지수님이 팀장을 넘겨 드려요: https://acme.example/invite/x · 한 사람만 쓸 수 있는 링크예요')
    expect(leadMessage(T, { name: '김 대표님', url: 'u' })).not.toContain('님님')
  })
})

describe('realtime', () => {
  const notice = (code: string, message = '팀장이 Bob님으로 바뀌었어요'): ServerEvent => ({ type: 'notice', seq: 9, at: Date.now(), data: { level: 'info', code, message } })
  test('owner_changed: the account is read again and the server\'s words are toasted, not twice in the window that pressed [넘기기]', async () => {
    let mes = 0
    useSession.setState({ refreshMe: async () => { mes++ } })
    useHandover.setState({ load: async () => null })
    useUi.setState({ toasts: [] } as never)
    dispatch(notice('owner_changed'))
    expect(mes).toBe(1)
    expect(JSON.stringify(useUi.getState())).toContain('팀장이 Bob님으로 바뀌었어요')
    useUi.setState({ toasts: [] } as never)
    markTransferredHere()
    expect(transferredHere()).toBe(true)
    dispatch(notice('owner_changed'))
    expect(mes).toBe(2)
    expect(JSON.stringify(useUi.getState())).not.toContain('팀장이 Bob님으로 바뀌었어요')
    expect(transferredHere(Date.now() + 60_000)).toBe(false)
  })
  test('owner_lead_joined: the handover state is read again, no toast', async () => {
    let loads = 0
    useHandover.setState({ load: async () => { loads++; return null } })
    useUi.setState({ toasts: [] } as never)
    dispatch(notice('owner_lead_joined', '김팀장 대표님에게 보낸 팀장 링크로 박민준님이 들어왔어요'))
    expect(loads).toBe(1)
    expect(JSON.stringify(useUi.getState())).not.toContain('박민준')
  })
})
