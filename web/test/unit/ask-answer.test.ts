// The message box answers the AI's open question (lib/askAnswer.ts): which card it answers, which cards it never
// answers, and the answer it gives.
import { describe, expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import { choiceWaiting, composerAnswer, composerQuestion, forgetPicks, picksOf, rememberPicks, type AskUserRequest } from '../../src/lib/askAnswer'
import type { OpenRequest } from '../../src/store/chats'

const CHAT = '0192f0a0-0000-7000-8000-00000000c001'
const OTHER = '0192f0a0-0000-7000-8000-00000000c002'
const open = (request: TurnRequest, chatId = CHAT): OpenRequest => ({ turnId: 't1', chatId, messageId: 'm1', request })
const question = (requestId: string, o: Partial<AskUserRequest> = {}): AskUserRequest => ({ kind: 'ask_user', requestId, question: `question ${requestId}`, expiresAt: '2026-10-30T10:10:00.000Z', ...o })
const byId = (...rs: OpenRequest[]) => Object.fromEntries(rs.map((r) => [r.request.requestId, r]))
/** the id of the card the message box answers among these, or null */
const answered = (rs: OpenRequest[], chatId = CHAT) => composerQuestion(byId(...rs), chatId)?.request.requestId ?? null
const id = (r: OpenRequest) => r.request.requestId

describe('which open card the message box answers', () => {
  test("the AI's own question in this chat", () => {
    const q = open(question('0192f0a1-0000-7000-8000-000000000001'))
    expect(answered([q])).toBe(id(q))
    expect(answered([q], OTHER)).toBeNull()
    expect(composerQuestion({}, CHAT)).toBeNull()
  })

  test('never a safety check of the server or a browser site confirmation: only their own buttons decide', () => {
    const safety = open(question('0192f0a1-0000-7000-8000-000000000002', { origin: 'server', options: [{ label: 'Open', value: 'allow' }, { label: "Don't", value: 'deny' }], allowText: false }))
    const site = open({ kind: 'browser_site', requestId: 'b1', url: 'http://10.0.0.5/', host: '10.0.0.5' })
    expect(answered([safety, site])).toBeNull()
    expect(choiceWaiting(byId(safety), CHAT)).toBe(true)
    expect(choiceWaiting(byId(site), CHAT)).toBe(true)
    expect(choiceWaiting(byId(safety, site), OTHER)).toBe(false)
    // with an AI question open as well, the box answers that one and still says nothing about the others
    const q = open(question('0192f0a1-0000-7000-8000-000000000003'))
    expect(answered([safety, q, site])).toBe(id(q))
    expect(choiceWaiting(byId(q), CHAT)).toBe(false)
  })

  test('several questions open at once: the one shown first, then the next', () => {
    const first = open(question('0192f0a1-0000-7000-8000-00000000000a', { expiresAt: '2026-10-30T10:10:00.000Z' }))
    const second = open(question('0192f0a1-0000-7000-8000-00000000000b', { expiresAt: '2026-10-30T10:10:05.000Z' }))
    const sameTime = open(question('0192f0a1-0000-7000-8000-00000000000c', { expiresAt: '2026-10-30T10:10:05.000Z' }))
    // the order the cards arrived in this window does not matter (a reload lists them again)
    expect(answered([sameTime, second, first])).toBe(id(first))
    expect(answered([sameTime, second])).toBe(id(second))
  })
})

describe('the answer a message gives', () => {
  test('one answer: the typed text, as the person wrote it (like the card\'s own box)', () => {
    const q = question('q', { options: [{ label: 'Q3', value: 'q3' }, { label: 'Q4', value: 'q4' }] })
    expect(composerAnswer(q, [], '  both, please \n')).toBe('both, please')
    // a pick on the card is replaced by the own answer, like typing in the card's box
    expect(composerAnswer(q, ['q3'], 'Q4 only')).toBe('Q4 only')
    // also on a question that offered no text box: the person can always answer in their own words
    expect(composerAnswer({ ...q, allowText: false }, [], 'neither')).toBe('neither')
  })

  test('several answers: the options ticked on the card, then the typed text', () => {
    const q = question('q', { multiple: true, options: [{ label: 'Q3', value: 'q3' }, { label: 'Q4', value: 'q4' }] })
    expect(composerAnswer(q, ['q4', 'q3'], 'and the yearly total')).toEqual(['q4', 'q3', 'and the yearly total'])
    expect(composerAnswer(q, [], 'only the total')).toEqual(['only the total'])
    expect(composerAnswer(q, ['gone'], 'x')).toEqual(['x'])
  })

  test('what an open card has ticked is known until it closes', () => {
    rememberPicks('r1', ['q3'])
    expect(picksOf('r1')).toEqual(['q3'])
    rememberPicks('r1', [])
    expect(picksOf('r1')).toEqual([])
    rememberPicks('r1', ['q4'])
    forgetPicks('r1')
    expect(picksOf('r1')).toEqual([])
  })
})
