// 팀 파일 in the welcome steps (docs/DECISIONS.md "W6"; server/src/routes/onboarding-files.ts): the AI's picks among a
// folder's files and the step recorded by the upload run are for owners and admins only (members 403). Neither reads a
// team file's content: the picks see only what the body names, and the record answers `recorded: false` for a path
// the caller cannot read (no canary to leak).
import type { Spec } from './cases'

export const ONBOARDING_FILES_SPECS: Record<string, Spec> = {
  rankTeamFiles: { build: (c) => c.post('/api/onboarding/files/rank', { entries: [{ id: 'e0', name: '견적서 양식.xlsx', path: '영업', type: 'xlsx', size: 1000, modified: '2026-10-03' }] }), scope: 'byLevel' },
  teamFilesLanded: { build: (c) => c.post('/api/onboarding/files/landed', { path: 'groups/finance/budget.md' }), scope: 'byLevel',
    check: (r) => { if (r.status === 200 && r.text.includes('true')) throw new Error('an upload record changed the welcome steps of a team that never opened them') } },
}
