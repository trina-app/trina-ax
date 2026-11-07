// Every built-in tool's step under an answer has words in the five languages, never the raw tool name (QA 0.2.12 B5:
// hwp_render and schedule_create showed as "hwp_render" / "schedule_create"). The web app redraws a stored label in the
// language on screen (localizeStep), so an answer run in Korean reads in English after a switch.
import { describe, expect, test } from 'bun:test'
import { FILE_TOOLS, FILE_STEP_VERB, localizeStep, placeName, stepLabel, stepPlace } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { C_TOOL_NAMES } from '../../server/src/tools/index'
import { FILE_MOVE_TOOL_NAMES } from '../../server/src/tools/file-moves'
import { SCHEDULE_TOOL_NAMES } from '../../server/src/tools/schedules'
import { DRIVE_TOOL_NAMES } from '../../server/src/tools/drive'
import { ROOM_READ_TOOL_NAMES } from '../../server/src/chat/room-tools'

const LOCALES: Locale[] = ['ko', 'en', 'id', 'ja', 'es']
const NONE = new Set<string>()
// set_title has no step (the new title shows in the sidebar); connected services label their own tools
const TOOLS = [...Object.keys(FILE_TOOLS), ...C_TOOL_NAMES, ...FILE_MOVE_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...DRIVE_TOOL_NAMES, ...ROOM_READ_TOOL_NAMES, 'save_room_file', 'search', 'generate_video', 'promo_video', 'intro_deck', 'ask_user', 'remember', 'forget', 'skill', 'find_skills', 'find_tools', 'connect_service']
const INPUT: Record<string, Record<string, unknown>> = {
  hwp_render: { source: 'qa-hwp/report.hwpx', page: 2, format: 'png' },
  schedule_create: { title: 'Weekly digest', prompt: 'x', repeat: 'weekly', time: '09:00', weekday: 1 },
  schedule_delete: { id: 'sch-1' },
  search: { query: '견적 회신', path: 'shared' },
  drive_search: { query: 'budget' },
  drive_list: { folderId: '1AbC' },
  drive_read: { fileId: '1XyZ' },
  generate_video: { prompt: 'a cat on a sofa' },
  promo_video: { title: 'Acme promo video' },
  intro_deck: { title: 'Acme 회사 소개서' },
  skill: { name: '견적서 작성' },
  find_skills: { query: '견적' },
  find_tools: { query: 'upscale video' },
  rooms: { query: '예산' },
  room_read: { room: '마케팅' },
  room_file: { room: '마케팅', file: '보고서.pdf' },
  connect_service: { name: 'Higgsfield', kind: 'mcp', url: 'https://mcp.higgsfield.ai/mcp', auth: 'oauth' },
}

