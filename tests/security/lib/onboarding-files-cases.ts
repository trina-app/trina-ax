// 팀 파일 in the welcome steps (docs/DECISIONS.md "W6"; server/src/routes/onboarding-files.ts): the AI's picks among a
// folder's files and the step recorded by the upload run are for owners and admins only (members 403). Neither reads a
// team file's content: the picks see only what the body names, and the record answers `recorded: false` for a path
// the caller cannot read (no canary to leak).
import type { Spec } from './cases'

export const ONBOARDING_FILES_SPECS: Record<string, Spec> = {
  rankTeamFiles: { build: (c) => c.post('/api/onboarding/files/rank', { entries: [{ id: 'e0', name: '견적서 양식.xlsx', path: '영업', type: 'xlsx', size: 1000, modified: '2026-10-03' }] }), scope: 'byLevel' },
  teamFilesLanded: { build: (c) => c.post('/api/onboarding/files/landed', { path: 'groups/finance/budget.md' }), scope: 'byLevel',
    check: (r) => { if (r.status === 200 && r.text.includes('true')) throw new Error('an upload record changed the welcome steps of a team that never opened them') } },
  // the setup's folder plan (docs/DECISIONS.md "Setup 팀 파일: the AI proposes folders"): owners and admins; a plan is
  // read by the one who started it (a job in memory: no file is read for a path that is not there); apply moves only
  // what the caller may move
  startOrganize: { build: (c) => c.post('/api/onboarding/files/organize', { paths: ['shared/없는 파일.md'] }), scope: 'byLevel' },
  organizeStatus: { build: async (c) => {
    const started = await c.post('/api/onboarding/files/organize', { paths: ['shared/없는 파일.md'] })
    return c.get(`/api/onboarding/files/organize/${started.json?.id ?? '00000000-0000-7000-8000-000000000000'}`)
  }, scope: 'byLevel' },
  applyOrganize: { build: (c) => c.post('/api/onboarding/files/organize/apply', { moves: [{ from: 'groups/finance/budget.md', folder: '양식' }] }), scope: 'byLevel',
    check: (r) => { if (r.status === 200 && r.text.includes('"to"')) throw new Error('a file outside shared/ was moved by a folder plan') } },
}
