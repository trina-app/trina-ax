// Security (audit 2026-11-11): an admin could shorten the audit log, file history and trash retention (and switch the
// update channel), so the nightly sweep erased the audit trail and old file versions. These are the owner's now
// (OWNER_ONLY_SETTINGS, docs/DECISIONS.md "Retention and the update channel are owner-only").
// Fixture: alice = member (marketing), bob = member (finance), carol = admin, dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { OWNER_ONLY_SETTINGS } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-owner-retention') })
afterAll(async () => { await A.close() })

const patch = (as: 'alice' | 'carol' | 'dana', body: Record<string, unknown>) => A.json('/api/admin/settings', { as, ...jsonBody(body, 'PATCH') })
const CHANGE: Record<(typeof OWNER_ONLY_SETTINGS)[number], unknown> = { updateChannel: 'beta', auditRetentionDays: 7, fileHistoryRetentionDays: 1, trashRetentionDays: 1, chatTrashRetentionDays: 1 }

describe('retention periods and the update channel: owner only', () => {
  test('an admin is refused for each, with the field named; nothing changes', async () => {
    const before = (await A.json('/api/admin/settings', { as: 'dana' })).body
    for (const k of OWNER_ONLY_SETTINGS) {
      const r = await patch('carol', { [k]: CHANGE[k] })
      expect(r.status).toBe(403)
      expect(r.body.error.fields).toEqual({ [`body.${k}`]: 'owner only' })
    }
    expect((await A.json('/api/admin/settings', { as: 'dana' })).body).toEqual(before)
  })
  test('a member is refused before that (the admin level)', async () => {
    expect((await patch('alice', { auditRetentionDays: 7 })).status).toBe(403)
  })
  test('the owner changes them; an admin still changes other team settings', async () => {
    const r = await patch('dana', { auditRetentionDays: 30 })
    expect(r.status).toBe(200)
    expect(r.body.auditRetentionDays).toBe(30)
    expect((await patch('carol', { aiVision: false })).status).toBe(200)
    expect((await patch('carol', { aiVision: true })).status).toBe(200)
  })
})
