// The files a guest can reach (docs/DECISIONS.md "Guests: only what they were invited to"): the server lets a guest read
// only their project's folder and their own folder (server/src/policy/access.ts), so a file or folder picker never shows
// them the team folder. Its top is those folders as one list ("Your files"), and the folders it only passes through
// (projects/, users/) are left out of the path above it.
import type { FileEntry, TreeResponse } from '@mycel/shared/api'
import { api, API } from './api'

/** The folders a guest only passes through to reach their own: never a step of the path shown to them. */
export const guestPassThrough = (path: string): boolean => path === 'projects' || path === 'users'

/** A guest's top: the folders inside projects/ (their project) and users/ (their own folder), their project first;
 * files at the team's top are never theirs. A folder that cannot be read is left out. */
export async function readGuestTop(): Promise<TreeResponse> {
  const top = await api.call(API.tree, { query: { path: '', limit: 200 } })
  const pass = top.entries.filter((e) => e.type === 'folder' && guestPassThrough(e.path))
  const inner = await Promise.all(pass.map((f) => api.call(API.tree, { query: { path: f.path, limit: 200 } }).then(
    (r) => r.entries.filter((e) => e.type === 'folder' && e.access !== 'none'),
    () => [] as FileEntry[],
  )))
  const entries = inner.flat().sort((a, b) => Number(a.path.startsWith('users/')) - Number(b.path.startsWith('users/')))
  return { ...top, access: 'none', entries, nextCursor: null }
}
