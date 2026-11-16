// Admin › System's update line when no newer release is known (QA TC-2860): "latest version" only after the server
// reached the release feed; a server that never reached it (a company proxy not set for the server) says so.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { updateCheckText } from '../../web/src/lib/updateOutcome'

describe('the update line', () => {
  test('never checked, failed, checked', () => {
    expect(updateCheckText({ lastCheckedAt: null })).toBe('system.notCheckedYet')
    expect(updateCheckText({ lastCheckedAt: null, checkFailed: true })).toBe('system.checkFailed')
    expect(updateCheckText({ lastCheckedAt: '2026-11-16T03:00:00Z', checkFailed: true })).toBe('system.checkFailed')
    expect(updateCheckText({ lastCheckedAt: '2026-11-16T03:00:00Z' })).toBe('system.upToDate')
  })
  test('every language has the new line, and Admin › System uses the helper', () => {
    const dir = path.resolve(import.meta.dir, '../../web/src/i18n')
    for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh']) expect(fs.readFileSync(path.join(dir, `${l}.ts`), 'utf8')).toMatch(/['"]system\.notCheckedYet['"]: /)
    expect(fs.readFileSync(path.resolve(import.meta.dir, '../../web/src/pages/admin/System.tsx'), 'utf8')).toContain('t(updateCheckText(u))')
  })
})
