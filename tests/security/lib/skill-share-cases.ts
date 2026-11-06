// 내 스킬 가져오기 (docs/DECISIONS.md "K"; server/src/skills/share.ts): share proposals are owners' and admins' (members
// 403 from the endpoints' admin level), and each is its person's alone. Dana's proposal (made once, on the first case
// that needs it) names a skill carrying a canary: the list of anyone else must not show it. Reading, applying or
// dropping a proposal that is not the caller's is the same as one that does not exist (404), so those cases use an id
// nobody has. The cross-admin 404 on a real proposal is in tests/unit/b-skill-share-apply.test.ts.
import type { Spec } from './cases'
import type { World } from './world'

const CANARY = 'skill-share-canary-5e1'
const NONE = '01900000-0000-7000-8000-00000000c0de'
let made = false
function danaShare(w: World): void {
  if (made) return
  made = true
  const now = new Date()
  w.inst.ctx.db.query(`INSERT INTO skill_shares (id, created_by, source, status, ai, where_label, projects, result, created_at, expires_at, updated_at)
    VALUES ('01900000-0000-7000-8000-00000000da9a', 'dana', 'browser', 'ready', 'none', NULL, NULL, ?, ?, ?, ?)`)
    .run(JSON.stringify({ candidates: [{ name: CANARY, title: null, description: CANARY, origin: 'user', project: null, group: 'other', reason: 'unjudged', detail: null, personalPath: false, files: [], scriptsDropped: 0, sameName: null, similar: null, action: 'add', applied: null }], rule: null, ruleIn: null, tools: [], landing: null }),
      now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString(), now.toISOString())
}

export const SKILL_SHARE_SPECS: Record<string, Spec> = {
  createSkillShare: { build: (c) => c.post('/api/skill-shares', { source: 'browser', skills: [] }), scope: 'byLevel' },
  listSkillShares: { build: (c, w) => { danaShare(w); return c.get('/api/skill-shares') }, scope: 'byLevel',
    check: (r, _w, who) => { if (who !== 'owner' && r.text.includes(CANARY)) throw new Error(`${who} lists the owner's skill share`) } },
  getSkillShare: { build: (c) => c.get(`/api/skill-shares/${NONE}`), scope: 'nobody' },
  applySkillShare: { build: (c) => c.post(`/api/skill-shares/${NONE}/apply`, { skills: [] }), scope: 'nobody' },
  dismissSkillShare: { build: (c) => c.post(`/api/skill-shares/${NONE}/dismiss`), scope: 'nobody' },
}
