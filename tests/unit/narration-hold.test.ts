// English status lines before a tool call stay out of a Korean, Japanese or Chinese answer
// (server/src/chat/narration.ts, docs/decisions/20261116-answer-no-english-narration.md).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { NarrationHold, narrationScript } from '../../server/src/chat/narration'

setDefaultTimeout(60_000)

type Ev = { text: string } | 'tool' | 'end'
/** the events through a hold, in pieces of n characters: what went out, joined */
function run(hold: NarrationHold, evs: Ev[], n = 7): string {
  let out = ''
  for (const e of evs) {
    if (e === 'tool') out += hold.toolStart()
    else if (e === 'end') out += hold.flush()
    else for (let i = 0; i < e.text.length; i += n) out += hold.push(e.text.slice(i, i + n))
  }
  return out
}
const ko = () => new NarrationHold('ko')

describe('NarrationHold', () => {
  test('a Korean answer: the English line before a tool call is dropped, with its separator', () => {
    expect(run(ko(), [{ text: 'Only one thread exists; check it.' }, 'tool', { text: '\n\n' }, { text: '토요일 배송은 퀵으로만 가능해요.' }, 'end']))
      .toBe('토요일 배송은 퀵으로만 가능해요.')
    // two calls in a row, each with a line before it
    expect(run(ko(), [{ text: 'Let me check that the seal printed correctly.' }, 'tool', { text: '\n\nVerify:' }, 'tool', { text: '\n\n견적서를 만들었습니다.' }, 'end']))
      .toBe('견적서를 만들었습니다.')
    // Korean text first, then an English line before a call: the Korean keeps its separator to what follows
    expect(run(ko(), [{ text: '사진 두 장을 확인할게요.' }, 'tool', { text: '\n\nFollowing the existing naming pattern (매장-전경.jpg).' }, 'tool', { text: '\n\nNow renaming.' }, 'tool', { text: '\n\n이름을 바꿨습니다.' }, 'end']))
      .toBe('사진 두 장을 확인할게요.\n\n이름을 바꿨습니다.')
    // a Korean file name alone does not make the line Korean; Korean words do
    expect(run(ko(), [{ text: '`매장-전경.jpg` 이름을 따를게요.' }, 'tool', { text: '\n\n끝.' }, 'end'])).toBe('`매장-전경.jpg` 이름을 따를게요.\n\n끝.')
  })

  test('a Korean line before a tool call is kept, and streams as soon as it shows Hangul', () => {
    const h = ko()
    expect(h.push('파일을 ')).toBe('파일을 ')
    expect(h.push('확인할게요.')).toBe('확인할게요.')
    expect(h.toolStart()).toBe('')
    expect(run(ko(), [{ text: '파일을 확인할게요.' }, 'tool', { text: '\n\n다 됐어요.' }, 'end'])).toBe('파일을 확인할게요.\n\n다 됐어요.')
  })

  test('the last piece is always kept: an English email asked for in a Korean chat', () => {
    const email = 'Dear Mr. Smith,\n\nThank you for your order. We will ship it on Thursday.\n\nBest regards,\nSora Lee'
    expect(run(ko(), [{ text: '단가표를 읽을게요.' }, 'tool', { text: '\n\n' + email }, 'end'])).toBe('단가표를 읽을게요.\n\n' + email)
    // a short English answer with no call after it
    expect(run(ko(), [{ text: 'OK.' }, 'end'])).toBe('OK.')
    // the message asks for English: the hold is off, even for a short line before a call
    expect(narrationScript('ko', '이 메일을 영어로 써서 방에 올려줘')).toBeNull()
    expect(narrationScript('ko', 'translate this: 감사합니다')).toBeNull()
  })

  test('content is never dropped: code, quotes, links, tables, longer text', () => {
    for (const piece of ['```\nnpm run build\n```', 'He wrote "see you Thursday".', 'See [price list](/files/view?path=x).', '| a | b |', '> quoted', 'One. Two. Three. Four.', 'x'.repeat(201)]) {
      expect(run(ko(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end']), piece).toBe(piece + '\n\n끝.')
    }
    // no Latin letters (numbers, marks): kept
    expect(run(ko(), [{ text: '339,400' }, 'tool', { text: '\n\n끝.' }, 'end'])).toBe('339,400\n\n끝.')
  })

  test('a long piece goes out as soon as it is known to be content', () => {
    const h = ko()
    expect(h.push('a'.repeat(150))).toBe('')
    expect(h.push('b'.repeat(60))).toBe('a'.repeat(150) + 'b'.repeat(60))
    expect(h.push(' more')).toBe(' more')
    expect(h.toolStart()).toBe('')
  })

  test('English, Indonesian and Spanish answers are untouched; Japanese and Chinese drop like Korean', () => {
    for (const locale of ['en', 'id', 'es'] as const) {
      const h = new NarrationHold(narrationScript(locale, 'check the price list'))
      expect(run(h, [{ text: 'Let me check.' }, 'tool', { text: '\n\nDone.' }, 'end'])).toBe('Let me check.\n\nDone.')
    }
    // a Korean app, a message in English: the answer is English, nothing is dropped
    expect(narrationScript('ko', 'What did we agree in the room?')).toBeNull()
    expect(narrationScript('ko', '방에서 뭐라고 정했어?')).toBe('ko')
    expect(run(new NarrationHold(narrationScript('ja', '見積書を作って')), [{ text: 'Let me check.' }, 'tool', { text: '\n\n作りました。' }, 'end'])).toBe('作りました。')
    expect(run(new NarrationHold(narrationScript('zh', '做一份报价单')), [{ text: 'Let me check.' }, 'tool', { text: '\n\n做好了。' }, 'end'])).toBe('做好了。')
  })

  test('clear forgets what is held', () => {
    const h = ko()
    h.push('Let me')
    expect(h.held).toBe('Let me')
    h.clear()
    expect(h.flush()).toBe('')
  })
})

// ---------------- real turns: what streams is what is saved ----------------
const GATE = path.join(import.meta.dir, '../../native/bin', `${process.platform}-${process.arch}`, 'mycel-gate')
const native = fs.existsSync(GATE)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('a turn with an English line before a tool call', () => {
  let h: Harness
  const published: { userId: string; ev: any }[] = []
  beforeAll(async () => {
    h = await startHarness({ name: 'narration-hold' })
    const hub = h.rt().hub
    const publish = hub.publish.bind(hub)
    hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
  })
  afterAll(async () => { await h?.close() })

  async function turn(locale: string, content: string) {
    h.ctx.db.query('UPDATE users SET locale = ? WHERE id = ?').run(locale, 'alice')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const id = started.assistantMessage.id
    const doneEv = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 40_000, what: 'message.done' })
    const deltas = published.filter((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id).map((p) => p.ev.data as { offset: number; text: string })
    let streamed = ''
    for (const d of deltas) { expect(d.offset).toBe(streamed.length); streamed += d.text }
    const stored = (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(id) as { content: string }).content
    return { streamed, stored, done: doneEv!.ev.data.message.content as string }
  }

  test.skipIf(!native)('Korean: the English line is neither streamed nor saved; the stream and the saved answer agree', async () => {
    const t = await turn('ko', '단가표 확인해줘\n' + fake(
      { say: 'Let me check that the seal printed correctly.' },
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: '단가표를 확인했어요. ' },
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: 'Dear Mr. Smith, thank you for your order.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.done).toBe(t.stored)
    expect(t.stored).not.toContain('Let me check')
    expect(t.stored).toBe('단가표를 확인했어요. \n\nDear Mr. Smith, thank you for your order.')
  })

  test.skipIf(!native)('English: the same line is kept', async () => {
    const t = await turn('en', 'check the price list\n' + fake(
      { say: 'Let me check that the seal printed correctly.' },
      { tool: 'read', args: { file_path: 'shared/missing.txt' } },
      { say: 'Done.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).toBe('Let me check that the seal printed correctly.\n\nDone.')
  })
})
