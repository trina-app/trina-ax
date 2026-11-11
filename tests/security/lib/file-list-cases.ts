import type { Spec } from './cases'

// The file list's admin routes (Admin › Team settings › File list; server/src/file-list/). Admins and the owner only.
// The status names counts and times, never a file: an allowed answer must not hold a team path. Whether a member can
// see another person's file names through a list is tested in tests/security/file-list.test.ts.
const noPaths = (r: { status: number; text: string }) => {
  if (r.status < 300 && /users\/|shared\/|groups\/|projects\//.test(r.text)) throw new Error('the file list status names a team path')
}
export const FILE_LIST_SPECS: Record<string, Spec> = {
  fileListStatus: { build: (c) => c.get('/api/admin/file-list'), scope: 'byLevel', check: noPaths },
  // switching it on while it is on: answers the status, changes nothing
  updateFileList: { build: (c) => c.patch('/api/admin/file-list', { enabled: true }), scope: 'byLevel', check: noPaths },
  // a run needs the team's AI: the allowed side is in tests/unit/c-file-list.test.ts
  runFileList: { skipPositive: true, build: (c) => c.post('/api/admin/file-list/run', {}), scope: 'byLevel' },
}
