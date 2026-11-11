// No server/engine startup: prevent new P4 routes from silently escaping the permanent permission matrix.
import { expect, test } from 'bun:test'
import path from 'node:path'
import fs from 'node:fs'
import { CHATS, DRIVE, NOTIFICATIONS, SCHEDULES, PUSH } from '@mycel/shared/api'
import { enumerateRoutes } from './lib/matrix'
import { SPECS } from './lib/cases'
const root = path.resolve(import.meta.dir, '../..')
const p4 = [...Object.keys(DRIVE), ...Object.keys(NOTIFICATIONS), ...Object.keys(PUSH), 'listScheduleTemplates', 'createScheduleFromTemplate', 'frequentQuestions', 'oftenAsked', 'popularSkills']
test('every P4 contract route is enumerated and has a permanent persona matrix case', () => {
  const routes = enumerateRoutes(root)
  for (const key of p4) {
    expect(routes, key).toContain(key)
    expect(SPECS[key], key).toBeDefined()
  }
  expect(SCHEDULES.createScheduleFromTemplate.auth).toBe('user')
})

// Shared project chats (docs/DECISIONS.md "Shared project chats"): every chat route that takes a chat id finds the chat
// through chatFor (chat/shared.ts), which knows who sees a shared chat; nothing reaches a chat by its owner alone.
test('every /api/chats/:id route goes through chatFor; no route uses the old owner-only lookup', () => {
  const src = fs.readFileSync(path.join(root, 'server/src/routes/chats.ts'), 'utf8')
  expect(src.includes('store.ownChat(')).toBe(false)
  const keys = Object.entries(CHATS).filter(([, e]) => e.path.startsWith('/api/chats/:id')).map(([k]) => k)
  expect(keys.length).toBeGreaterThan(10)
  for (const key of keys) {
    const at = src.indexOf(`kit.handle(API.${key},`)
    expect(at, key).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('kit.handle(API.', at + 10) >>> 0 || undefined)
    expect({ key, chatFor: /chatOf\(rt, c, auth, params\.id, '(view|continue|manage)'/.test(body) }).toEqual({ key, chatFor: true })
  }
  // the other places that take a chat id from a request: artifacts, team-file attachments, uploads, thumbnails
  for (const f of ['server/src/tools/artifact.ts', 'server/src/uploads/team-refs.ts', 'server/src/uploads/attachments.ts'])
    expect({ f, checks: fs.readFileSync(path.join(root, f), 'utf8').includes('visibleSharedChat(') }).toEqual({ f, checks: true })
  // the owner-only lookup left for the server's own flows (drafts, merges) never returns a shared chat
  expect(fs.readFileSync(path.join(root, 'server/src/chat/store.ts'), 'utf8')).toContain('r.room_id || r.shared_at) return null')
})
