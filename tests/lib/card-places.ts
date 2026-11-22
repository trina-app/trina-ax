// A server card never shows a chat place as a raw path (chat:files/<id>/…, chat:work/…): the person reads its words
// ("이 채팅 › 견적서.pdf", "작업 폴더 › …"; server/src/chat/turn.ts cardPlaceWords). Checked on every card a test answers.
import { expect } from 'bun:test'

export function expectNoRawPlace(card: unknown): void {
  const c = card as { origin?: string; question?: string; note?: string; options?: { label: string }[]; details?: { label: string; text: string; noSize?: boolean }[]; placeTip?: { text: string; title: string } }
  if (c.origin !== 'server') return
  const shown = [c.question ?? '', c.note ?? '', c.placeTip?.text ?? '', c.placeTip?.title ?? '', ...(c.options ?? []).map((o) => o.label), ...(c.details ?? []).flatMap((d) => [d.label, d.noSize ? d.text : ''])]
  expect(shown.filter((t) => /chat:(files|work)\//i.test(t))).toEqual([])
}
