// Team skills: reusable workflows saved as Markdown files under skills/ (server/src/chat/skills.ts). Owner: B
// (server/src/routes/memories.ts registers it with the other per-person chat lists).
import { z } from 'zod'
import { endpoint } from './endpoint'

export const SkillInfo = z.object({
  /** team path of the skill file, e.g. skills/주간-보고서.md */
  path: z.string(),
  name: z.string(),
  description: z.string(),
})
export type SkillInfo = z.infer<typeof SkillInfo>

export const SKILLS = {
  listSkills: endpoint({ method: 'GET', path: '/api/skills', auth: 'user', owner: 'B', response: z.object({ items: z.array(SkillInfo) }), summary: 'Skills the caller can use: skills/**/*.md with a name header that the caller can read, by name.' }),
} as const