describe('step labels of the built-in tools', () => {
  test('every tool has words in all five languages (never its raw name)', () => {
    for (const tool of TOOLS) {
      expect(FILE_STEP_VERB[tool], tool).toBeDefined()
      for (const L of LOCALES) {
        expect(FILE_STEP_VERB[tool]![L]?.length, `${tool} ${L}`).toBeGreaterThan(0)
        expect(stepLabel(tool, INPUT[tool] ?? {}, L, NONE).startsWith(tool), `${tool} ${L}`).toBe(false)
      }
    }
  })

  test('team chat rooms: the room as named, the words searched, never an id; in every language', () => {
    expect(stepLabel('room_read', INPUT.room_read, 'ko', NONE)).toBe('대화방 읽기 · 마케팅')
    expect(stepLabel('rooms', {}, 'ko', NONE)).toBe('대화방 찾기')
    expect(stepLabel('rooms', INPUT.rooms, 'ko', NONE)).toBe('대화방 찾기 "예산"')
    expect(stepLabel('rooms', { person: '김민지' }, 'en', NONE)).toBe('Find in conversations · 김민지')
    expect(stepLabel('room_file', INPUT.room_file, 'ja', NONE)).toBe('トークルームのファイルを読む · 보고서.pdf')
    // an id the AI passed is not shown (the server names the room once found); a "#" token by its title
    expect(stepLabel('room_read', { room: '0195f3c2-8a3e-7b1c-9d2e-123456789abc' }, 'en', NONE)).toBe('Read conversation')
    expect(stepLabel('room_read', { room: '#[주간 회의](room:0195f3c2-8a3e-7b1c-9d2e-123456789abc)' }, 'es', NONE)).toBe('Leer sala de chat · 주간 회의')
    for (const [L, want] of [['en', 'Read conversation · 마케팅'], ['id', 'Baca ruang obrolan · 마케팅'], ['ja', 'トークルームを読む · 마케팅'], ['es', 'Leer sala de chat · 마케팅']] as const)
      expect(localizeStep({ kind: 'tool', tool: 'room_read', label: '대화방 읽기 · 마케팅' }, L).label).toBe(want)
    expect(localizeStep({ kind: 'tool', tool: 'room_file', label: 'Read conversation file · 보고서.pdf' }, 'ko').label).toBe('대화방 파일 읽기 · 보고서.pdf')
  })

  test('skills: the skill loaded, the words searched', () => {
    expect(stepLabel('skill', INPUT.skill, 'ko', NONE)).toBe('스킬 사용 · 견적서 작성')
    expect(stepLabel('find_skills', INPUT.find_skills, 'en', NONE)).toBe('Find skills "견적"')
    expect(localizeStep({ kind: 'tool', tool: 'skill', label: '스킬 사용 · 견적서 작성' }, 'en').label).toBe('Use skill · 견적서 작성')
    // connected services' tools to look up: the words searched (call_tool's step is the tool's own label)
    expect(stepLabel('find_tools', INPUT.find_tools, 'ko', NONE)).toBe('도구 찾기 "upscale video"')
    expect(localizeStep({ kind: 'tool', tool: 'find_tools', label: '도구 찾기 "upscale video"' }, 'ja').label).toBe('ツールを探す "upscale video"')
  })

  test('the new ones: words, then what the AI touched', () => {
    expect(stepLabel('hwp_render', INPUT.hwp_render, 'ko', NONE)).toBe('한글 문서 쪽 보기 · qa-hwp/report.hwpx #2')
    expect(stepLabel('hwp_render', INPUT.hwp_render, 'en', NONE)).toBe('View HWP page · qa-hwp/report.hwpx #2')
    expect(stepLabel('schedule_create', INPUT.schedule_create, 'ko', NONE)).toBe('예약 작업 만들기 · Weekly digest')
    expect(stepLabel('schedule_create', INPUT.schedule_create, 'ja', NONE)).toBe('定期タスクを作成 · Weekly digest')
    expect(stepLabel('schedule_list', {}, 'es', NONE)).toBe('Listar tareas programadas')
    expect(stepLabel('schedule_delete', INPUT.schedule_delete, 'id', NONE)).toBe('Hapus tugas terjadwal · sch-1')
    expect(stepLabel('search', INPUT.search, 'en', NONE)).toBe('Search by meaning "견적 회신" · shared')
    expect(stepLabel('drive_list', {}, 'en', NONE)).toBe('List Google Drive folder')
    expect(stepLabel('drive_list', INPUT.drive_list, 'en', NONE)).toBe('List Google Drive folder · 1AbC')
  })

  test('a stored label follows the language on screen', () => {
    for (const tool of ['hwp_render', 'schedule_create', 'schedule_list', 'search', 'drive_read', 'generate_video']) {
      const ko = stepLabel(tool, INPUT[tool] ?? {}, 'ko', NONE)
      for (const L of LOCALES) expect(localizeStep({ kind: 'tool', tool, label: ko }, L).label).toBe(stepLabel(tool, INPUT[tool] ?? {}, L, NONE))
    }
  })
})

describe('team folders in words on screen (docs/DECISIONS.md "W2")', () => {
  const shown = (tool: string, label: string, L: Locale) => stepPlace({ tool }, localizeStep({ kind: 'tool', tool, label }, L).label, L)
  test('the brand images folder, the brand folder, the meeting notes folder, the team\'s folder; the path for the tooltip', () => {
    expect(shown('read', '파일 읽기 · groups/Acme/브랜드/이미지/홈페이지-6.jpg', 'ko')).toEqual({ label: '파일 읽기 · 브랜드 이미지 폴더 › 홈페이지-6.jpg', path: 'groups/Acme/브랜드/이미지/홈페이지-6.jpg' })
    expect(shown('read', '파일 읽기 · groups/Acme/브랜드/회사 소개.md', 'ko').label).toBe('파일 읽기 · 브랜드 폴더 › 회사 소개.md')
    expect(shown('list', '폴더 보기 · groups/Acme/브랜드/이미지', 'ko').label).toBe('폴더 보기 · 브랜드 이미지 폴더')
    expect(shown('read', 'Read · groups/Acme/회의록/2026/11-05.md', 'en').label).toBe('Read · Meeting notes folder › 2026 › 11-05.md')
    expect(shown('write', '파일 저장 · groups/Acme 2/plan.md', 'ko').label).toBe('파일 저장 · Acme 2 폴더 › plan.md')
    // an English team's folders, a Korean screen: the names match in any language and are said in the screen's
    expect(shown('read', 'Read · groups/Acme/Brand/Images/hero.png', 'ko').label).toBe('파일 읽기 · 브랜드 이미지 폴더 › hero.png')
    expect(shown('read', 'Read · groups/Acme/Brand/Images/hero.png', 'ja').label).toBe('読み取り · ブランド画像フォルダー › hero.png')
    // macOS writes Hangul decomposed: still the brand folder
    expect(shown('read', `Read · groups/Acme/${'브랜드'.normalize('NFD')}/a.md`, 'en').label).toBe('Read · Brand folder › a.md')
  })

  test('the person\'s own folder, their attachments, the shared folder; edit_files keeps "+N", search its words', () => {
    expect(shown('read', 'Read · users/0192f/.attachments/0193a/견적서.pdf', 'ko').label).toBe('파일 읽기 · 첨부한 파일 › 견적서.pdf')
    expect(shown('write', 'Save · users/0192f/drafts/plan.md', 'es').label).toBe('Guardar · Mi carpeta › drafts › plan.md')
    expect(shown('read', 'Read · shared/fruit.md', 'id').label).toBe('Baca berkas · Folder bersama › fruit.md')
    expect(shown('edit_files', 'Edit files · shared/a.md +29', 'en')).toEqual({ label: 'Edit files · Shared folder › a.md +29', path: 'shared/a.md' })
    expect(shown('hwp_render', 'View HWP page · groups/Acme/brief.hwpx #2', 'en').label).toBe('View HWP page · Acme folder › brief.hwpx #2')
    expect(shown('grep', 'Search "fee · 2%" · shared/', 'en').label).toBe('Search "fee · 2%" · Shared folder')
  })

  test('anything else stays as it is, without a path', () => {
    for (const [tool, label] of [
      ['read', 'Read · marketing/plan.md'], ['read', 'Read · groups'], ['list', 'List · /'], ['save_url', 'Download file · https://acme.example/shared/a.pdf'],
      ['skill', 'Use skill · shared/notes'], ['artifact', 'Artifact · groups/Acme/x'], ['read', 'Read'], ['read', 'Read · shared//a.md'],
    ] as const) expect(stepPlace({ tool }, label, 'en')).toEqual({ label })
    expect(stepPlace({}, 'Thinking', 'en')).toEqual({ label: 'Thinking' })
    expect(placeName('https://acme.example/a', 'en')).toBeNull()
  })
})

