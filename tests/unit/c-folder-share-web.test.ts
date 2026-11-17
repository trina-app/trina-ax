// Folder sharing's web part, the server pieces it needs (docs/AGENTS/plan/20261116-1330-folder-share-web.md). Folder
// sharing is always on (its rollout gate was removed, owner 2026-11-17): the sign-in answer still says so
// (Me.server.folderShares, always true, for web and app builds from before that show folder sharing only when it is
// true), the one-time admin line's preference is kept, and the web's list of places that are never shared
// (shared/src/folder-share-places.ts, a hint for the menus) is the server's own.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SHARE_KEPT_NAMES } from '@mycel/shared'
import { keptNames } from '../../server/src/files/share-places'
import { harness, withOwner, type Client, type Harness } from './a-lib'

test('the web\'s never-shared names are the server\'s kept names, in the same order', () => {
  expect([...SHARE_KEPT_NAMES]).toEqual(keptNames())
})

describe('Me.server.folderShares', () => {
  let open: Harness, b: Client
  beforeAll(async () => {
    open = await harness('c-folder-share-web-open')
    b = await withOwner(open)
  }, 60_000)
  afterAll(() => { open.close() })

  test('always true (older builds hide folder sharing without it)', async () => {
    const me = await b.call('GET', '/api/me')
    expect(me.server.folderShares).toBe(true)
  })
  test('the one-time admin line, once closed, stays closed (prefs.folderShareNotice)', async () => {
    const me = await b.call('PATCH', '/api/me', { prefs: { folderShareNotice: 'seen' } })
    expect(me.user.prefs.folderShareNotice).toBe('seen')
    expect((await b.call('GET', '/api/me')).user.prefs.folderShareNotice).toBe('seen')
  })
})
