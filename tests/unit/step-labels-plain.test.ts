// Step lines in plain words (shared/src/step-labels.ts, docs/DECISIONS.md "Plain words in errors, cards and steps"): a
// tool without words of its own reads as its id in words, never snake_case; no raw ids or the AI's arguments, no engine
// names or model ids, no English " (job)" in other languages; and steps saved with the earlier words still follow the
// language on screen, in today's words.
import { describe, expect, test } from 'bun:test'
import { BROWSER_STEP_VERB, localizeStep, readableToolName, STEP_TEXT, stepLabel, stepText } from '../../shared/src'

const BROWSER_TOOL_NAMES = Object.keys(BROWSER_STEP_VERB)

const L = ['ko', 'en', 'id', 'ja', 'es'] as const
const label = (tool: string, input: unknown, l: (typeof L)[number] = 'en') => stepLabel(tool, input, l, new Set(BROWSER_TOOL_NAMES))

describe('new steps', () => {
  test('a tool without words of its own: its id in words, never snake_case', () => {
    expect(label('create_task', {})).toBe('Create task')
    expect(label('TodoWrite', {})).toBe('Todo write')
    expect(label('mcp__notion__create_page', {})).toBe('Create page')
    expect(label('__', {}, 'ko')).toBe('작업')
    expect(readableToolName('get_PDF_text')).toBe('Get PDF text')
    expect(readableToolName('HTMLParserTool')).toBe('HTML parser tool')
    // the AI's own text (call_tool's name before its check) takes no time, however long: cut first, linear patterns
    const t0 = performance.now()
    readableToolName('A'.repeat(40_000) + 'b')
    readableToolName('aA'.repeat(40_000))
    expect(performance.now() - t0).toBeLessThan(200)
  })

  test('no raw ids: a schedule, a Drive file or folder by the words alone', () => {
    const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    expect(label('schedule_delete', { id })).toBe('Delete scheduled task')
    expect(label('drive_read', { fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz' })).toBe('Read Google Drive file')
    expect(label('drive_list', { folderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz' })).toBe('List Google Drive folder')
  })

  test('plain verbs for the page and file-map steps', () => {
    expect(label('artifact', { title: 'Sales chart' }, 'ko')).toBe('화면 만들기 · Sales chart')
    expect(label('knowledge_explore', { query: 'invoice' }, 'ko')).toBe('자료 지도에서 찾기 "invoice"')
    expect(label('read_console_messages', {}, 'ko')).toBe('페이지 오류 보기')
    expect(label('read_network_requests', {}, 'ko')).toBe('페이지 통신 보기')
    expect(label('javascript_tool', {}, 'ko')).toBe('페이지에서 동작 실행')
    expect(label('find_tools', { query: 'calendar' }, 'ko')).toBe('쓸 수 있는 기능 찾기 "calendar"')
  })

  test('a dev-environment job or background command says so in the language on screen', () => {
    for (const l of L) {
      expect(label('box_shell', { command: 'npm run build', job: true }, l)).toBe(`${label('box_shell', { command: 'npm run build' }, l)} (${STEP_TEXT.jobSuffix[l]})`)
      expect(label('box_shell', { command: 'npm run dev', background: true }, l)).toEndWith(` (${STEP_TEXT.backgroundSuffix[l]})`)
    }
    expect(label('box_shell', { command: 'x', job: true }, 'ko')).not.toContain('(job)')
  })

  test('no engine names or model ids in the switch lines', () => {
    for (const l of L) {
      for (const key of ['refusedRetry', 'engineOffDefault', 'engineNoConnection', 'limitFallback', 'credentialSwitchLimit', 'credentialSwitchInvalid'] as const) {
        const text = stepText(key, l, { model: 'claude-opus-4-1-20250805', from: 'Claude Code', to: 'Codex' })
        for (const word of ['claude-opus', 'Claude Code', 'Codex', '{', '엔진', 'model ', 'mesin', 'motor']) expect([l, key, text.includes(word)]).toEqual([l, key, false])
      }
    }
    expect(stepText('refusedRetry', 'ko', { model: 'x' })).toBe('AI가 답하지 않아 다른 AI로 다시 답해요')
  })
})

describe('steps saved with the earlier words', () => {
  test('an engine switch with a model id or engine names reads in today\'s words, in the language on screen', () => {
    const cases: [string, string][] = [
      ['AI가 답하지 않아 다른 모델(claude-opus-4)로 다시 답해요', 'refusal'],
      ['AI가 답하지 않아 다른 모델(claude-opus-4)로 다시 답합니다', 'refusal'],
      ['The AI declined; answering again with another model (gpt-5)', 'refusal'],
      ['Claude Code 엔진이 꺼져 있어 팀 기본 엔진(Codex)으로 답해요', 'engine'],
      ['Claude Code is switched off; answering with the team default (Codex)', 'engine'],
      ['Codex에 쓸 AI 연결이 없어 연결된 Claude Code로 답해요', 'engine'],
      ['Claude Code usage limit reached; continuing with Codex', 'engine'],
      ['AI 연결이 거절되어 다른 연결로 이어서 답해요', 'engine'],
    ]
    for (const [old, tool] of cases) for (const l of L) {
      const now = localizeStep({ kind: 'tool', tool, label: old }, l).label
      expect([old, l, /claude-opus|gpt-5|Claude Code|Codex|엔진|engine/.test(now)]).toEqual([old, l, false])
    }
    expect(localizeStep({ kind: 'tool', tool: 'refusal', label: 'The AI declined; answering again with another model (gpt-5)' }, 'ko').label).toBe('AI가 답하지 않아 다른 AI로 다시 답해요')
  })

  test('an earlier verb is said with today\'s, the rest kept; an English " (job)" in the language on screen', () => {
    expect(localizeStep({ kind: 'tool', tool: 'artifact', label: '아티팩트 · Sales chart' }, 'en').label).toBe('Make a page · Sales chart')
    expect(localizeStep({ kind: 'tool', tool: 'knowledge_explore', label: 'Search knowledge graph "invoice"' }, 'ko').label).toBe('자료 지도에서 찾기 "invoice"')
    expect(localizeStep({ kind: 'browser', tool: 'read_console_messages', label: '콘솔 보기' }, 'en', new Set(BROWSER_TOOL_NAMES)).label).toBe('Check page errors')
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: '개발 환경 명령 · npm run build (job)' }, 'ko').label).toBe(`개발 환경 명령 · npm run build (${STEP_TEXT.jobSuffix.ko})`)
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: 'Dev environment command · npm run dev (background)' }, 'ja').label).toBe(`開発環境のコマンド · npm run dev (${STEP_TEXT.backgroundSuffix.ja})`)
  })
})