describe('connect_service steps', () => {
  test('the service by name (Google Drive for the Drive card, nothing that looks like a key), and the outcome in every language', () => {
    expect(stepLabel('connect_service', INPUT.connect_service, 'en', NONE)).toBe('Connect service · Higgsfield')
    expect(stepLabel('connect_service', { target: 'google_drive', name: 'my drive' }, 'ko', NONE)).toBe('서비스 연결 · Google Drive')
    expect(stepLabel('connect_service', { name: 'Linear sk-live-4f9a8b7c6d5e4f3a2b1c' }, 'en', NONE).includes('sk-live')).toBe(false)
    // no name, an empty one, one that is not text or only characters that show nothing: the verb alone
    for (const input of [{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: { x: 1 } }, { name: '\u200b\u202e\u{E0041}' }])
      expect(stepLabel('connect_service', input, 'en', NONE)).toBe('Connect service')
    expect(localizeStep({ kind: 'tool', tool: 'connect_service', label: 'Connect service' }, 'ko').label).toBe('서비스 연결')
    // hidden characters leave the label; emoji stay whole
    expect(stepLabel('connect_service', { name: 'Tas\u200bks\u202e' }, 'en', NONE)).toBe('Connect service · Tasks')
    expect(stepLabel('connect_service', { name: '👩‍💻 Dev' }, 'en', NONE)).toBe('Connect service · 👩‍💻 Dev')
    const ko = stepLabel('connect_service', INPUT.connect_service, 'ko', NONE)
    expect(localizeStep({ kind: 'tool', tool: 'connect_service', label: ko, detail: '연결됨' }, 'en')).toEqual({ label: 'Connect service · Higgsfield', detail: 'Connected' })
    expect(localizeStep({ kind: 'tool', tool: 'connect_service', label: ko, detail: 'Not connected' }, 'ja').detail).toBe('未接続')
    // other tools' details keep their words ("Connected" is only this step's outcome)
    expect(localizeStep({ kind: 'tool', tool: 'read', label: 'Read · a.md', detail: 'Connected' }, 'ko').detail).toBe('Connected')
  })
})

describe('engine steps saved with the Korean wording before 0.2.16 (합니다체)', () => {
  test('still follow the language on screen', () => {
    expect(localizeStep({ kind: 'tool', tool: 'refusal', label: 'AI가 답하지 않아 다른 모델(claude-opus)로 다시 답합니다' }, 'en').label)
      .toBe('The AI declined; answering again with another model (claude-opus)')
    expect(localizeStep({ kind: 'tool', tool: 'engine', label: 'Codex 사용 한도에 닿아 Claude 엔진으로 이어서 답합니다' }, 'ko').label)
      .toBe('Codex 사용 한도에 닿아 Claude 엔진으로 이어서 답해요')
    expect(localizeStep({ kind: 'tool', tool: 'engine', label: 'AI 연결이 거절되어 다른 연결로 이어서 답합니다' }, 'ja').label)
      .toBe(localizeStep({ kind: 'tool', tool: 'engine', label: 'AI 연결이 거절되어 다른 연결로 이어서 답해요' }, 'ja').label)
  })
})
