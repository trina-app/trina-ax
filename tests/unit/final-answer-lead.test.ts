// A final answer's English lead: the AI's working notes in Latin letters above a Korean, Japanese or Chinese answer
// leave the answer as a thinking step (server/src/chat/narration.ts finalAnswerLead, chat/turn.ts dropFinalLead,
// docs/decisions/20261122-final-answer-english-lead.md).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { finalAnswerLead, leadScript } from '../../server/src/chat/narration'

setDefaultTimeout(60_000)

const KO_ANSWER = '보고서를 만들어 팀 폴더에 저장했어요.\n\n- 표 3개\n- 그림 2장'
/** what is left of the answer (the answer itself when nothing leads) */
const left = (answer: string, msg = '보고서 만들어 줘', locale: 'ko' | 'ja' | 'zh' | 'en' = 'ko') =>
  finalAnswerLead(answer, leadScript(locale, msg), msg)?.rest ?? answer

describe('finalAnswerLead', () => {
  test("today's leaked lines above a Korean answer leave it", () => {
    for (const line of [
      'Need a venv.', "Chromium didn't produce PNGs; use make_file instead.", 'Install python-docx in a venv.',
      'Good result. Saving it.', 'Quick check of the result.',
    ]) {
      const cut = finalAnswerLead(`${line}\n\n${KO_ANSWER}`, 'ko', '보고서 만들어 줘')
      expect(cut, line).not.toBeNull()
      expect(cut!.notes).toBe(line)
      expect(cut!.rest).toBe(KO_ANSWER)
    }
    // several in a row, all of them
    expect(finalAnswerLead(`Need a venv.\n\nGood result. Saving it.\n\n${KO_ANSWER}`, 'ko')).toEqual({ notes: 'Need a venv.\n\nGood result. Saving it.', rest: KO_ANSWER })
    // Japanese and Chinese answers too
    expect(left('Quick check of the result.\n\n報告書を保存しました。', '報告書を作って', 'ja')).toBe('報告書を保存しました。')
    expect(left('Quick check of the result.\n\n报告已保存。', '请做一份报告', 'zh')).toBe('报告已保存。')
  })

  test('a Korean answer opening with an English product name or title in the same paragraph stays', () => {
    for (const a of [
      'Trina AX\n트리나는 팀 파일을 한곳에서 관리하는 앱이에요.',
      'Q3 Sales Report — 3분기 매출 보고서를 정리했어요.',
      'Notion 대신 Trina AX를 쓰면 이렇게 달라져요.',
    ]) expect(left(a), a).toBe(a)
  })

  test('content shapes stay: code, a link, a quote, a list item, a table row, a heading, a file name alone', () => {
    for (const lead of [
      '```\npip install python-docx\n```', 'https://example.com/report', '> Need a venv.', '- Need a venv.', '1. Install it.',
      '| Name | Price |', '## Summary', '**Summary**', 'report-q3.docx', '`report-q3.docx`', 'Hi Tom,',
    ]) expect(left(`${lead}\n\n${KO_ANSWER}`), lead).toBe(`${lead}\n\n${KO_ANSWER}`)
    // inline code, a command's or a query's symbols, a title or a total with no sentence mark (review)
    for (const lead of ['`pip install -r requirements.txt`', 'SELECT * FROM users;', 'python3 -m venv .venv --clear.', 'Seamless Onboarding', 'Total: USD 1,234', '*Note*'])
      expect(left(`${lead}\n\n${KO_ANSWER}`), lead).toBe(`${lead}\n\n${KO_ANSWER}`)
    // a long paragraph is content too
    const long = 'This paragraph is long enough to be real content rather than a short note that the model wrote to itself while it worked through all of the many steps of the whole job.'
    expect(long.length).toBeGreaterThanOrEqual(160)
    expect(left(`${long}\n\n${KO_ANSWER}`)).toBe(`${long}\n\n${KO_ANSWER}`)
  })

  test('code-first answers are unchanged', () => {
    for (const a of ['```python\nprint(1)\n```\n\n이 코드를 실행하면 1이 나와요.', '    pip install python-docx\n\n설치 명령이에요.']) expect(left(a), a).toBe(a)
  })

  test('never empties the answer, and an English answer stays whole', () => {
    expect(left('Need a venv.')).toBe('Need a venv.')
    expect(left('Need a venv.\n\nGood result. Saving it.')).toBe('Need a venv.\n\nGood result. Saving it.')
    expect(left('Need a venv.\n\nDear Mr. Smith, thank you for your order.')).toBe('Need a venv.\n\nDear Mr. Smith, thank you for your order.')
  })

  test('the person asks for English, writes in English, or the app is in a Latin language: unchanged', () => {
    const a = `Need a venv.\n\n${KO_ANSWER}`
    for (const msg of ['영어로 써줘', '보고서 in English please', '英語で書いて', '用英文写', 'Write the report and save it in the team folder']) {
      expect(leadScript('ko', msg), msg).toBeNull()
      expect(left(a, msg), msg).toBe(a)
    }
    expect(leadScript('en', '보고서 만들어 줘')).toBeNull()
    expect(left(a, '보고서 만들어 줘', 'en')).toBe(a)
    // a follow-up to a request for an English draft ("영어 이메일 써줘", then "좀 더 짧게"): the draft stays (review)
    expect(leadScript('ko', '좀 더 짧게 해줘', '거래처에 보낼 영어 이메일 써줘')).toBeNull()
    expect(leadScript('ko', '좀 더 짧게 해줘', '보고서 만들어 줘')).toBe('ko')
    // a quote above the person's own words does not decide (#364): its English is someone else's
    expect(leadScript('ko', '> Please send the final deck by Friday, thanks a lot everyone\n이거 요약해줘')).toBe('ko')
  })

  test("a paragraph taken from the person's message is content", () => {
    expect(left('Need a venv please.\n\n알겠어요, 가상환경을 만들게요.', '"Need a venv please." 이 문장 그대로 앞에 써줘')).toBe('Need a venv please.\n\n알겠어요, 가상환경을 만들게요.')
  })
})

