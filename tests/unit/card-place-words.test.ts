// A server card names a chat place by its words, never its raw path (QA re-smoke: an edit_pdf card in a shared chat
// said "chat:files/<uuid>/…"): server/src/chat/turn.ts cardPlaceWords, run on every card in waitForPerson. The AI's
// own questions stay its words; what goes out exactly (a block's text, its fields) stays as written.
import { describe, expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import { cardPlaceText, cardPlaceWords } from '../../server/src/chat/turn'
import { expectNoRawPlace } from '../lib/card-places'

const ID = '01a2005b-1c2d-7e3f-8a9b-0c1d2e3f4a5b'
const card = (o: Partial<Extract<TurnRequest, { kind: 'ask_user' }>> = {}): Extract<TurnRequest, { kind: 'ask_user' }> => ({
  kind: 'ask_user', requestId: 'r1', origin: 'server',
  question: `AI가 chat:files/${ID}/견적서.pdf 을 고쳐 'chat:work/out/a b.png' 에 저장하려고 해요.`,
  note: `chat:files/${ID}/견적서.pdf 에만 적용돼요`,
  options: [{ label: `chat:work/out/견적서-v2.pdf 에 저장`, value: 'share' }],
  details: [{ label: `chat:files/${ID}/견적서.pdf`, text: `chat:files/${ID}/a.pdf\nchat:work/b.png`, noSize: true }, { label: 'Body', text: 'send chat:files/x as is' }],
  placeTip: { text: `chat:files/${ID}/견적서.pdf`, title: `chat:files/${ID}/견적서.pdf` },
  ...o,
})

describe('server cards name chat places in words', () => {
  test('question, note, choices, block labels, name lists and the tip: no raw chat place, no file id', () => {
    for (const L of ['ko', 'en'] as const) {
      const out = cardPlaceWords(card(), L) as Extract<TurnRequest, { kind: 'ask_user' }>
      expectNoRawPlace(out)
      expect(JSON.stringify(out)).not.toContain(ID)
      expect(out.question).toContain('견적서.pdf')
      // the tip still points at a part of the question
      expect(out.question).toContain(out.placeTip!.text)
      // what goes out as written stays
      expect(out.details![1]!.text).toBe('send chat:files/x as is')
    }
    const ko = cardPlaceWords(card(), 'ko') as Extract<TurnRequest, { kind: 'ask_user' }>
    expect(ko.question).toContain('이 채팅 › 견적서.pdf')
    expect(ko.question).toContain('작업 폴더 › out › a b.png')
  })
  test('a path already cut at " › " loses its id too', () => {
    expect(cardPlaceText(`chat:files › ${ID} › 견적서.pdf`, 'ko')).toBe('이 채팅 › 견적서.pdf')
  })
  test("the AI's own question and a card without a chat place are as they were", () => {
    const ai = card({ origin: undefined })
    expect(cardPlaceWords(ai, 'ko')).toBe(ai)
    const plain = card({ question: 'Save to 전사 공유?', note: undefined, options: undefined, details: undefined, placeTip: undefined })
    expect(cardPlaceWords(plain, 'ko')).toBe(plain)
  })
})
