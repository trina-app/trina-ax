// "My way becomes the team's skill" (docs/DECISIONS.md "S — The lead's way becomes a team skill"). Under the lead's
// first result the owner or an admin asks for a team skill made from it: a restricted chat turn of theirs (no tools,
// like the company profile draft from pasted text, server/src/onboarding/skill-draft.ts) turns the conversation and the
// team files it used into a JSON draft. Only the specifics of that one run become questions for teammates (inputs); the
// server checks that no name, date or amount of the run is left in the steps. The person reads six things on a card
// (title, one line, what teammates are asked, the team files it uses, [팀에 공유], 나중에) and shares it: the server
// writes skills/<team pack folder>/<slug>/SKILL.md as them (a human save, like approving a suggestion). The steps and
// the slug are never shown.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { endpoint } from './endpoint'
import { SkillInput } from './skill-inputs'

export const SKILL_DRAFT_TITLE_MAX = 40
export const SKILL_DRAFT_DESCRIPTION_MAX = 160
/** the team files a drafted skill names in "쓰는 자료" */
export const SKILL_DRAFT_FILES_MAX = 5
/** inputs shown on the form; more are folded under "더 자세히 정하기" */
export const SKILL_DRAFT_VISIBLE_INPUTS = 3

/** A team file the skill uses: one file, or (`latest`) the newest file of a folder: dated files such as this week's
 * meeting notes are named by their folder, so next week only the new file is dropped there. */
export const SkillDraftFile = z.object({ path: z.string().min(1).max(1024), latest: z.boolean() }).strict()
export type SkillDraftFile = z.infer<typeof SkillDraftFile>

/** What the card shows (the steps stay on the server). */
export const SkillDraft = z.object({
  title: z.string().min(1).max(SKILL_DRAFT_TITLE_MAX),
  description: z.string().max(SKILL_DRAFT_DESCRIPTION_MAX),
  inputs: z.array(SkillInput),
  files: z.array(SkillDraftFile).max(SKILL_DRAFT_FILES_MAX),
  /** the work comes back every week (meeting notes yes, a quote no): the skill's metadata says so, and only such skills
   * get the "매주 이 시간에 자동으로 받을까요?" suggestion */
  recurring: z.boolean(),
}).strict()
export type SkillDraft = z.infer<typeof SkillDraft>

export const StartSkillDraft = z.object({
  /** the caller's chat whose latest answer becomes a skill */
  chatId: Uuid7,
}).strict()
export const SkillDraftStarted = z.object({ draftChatId: z.string() })
export type SkillDraftStarted = z.infer<typeof SkillDraftStarted>

/** Why there is no card: `failed` the answer ended with an error, `unreadable` no valid JSON or form, `specific` names,
 * dates or amounts of that one run still in the steps after the one rewrite. */
export const SkillDraftProblem = z.enum(['failed', 'unreadable', 'specific'])
export type SkillDraftProblem = z.infer<typeof SkillDraftProblem>
export const SkillDraftState = z.object({
  status: z.enum(['running', 'done', 'failed']),
  draft: SkillDraft.nullable(),
  problem: SkillDraftProblem.nullable(),
  /** shared already: where it went */
  saved: z.object({ path: z.string(), name: z.string(), title: z.string() }).nullable(),
})
export type SkillDraftState = z.infer<typeof SkillDraftState>

export const SaveSkillDraft = z.object({
  /** the title as the person left it on the card (one line) */
  title: z.string().trim().min(1).max(SKILL_DRAFT_TITLE_MAX).refine((s) => !/[\r\n]/.test(s), { message: 'one line' }),
}).strict()
export const SavedSkillDraft = z.object({ path: z.string(), name: z.string(), title: z.string() })
export type SavedSkillDraft = z.infer<typeof SavedSkillDraft>

export const SKILL_SHARE = {
  startSkillDraft: endpoint({ method: 'POST', path: '/api/onboarding/skill-draft', auth: 'admin', owner: 'B', body: StartSkillDraft, response: SkillDraftStarted, status: 201,
    summary: 'Draft a team skill from one of the caller\'s chats, in a new chat of theirs (a turn without tools; only the specifics of that run become inputs).' }),
  getSkillDraft: endpoint({ method: 'GET', path: '/api/onboarding/skill-draft/:chatId', auth: 'admin', owner: 'B', response: SkillDraftState,
    summary: 'The state of a team skill draft chat of the caller: title, one line, inputs and team files read from its latest answer (never the steps).' }),
  saveSkillDraft: endpoint({ method: 'POST', path: '/api/onboarding/skill-draft/:chatId/save', auth: 'admin', owner: 'B', body: SaveSkillDraft, response: SavedSkillDraft,
    summary: 'Share the drafted skill with the team: written as the caller to skills/<pack folder>/<name>/SKILL.md (the server picks the name).' }),
} as const
