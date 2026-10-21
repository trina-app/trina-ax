import { describe, expect, test } from 'bun:test'
import type { FileEntry } from '@mycel/shared/api'
import { visibleFolders } from '../../src/lib/visibleFolders'

const dir = (path: string, access: FileEntry['access']): FileEntry => ({ name: path.split('/').pop()!, path, type: 'folder', size: null, mtime: '2026-10-21T00:00:00.000Z', mime: null, access })
const file = (path: string): FileEntry => ({ ...dir(path, 'write'), type: 'file', size: 1 })

// what the tree shows a member of 마케팅: groups/ and projects/ only for navigation
const TREE: Record<string, FileEntry[]> = {
  '': [dir('groups', 'none'), dir('projects', 'none'), dir('shared', 'write'), dir('skills', 'read'), dir('users', 'none'), file('readme.md')],
  groups: [dir('groups/마케팅', 'write')],
  projects: [dir('projects/a', 'none'), dir('projects/신제품-출시', 'write')],
  'projects/a': [dir('projects/a/b', 'none'), dir('projects/a/public', 'read')],
  'projects/a/b': [dir('projects/a/b/c', 'read')],
  users: [dir('users/alice', 'write')],
}

describe('folders the AI can see (new-chat card)', () => {
  test('walks through navigation-only folders to the folders the person can open', async () => {
    const calls: string[] = []
    const got = await visibleFolders(async (p) => { calls.push(p); return TREE[p] ?? [] }, { skip: (p) => p === 'users' || p.startsWith('users/') })
    expect(got.map((e) => `${e.path}:${e.access}`)).toEqual(['shared:write', 'skills:read', 'groups/마케팅:write', 'projects/신제품-출시:write', 'projects/a/public:read'])
    expect(calls).not.toContain('users')
    // depth 3 by default: projects/a/b (third level, navigation only) is not opened
    expect(calls).not.toContain('projects/a/b')
  })

  test('stops after the listing budget and ignores folders that fail to list', async () => {
    let n = 0
    const got = await visibleFolders(async (p) => { n++; if (p === 'groups') throw new Error('gone'); return TREE[p] ?? [] }, { maxListings: 2 })
    expect(n).toBe(2)
    expect(got.map((e) => e.path)).toEqual(['shared', 'skills'])
  })
})
