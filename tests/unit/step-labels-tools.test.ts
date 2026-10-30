// Every built-in tool's step under an answer has words in the five languages, never the raw tool name (QA 0.2.12 B5:
// hwp_render and schedule_create showed as "hwp_render" / "schedule_create"). The web app redraws a stored label in the
// language on screen (localizeStep), so an answer run in Korean reads in English after a switch.
import { describe, expect, test } from 'bun:test'
import { FILE_TOOLS, FILE_STEP_VERB, localizeStep, stepLabel } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { C_TOOL_NAMES } from '../../server/src/tools/index'
import { FILE_MOVE_TOOL_NAMES } from '../../server/src/tools/file-moves'
import { SCHEDULE_TOOL_NAMES } from '../../server/src/tools/schedules'
import { DRIVE_TOOL_NAMES } from '../../server/src/tools/drive'

const LOCALES: Locale[] = ['ko', 'en', 'id', 'ja', 'es']
const NONE = new Set<string>()
// set_title has no step (the new title shows in the sidebar); connected services label their own tools
const TOOLS = [...Object.keys(FILE_TOOLS), ...C_TOOL_NAMES, ...FILE_MOVE_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...DRIVE_TOOL_NAMES, 'search', 'generate_video', 'ask_user', 'remember', 'forget']
const INPUT: Record<string, Record<string, unknown>> = {
  hwp_render: { source: 'qa-hwp/report.hwpx', page: 2, format: 'png' },
  schedule_create: { title: 'Weekly digest', prompt: 'x', repeat: 'weekly', time: '09:00', weekday: 1 },
  schedule_delete: { id: 'sch-1' },
  search: { query: '견적 회신', path: 'shared' },
  drive_search: { query: 'budget' },
  drive_list: { folderId: '1AbC' },
  drive_read: { fileId: '1XyZ' },
  generate_video: { prompt: 'a cat on a sofa' },
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
