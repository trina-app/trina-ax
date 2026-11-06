// scripts/demo/company/record.ts: a recorded answer is read from Claude Code's own transcript of the turn (the session
// file the server keeps), never written by hand: text blocks and tool calls in order with their time since the start,
// team tools without their results (they are called again on replay), the engine's own tools with what they answered. A
// run with a sub-agent or a question from the AI is refused. The recordings of the open example (and of the content
// MYCEL_DEMO_CONTENT names, when set) are recordings of their scenarios, in the team's language.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { TEAM_TOOL_PREFIX } from '@mycel/shared'
import { DemoRecording } from '@mycel/shared/api'
import { CONTENT_ENV, DEFAULT_CONTENT, loadContent } from '../../scripts/demo/company/content'
import { recordedTitle } from '../../scripts/demo/company/history'
import { transcriptEvents } from '../../scripts/demo/company/record'

const T = TEAM_TOOL_PREFIX
const line = (o: object) => JSON.stringify(o)
const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 1, 0, s)).toISOString()
const transcript = (extra: string[] = []) => [
  line({ type: 'user', timestamp: at(0), message: { role: 'user', content: '카드뉴스 만들어 줘' } }),
  line({ type: 'assistant', timestamp: at(2), message: { model: 'claude-x', content: [{ type: 'text', text: '읽어 볼게요.' }, { type: 'tool_use', id: 'u1', name: `${T}read`, input: { file_path: 'a.md' } }] } }),
  line({ type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'secret file text' }] }] } }),
  line({ type: 'assistant', timestamp: at(4), message: { content: [{ type: 'tool_use', id: 'u2', name: 'TodoWrite', input: { todos: [] } }] } }),
  line({ type: 'user', timestamp: at(5), message: { content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'Todos updated', is_error: false }] } }),
  ...extra,
  line({ type: 'assistant', timestamp: at(9), message: { content: [{ type: 'text', text: '다 만들었어요.' }] } }),
].join('\n')

describe('reading a transcript', () => {
  test('text and tool calls in order, times from the start; team results left out, the engine\'s kept', () => {
    const r = transcriptEvents(transcript())
    if ('problem' in r) throw new Error(r.problem)
    expect(r.model).toBe('claude-x')
    expect(r.events).toEqual([
      { type: 'text', t: 2000, text: '읽어 볼게요.' },
      { type: 'tool', t: 2000, name: `${T}read`, input: { file_path: 'a.md' }, ok: true, ms: 1000 },
      { type: 'tool', t: 4000, name: 'TodoWrite', input: { todos: [] }, ok: true, ms: 1000, output: 'Todos updated' },
      { type: 'text', t: 9000, text: '다 만들었어요.' },
    ])
    expect(JSON.stringify(r.events)).not.toContain('secret file text')
  })

  test('a sub-agent or a question from the AI is no recording', () => {
    expect(transcriptEvents(transcript([line({ type: 'assistant', isSidechain: true, timestamp: at(6), message: { content: [] } })]))).toEqual({ problem: 'the run used a sub-agent' })
    expect(transcriptEvents(transcript([line({ type: 'assistant', timestamp: at(6), message: { content: [{ type: 'tool_use', id: 'u3', name: 'Agent', input: {} }] } })]))).toEqual({ problem: 'the run used a sub-agent' })
    expect(transcriptEvents(transcript([line({ type: 'assistant', timestamp: at(6), message: { content: [{ type: 'tool_use', id: 'u3', name: `${T}ask_user`, input: {} }] } })]))).toEqual({ problem: 'the AI asked a question' })
  })
})

const CONTENTS = [DEFAULT_CONTENT, ...(process.env[CONTENT_ENV] ? [path.resolve(process.env[CONTENT_ENV]!)] : [])]
for (const dir of CONTENTS) {
  describe(`the recordings of ${path.basename(dir)}`, () => {
    const c = loadContent(dir)
    const files = fs.existsSync(c.recordingsDir) ? fs.readdirSync(c.recordingsDir).filter((n) => n.endsWith('.json')) : []
    test('there are some, and each is a recording of its scenario, by its person, from a real engine', () => {
      if (dir === DEFAULT_CONTENT) expect(files.length).toBe(c.company.scenarios.length)
      for (const n of files) {
        const r = DemoRecording.parse(JSON.parse(fs.readFileSync(path.join(c.recordingsDir, n), 'utf8')))
        const s = c.company.scenarios.find((x) => `${x.slug}.json` === n)
        expect(s, n).toBeDefined()
        expect([r.username, r.prompt, r.kind], n).toEqual([s!.username, s!.prompt, s!.kind])
        expect(r.engine).toBe('claude-code')
        expect(r.model, n).toMatch(/^claude-/)
        expect(r.events.some((e) => e.type === 'text'), n).toBe(true)
        // never a sub-agent; a past chat names itself so the seed can tell it is there
        expect(r.events.some((e) => e.type === 'tool' && ['Agent', 'Task'].includes(e.name)), n).toBe(false)
        if (r.kind === 'history') expect(recordedTitle(r), n).toBeTruthy()
        // every visible line is in the team's language: no English narration in a Korean company's answer ("Let me
        // view the images."), no Korean in an English one
        for (const e of r.events) {
          if (e.type !== 'text') continue
          const hangul = (e.text.match(/[가-힣]/g) ?? []).length
          const latin = (e.text.replace(/\(\/files\/view[^)]*\)/g, '').match(/[A-Za-z]/g) ?? []).length
          if (c.company.locale === 'ko') expect(hangul >= 5 && latin <= hangul, `${n}: ${e.text.slice(0, 60)}`).toBe(true)
          if (c.company.locale === 'en') expect(hangul === 0 && latin >= 5, `${n}: ${e.text.slice(0, 60)}`).toBe(true)
        }
      }
    })
  })
}
