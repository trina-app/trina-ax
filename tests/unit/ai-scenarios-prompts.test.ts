// The absurd-prompt detector of the AI scenario flows (tests/ai-scenarios/lib/flow-report.ts), on made-up runs.
import { describe, expect, test } from 'bun:test'
import { normUrl, type FlowResult } from '../ai-scenarios/lib/flow'
import { absurdPrompts } from '../ai-scenarios/lib/flow-report'

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
