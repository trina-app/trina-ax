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
  /** the line before a call, then a Korean answer: was the line dropped? */
  const dropped = (line: string) => {
    const out = run(ko(), [{ text: line }, 'tool', { text: '\n\n끝.' }, 'end'])
    if (out !== '끝.') expect(out, line).toBe(line + '\n\n끝.') // else kept whole, nothing changed
    return out === '끝.'
  }

  test('a Korean answer: the English line before a tool call is dropped, with its separator', () => {
    expect(run(ko(), [{ text: 'Only one thread exists; check it.' }, 'tool', { text: '\n\n' }, { text: '토요일 배송은 퀵으로만 가능해요.' }, 'end']))
      .toBe('토요일 배송은 퀵으로만 가능해요.')
    // two calls in a row, each with a line before it
    expect(run(ko(), [{ text: 'Let me check that the seal printed correctly.' }, 'tool', { text: '\n\nVerify:' }, 'tool', { text: '\n\n견적서를 만들었습니다.' }, 'end']))
      .toBe('견적서를 만들었습니다.')
    // Korean text first, then English lines before calls: the Korean keeps its separator to what follows
    expect(run(ko(), [{ text: '사진 두 장을 확인할게요.' }, 'tool', { text: '\n\nNow renaming.' }, 'tool', { text: '\n\n이름을 바꿨습니다.' }, 'end']))
      .toBe('사진 두 장을 확인할게요.\n\n이름을 바꿨습니다.')
    // a Korean file name alone does not make the line Korean; Korean words do
    expect(run(ko(), [{ text: '`매장-전경.jpg` 이름을 따를게요.' }, 'tool', { text: '\n\n끝.' }, 'end'])).toBe('`매장-전경.jpg` 이름을 따를게요.\n\n끝.')
  })

  test('the lines the AI scenario runs leaked: which are dropped, which still get through', () => {
    for (const line of [
      'Only one thread exists; check it.', 'Let me check that the seal printed correctly.', 'Verify:', 'Now renaming.',
      'The existing file uses the pattern "매장-전경.jpg", so I’ll match it.', 'The only thread is on the first message; check it.',
      'Let me check the folder.', 'Reading the price list.', 'Checking both files.', 'Let me check.', 'Found it.',
    ]) expect(dropped(line), line).toBe(true)
    // kept on purpose (review of #1066, second round: an opening like these is also how content starts; keeping a line
    // is the safe way to be wrong)
    for (const line of [
      'Following the existing naming pattern (매장-전경.jpg).', 'Existing pattern: "매장-전경.jpg" (hyphenated Korean).',
      'Existing naming pattern: "매장-전경.jpg" — Korean with hyphen.', "User's own dictated words.",
      'The Saturday delivery question is in the thread under the copy paper price message.',
    ]) expect(dropped(line), line).toBe(false)
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
    for (const piece of ['```\nnpm run build\n```', 'He wrote "see you Thursday".', 'See [price list](/files/view?path=x).', '| a | b |', '> quoted', 'One. Two. Three. Four.', 'x'.repeat(201),
      // the review's probe (#1066): content written before a call
      'Work smarter, together.', 'Hi team, the deploy is done.', 'https://example.com/report', 'Trina AX', 'Total: 42 files',
      '- Price: 339,400 KRW\n- Due: Friday', '## Results', '**Summary**', 'Run `npm install`.', 'Hola equipo, ya está listo.', 'Xin chào, đã xong.',
      // a status opening, but content: a number with a unit, a link, a list
      'Let me note: 339,400 KRW total.', 'Now see https://example.com', 'Next:\n- one', 'Hi team, I will be out on Friday.',
      // the review's second round: real content that opens like a status line
      'Let me know if you have questions.', 'Let me introduce our new product.', "Let's grow together.", 'Now available on iOS and Android.',
      'Next-gen office automation.', 'First come, first served.', 'Check it out!', 'I will be out of office on Friday.',
      "I'm happy to announce our new hire.", 'Done is better than perfect.', 'Good things take time.', 'Great work, team!',
      'Only the paranoid survive.', 'Still waiting for your reply.', 'No pain, no gain.', 'OK', 'Following up on my last email.',
      'Same day delivery', 'I can help you with that.', 'I need your approval by Monday.', 'We will confirm it by Friday.',
      'Please check it and let me know.', 'The user guide is attached.', 'Looking forward to working with you.',
      'First, preheat the oven.', 'Opening hours: Mon to Fri', 'Verify your email address', 'Reading list for the week',
      'Okay, sounds good to me.', 'I see what you mean.', 'Now open on weekends.', 'I will check in with you tomorrow.']) {
      expect(run(ko(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end']), piece).toBe(piece + '\n\n끝.')
    }
    // no Latin letters (numbers, marks): kept
    expect(run(ko(), [{ text: '339,400' }, 'tool', { text: '\n\n끝.' }, 'end'])).toBe('339,400\n\n끝.')
  })

  test('content streams as soon as a mark shows it is content; until then it waits for the next event', () => {
    const h = ko()
    expect(h.push('Great work, ')).toBe('')
    expect(h.push('team!')).toBe('Great work, team!')
    expect(h.push(' See you.')).toBe(' See you.')
    expect(h.toolStart()).toBe('')
    const w = ko()
    expect(w.push('Hi team, the deploy is done.')).toBe('') // could still go on ", so I'll check …"
    expect(w.toolStart()).toBe('Hi team, the deploy is done.')
  })

  test('the hold follows the language asked for and the person\'s earlier message', () => {
    for (const m of ['인도네시아어로 공지 써서 슬랙에 올려줘', '스페인어로 써줘', '일본말로 바꿔줘', '중국어 버전도 만들어줘', '이거 영문으로'])
      expect(narrationScript('ko', m), m).toBeNull()
    expect(narrationScript('ja', 'スペイン語で書いて')).toBeNull()
    expect(narrationScript('zh', '用西班牙语写一封信')).toBeNull()
    // text often written in English in a Korean chat, and a message that quotes English
    for (const m of ['슬로건 하나 만들어줘', '커밋 메시지 써줘', '저장 버튼 문구 정해줘', '이 문장 "Work smarter, together" 다듬어줘', '버튼 이름: Save all changes 로 바꿔'])
      expect(narrationScript('ko', m), m).toBeNull()
    // short or mixed messages: the app language, unless the message before was in Latin words
    for (const m of ['ok', 'continue', '👍', '', 'Q3 revenue was up 12% and costs fell.\n이거 요약해줘'])
      expect(narrationScript('ko', m), m).toBe('ko')
    expect(narrationScript('ko', 'ok', 'What did we agree in the room?')).toBeNull()
    expect(narrationScript('ko', 'ok', '방에서 뭐라고 정했어?')).toBe('ko')
  })

  test('engine shapes: Codex messages carry their separator; several calls in one round', () => {
    // Codex: each agent_message comes whole, the separator in front
    expect(run(ko(), [{ text: 'Let me check the folder.' }, 'tool', { text: '\n\nReading the price list.' }, 'tool', { text: '\n\n견적서를 만들었어요.' }, 'end'], 1000))
      .toBe('견적서를 만들었어요.')
    // the API engine: one line, then several calls before any more text
    expect(run(ko(), [{ text: 'Checking both files.' }, 'tool', 'tool', 'tool', { text: '\n\n두 파일 다 확인했어요.' }, 'end'])).toBe('두 파일 다 확인했어요.')
    // an answer that ends on a call: nothing comes back
    expect(run(ko(), [{ text: 'Let me check.' }, 'tool', 'end'])).toBe('')
  })

  test('a long piece goes out as soon as it is known to be content', () => {
    const h = ko()
    expect(h.push('Let me ' + 'a'.repeat(143))).toBe('')
    expect(h.push('b'.repeat(60))).toBe('Let me ' + 'a'.repeat(143) + 'b'.repeat(60))
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
/** the fake engine's directives, their Latin letters written as \\u escapes: the message itself then quotes no English
 * (a quote of 3+ English words turns the hold off, narrationScript) */
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/[A-Za-z]/g, (c) => '\\u00' + c.charCodeAt(0).toString(16)))).join('\n')

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

  test.skipIf(!native)('Korean, ending on a tool call: the dropped line does not come back as the whole text', async () => {
    const t = await turn('ko', '파일 확인해줘\n' + fake({ say: 'Let me check the file.' }, { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } }))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).not.toContain('Let me check')
  })

  test.skipIf(!native)('Korean with a sub-agent: its calls do not decide the main line; the answer is the main text only', async () => {
    const t = await turn('ko', '두 폴더 확인해줘\n' + fake(
      { say: 'Let me split this up.' },
      { agents: [{ id: 'a1', type: 'general-purpose', description: 'look', steps: [{ say: 'Child text.' }, { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } }] }] },
      { say: '두 폴더 다 확인했어요.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).toBe('두 폴더 다 확인했어요.')
  })

  test.skipIf(!native)('Korean, stopped with a status line held: it is dropped; the stream and the saved answer agree', async () => {
    h.ctx.db.query('UPDATE users SET locale = ? WHERE id = ?').run('ko', 'alice')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: '파일 확인해줘\n' + fake({ say: '먼저 볼게요.' }, { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } }, { say: 'Let me check one more.' }, { sleep: 20_000 }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const id = started.assistantMessage.id
    await waitFor(() => published.find((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id && p.ev.data.text.includes('먼저')), { timeoutMs: 20_000, what: 'first text' })
    await Bun.sleep(500)
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    const doneEv = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 30_000, what: 'message.done' })
    let streamed = ''
    for (const d of published.filter((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id).map((p) => p.ev.data)) streamed += d.text
    const stored = (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(id) as { content: string }).content
    expect(stored).toBe('먼저 볼게요.')
    expect(streamed).toBe(stored)
    expect(doneEv!.ev.data.message.content).toBe(stored)
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
