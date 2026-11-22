// QA TC-8037: Admin › System said backups are kept 3 days (Plan part: the plan's localBackupRetentionDays) and 14 days
// (Backups part: a fixed string). The server keeps them backupRetentionDays() days (system/limits.ts: the plan's
// value, else 14); GET /api/admin/backups now answers that number, and the Backups card says it in every language.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Plan, backupRetentionDays, setPlanForTests } from '../../server/src/system/limits'
import { DICTS, format, loadLocale } from '../../web/src/i18n'
import { harness, withOwner, type Client, type Harness } from './a-lib'

const LOCALES = ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const

afterEach(() => setPlanForTests(undefined))

describe('GET /api/admin/backups: the days this server keeps its backups', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('g-backup-retention'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('no plan: 14; a hosted plan of 3 days: 3, the same number as the Plan part', async () => {
    expect((await owner.call('GET', '/api/admin/backups')).retentionDays).toBe(14)
    setPlanForTests(Plan.parse({ format: 1, plan: 'trial', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 2, diskGiB: 20, localBackupRetentionDays: 3 }))
    expect(backupRetentionDays()).toBe(3)
    expect((await owner.call('GET', '/api/admin/backups')).retentionDays).toBe(3)
    expect((await owner.call('GET', '/api/admin/plan')).plan.localBackupRetentionDays).toBe(3)
    // a plan without the field: the server keeps 14, and both parts say 14
    setPlanForTests(Plan.parse({ format: 1, plan: 'basic', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 2, diskGiB: 20 }))
    expect((await owner.call('GET', '/api/admin/backups')).retentionDays).toBe(14)
    expect((await owner.call('GET', '/api/admin/plan')).plan.localBackupRetentionDays).toBe(14)
  })
})

describe('the Backups card says that number', () => {
  test('every language has {days} in the Backups text, and no fixed 14', async () => {
    for (const l of LOCALES) {
      await loadLocale(l)
      const template = DICTS[l]['system.backupsDesc']
      expect({ l, fixed: /14/.test(template) }).toEqual({ l, fixed: false })
      expect({ l, three: format(template, { days: 3 }, l).includes('3') }).toEqual({ l, three: true })
    }
    expect(format(DICTS.en['system.backupsDesc'], { days: 3 }, 'en')).toBe('A backup is made every day and kept for 3 days.')
    expect(format(DICTS.en['system.backupsDesc'], { days: 1 }, 'en')).toBe('A backup is made every day and kept for 1 day.')
  })

  test('System.tsx passes the server\'s retentionDays to the text', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../web/src/pages/admin/System.tsx'), 'utf8')
    expect(src).toContain("t('system.backupsDesc', { days: state.data.retentionDays })")
    expect(src).not.toContain("desc={t('system.backupsDesc')}")
  })
})
