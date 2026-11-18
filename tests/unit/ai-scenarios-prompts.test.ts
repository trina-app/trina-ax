// The absurd-prompt detector of the AI scenario flows (tests/ai-scenarios/lib/flow-report.ts), on made-up runs; what the
// judge is told (lib/judge.ts givenFacts) and the room posts a case's clean-up deletes (lib/run-case.ts roomPostsOf).
import { describe, expect, test } from 'bun:test'
import { normUrl, type FlowResult } from '../ai-scenarios/lib/flow'
import { absurdPrompts } from '../ai-scenarios/lib/flow-report'
import { givenFacts } from '../ai-scenarios/lib/judge'
import { roomPostsOf } from '../ai-scenarios/lib/run-case'

const card = (question: string, hasAlways = true) => ({ kind: 'server-card', origin: 'server' as const, question, answer: 'yes', options: [], hasAlways })
const run = (steps: { prompt: string; context?: string; cards: ReturnType<typeof card>[]; seenUrls?: string[] }[]): FlowResult => ({
  id: 'FL-99', runId: 'x', commit: 'x', startedAt: '', cardMode: 'once', firstBroken: null,
  steps: steps.map((s, i) => ({ index: i + 1, say: '', kind: 'ask', as: 'sora', chat: 'c', context: s.context ?? 'personal', prompts: [s.prompt], seenUrls: s.seenUrls ?? [], changed: [], checks: [], jargon: [],
    turn: { prompt: s.prompt, status: 'done', error: null, answer: 'ok', tools: [], cards: s.cards, saved: [], ms: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, apiCalls: 0 }, model: null } })),
})

describe('absurd prompts', () => {
  test('addresses compare without tracking, fragment or trailing slash', () => {
    expect(normUrl('https://Notes.example.com/s/ab/?utm_source=x&fbclid=1&gclid=2#top')).toBe('https://notes.example.com/s/ab')
    expect(normUrl('https://a.example/x?id=3&utm_medium=y')).toBe('https://a.example/x?id=3')
  })
  test('an address card for a link already in the room is flagged, and so is a card without Always allow', () => {
    const f = absurdPrompts(run([{ prompt: '회의록 링크 내용 저장해줘', context: 'room-side', seenUrls: ['https://notes.example.com/s/ab'], cards: [card('AI가 이 주소를 열려고 해요. https://notes.example.com/s/ab?utm_source=t#x', false)] }]), { roomName: '라마바카페 건' })
    expect(f.map((x) => x.reason)).toEqual(expect.arrayContaining([expect.stringContaining('already in this'), expect.stringContaining('no "Always allow"')]))
  })
  test('a card for what the person just asked, a same-room warning, a repeat and the counts are flagged', () => {
    const f = absurdPrompts(run([
      { prompt: '이 파일 최하나님한테 공유해줘', cards: [card('최하나님에게 파일 1개를 공유할까요?')] },
      { prompt: '스레드에 답글로 달아줘', context: 'room-side', cards: [card("여기에 대화 메시지(다른 사람이 쓴 글)가 들어와서 … '라마바카페 건' 스레드에 보낼까요?"), card("'라마바카페 건' 스레드에 보낼까요?")] },
    ]), { roomName: '라마바카페 건', afterAlways: run([{ prompt: 'x', cards: [card('저장할까요?')] }]) })
    const reasons = f.map((x) => x.reason).join('\n')
    expect(reasons).toContain('explicitly asked')
    expect(reasons).toContain('same room')
    expect(reasons).toContain('same target')
    expect(reasons).toContain('more than 1 prompt')
    expect(reasons).toContain('after Always allow')
  })
  test('a flow with no prompts has no flags', () => {
    expect(absurdPrompts(run([{ prompt: '요약해줘', cards: [] }]), { roomName: '라마바카페 건', afterAlways: run([{ prompt: 'x', cards: [] }]) })).toEqual([])
  })
})

describe('what the judge is told, and what a case leaves behind', () => {
  test('the judge knows the time of day the AI was given, in the team zone (EDIT-17: "already night" at 23:52)', () => {
    const c = { install: 'local-login' } as unknown as Parameters<typeof givenFacts>[0]
    expect(givenFacts(c, { startedAt: '2026-11-17T14:52:00.000Z' })).toContain('when this case started: Tuesday 2026-11-17 23:52')
    expect(givenFacts(c)).not.toContain('when this case started')
    // a case sent from a Jakarta device: the time there
    expect(givenFacts({ ...c, timeZone: 'Asia/Jakarta' }, { startedAt: '2026-11-17T14:52:00.000Z' })).toContain('in Asia/Jakarta, the zone the person\'s device sent (when this case started: Tuesday 2026-11-17 21:52')
    // what the AI can do when asked (SYS-04) and what a card's answer is (CHT-02)
    expect(givenFacts(c)).toContain("read a file's earlier\nversions")
    expect(givenFacts(c)).toContain('the answer shown is what the person pressed')
  })
  test('the room posts a case made are found for clean-up, only the ones that went', () => {
    const tool = (result: string, ok = true) => ({ name: 'post_to_room', input: {}, ok, result })
    const turns = [{ tools: [
      tool('{"status":"sent","room":"라마바카페 건","room_id":"r1","message_id":"m1","note":"x"}'),
      tool('Nothing was posted: the user chose not to send it'),
      tool('{"status":"sent","room_id":"r2","message_id":"m2"}', false),
      { name: 'read', input: {}, ok: true, result: '{"status":"sent","room_id":"r3","message_id":"m3"}' },
    ] }] as unknown as Parameters<typeof roomPostsOf>[0]['turns']
    expect(roomPostsOf({ turns })).toEqual([{ roomId: 'r1', messageId: 'm1' }])
  })
})