const GATE = path.join(import.meta.dir, '../../native/bin', `${process.platform}-${process.arch}`, 'mycel-gate')
const native = fs.existsSync(GATE)
/** the fake engine's directives, their Latin letters written as \\u escapes (narration-hold.test.ts) */
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/(?<!\\)[A-Za-z]/g, (c) => '\\u00' + c.charCodeAt(0).toString(16)))).join('\n')

describe('a turn whose final answer opens with an English working note', () => {
  let h: Harness
  const published: { userId: string; ev: any }[] = []
  beforeAll(async () => {
    h = await startHarness({ name: 'final-answer-lead' })
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
    let streamed = ''
    for (const d of published.filter((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id).map((p) => p.ev.data)) streamed = d.reset ? streamed.slice(0, d.offset) : streamed + d.text
    const row = h.ctx.db.query('SELECT content, steps FROM messages WHERE id = ?').get(id) as { content: string; steps: string | null }
    return { streamed, stored: row.content, steps: row.steps ?? '', done: doneEv!.ev.data.message.content as string }
  }

  test.skipIf(!native)('Korean: the note after the last call leaves the answer, streamed and saved, and is kept as a step', async () => {
    const t = await turn('ko', '보고서 파일을 만들어서 결과를 알려 주세요\n' + fake(
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: 'Good result. Saving it.\n\n보고서를 만들었어요.' },
    ))
    expect(t.stored).toBe('보고서를 만들었어요.')
    expect(t.streamed).toBe(t.stored)
    expect(t.done).toBe(t.stored)
    expect(t.steps).toContain('Good result. Saving it.')
  })

  test.skipIf(!native)('Korean, "영어로 써줘": an English answer stays', async () => {
    const t = await turn('ko', '영어로 써줘 보고서 결과를 알려 주세요\n' + fake({ say: 'Need a venv.\n\n보고서를 만들었어요.' }))
    expect(t.stored).toBe('Need a venv.\n\n보고서를 만들었어요.')
  })

  test.skipIf(!native)('English app: unchanged', async () => {
    const t = await turn('en', '보고서 파일을 만들어서 결과를 알려 주세요\n' + fake({ say: 'Need a venv.\n\n보고서를 만들었어요.' }))
    expect(t.stored).toBe('Need a venv.\n\n보고서를 만들었어요.')
  })
})
