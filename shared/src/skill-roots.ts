// Where skills live, by the path alone (docs/DECISIONS.md "팀 스킬 관리", "Group skills", "Project skills"): skills/
// (the team's), groups/<folder>/skills/ (a group's) and projects/<name>/skills/ (a project's). No dependencies, so the
// dev environment's srt runner (server/src/devenv/srt/access.ts) uses the same rule as the server's skill guard
// (server/src/skills/guard.ts) inside its own small Docker image (tests/linux/Dockerfile.srt).

export const SKILLS_DIR = 'skills'
export const GROUPS_DIR = 'groups'
export const PROJECTS_DIR = 'projects'

const fold = (s: string) => s.normalize('NFC').toLowerCase()

export type SkillRoot = { kind: 'team' } | { kind: 'group'; folder: string } | { kind: 'project'; folder: string }

/** The skill root `rel` is in, by the resolved path: the team's (skills/ and below), a group's (groups/<folder>/
 * skills/ and below, `folder` the group's folder groups/<name>), a project's (projects/<name>/skills/ and below,
 * `folder` the project's folder projects/<name>), or null for every other path. Each name is compared without letter
 * case or Unicode form (a case-insensitive team folder serves 'Skills/x.md' from skills/), so the check never misses
 * the real folder. Any groups/<name>/skills and projects/<name>/skills counts, whether or not a group or a project has
 * that folder now (fail closed: a folder left behind is guarded too). */
export function skillRootOf(rel: string): SkillRoot | null {
  const segs = rel.split('/')
  if (fold(segs[0] ?? '') === SKILLS_DIR) return { kind: 'team' }
  if (segs.length >= 3 && segs[1] && fold(segs[2]!) === SKILLS_DIR) {
    if (fold(segs[0]!) === GROUPS_DIR) return { kind: 'group', folder: `${segs[0]}/${segs[1]}` }
    if (fold(segs[0]!) === PROJECTS_DIR) return { kind: 'project', folder: `${segs[0]}/${segs[1]}` }
  }
  return null
}
