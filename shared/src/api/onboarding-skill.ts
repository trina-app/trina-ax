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
import { RelPath } from './common'
import { endpoint } from './endpoint'
import { SkillInput } from './skill-inputs'

export const SKILL_DRAFT_TITLE_MAX = 40
export const SKILL_DRAFT_DESCRIPTION_MAX = 160
/** the team files a drafted skill names in "쓰는 자료" */
export const SKILL_DRAFT_FILES_MAX = 5
/** inputs shown on the form; more are folded under "더 자세히 정하기" */
export const SKILL_DRAFT_VISIBLE_INPUTS = 3

/** A team file the skill uses: one file, or (`latest`) the newest file of a folder: dated files such as this week's
 * meeting notes are named by their folder, so next week only the new file is dropped there. `like`: the words of the
 * file's name without its date ("주간회의" of "2026-11-03_주간회의.md"), so the newest file of THAT kind is read in a
 * folder that holds other files too. */
export const SkillDraftFile = z.object({ path: z.string().min(1).max(1024), latest: z.boolean(), like: z.string().max(60).optional() }).strict()
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
 * dates or amounts of that one run (or a link, contact data, a path or a tool reaching outside) still in the steps after
 * the one rewrite. A failed draft is not reused: starting again makes a new one (다시 정리하기). */
export const SkillDraftProblem = z.enum(['failed', 'unreadable', 'specific'])
export type SkillDraftProblem = z.infer<typeof SkillDraftProblem>
export const SkillDraftState = z.object({
  status: z.enum(['running', 'done', 'failed']),
  draft: SkillDraft.nullable(),
  problem: SkillDraftProblem.nullable(),
  /** shared already: where it went */
  saved: z.object({ path: z.string(), name: z.string(), title: z.string() }).nullable(),
  /** running: the first answer did not pass and its one rewrite was not asked yet; starting the draft again (POST, same
   * chat) asks for it. Reading the state never queues anything. Absent: no */
  rewrite: z.boolean().optional(),
})
export type SkillDraftState = z.infer<typeof SkillDraftState>

export const SaveSkillDraft = z.object({
  /** the title as the person left it on the card (one line) */
  title: z.string().trim().min(1).max(SKILL_DRAFT_TITLE_MAX).refine((s) => !/[\r\n]/.test(s), { message: 'one line' }),
}).strict()
export const SavedSkillDraft = z.object({ path: z.string(), name: z.string(), title: z.string() })
export type SavedSkillDraft = z.infer<typeof SavedSkillDraft>

// ---------------------------------------------------------------- a skill from a form (docs/DECISIONS.md "Setup 팀 파일:
// forms become skills")

/** the setup's forms offered as skills at once, at most */
export const FORM_SKILLS_MAX = 3
/** the forms a skill can fill: Hangul with edit_hwp, Excel and Word in the dev environment (openpyxl, python-docx) */
export const FORM_SKILL_TYPES = ['hwp', 'hwpx', 'xlsx', 'docx'] as const
export type FormSkillType = (typeof FORM_SKILL_TYPES)[number]
/** The kind of form a file is by its extension, or null when no skill can fill it. */
export function formSkillType(p: string): FormSkillType | null {
  const ext = (/\.([^./]+)$/.exec(p)?.[1] ?? '').toLowerCase()
  return (FORM_SKILL_TYPES as readonly string[]).includes(ext) ? ext as FormSkillType : null
}

const DATE_WORDS = /\d{4}[-._ ]?\d{1,2}(?:[-._ ]?\d{1,2})?|\d{1,2}[-.]\d{1,2}|\d{1,2}월(?:\s?\d{1,2}일)?|\d{4}년|\d{6,8}/g
const VERSION_WORDS = /(?<![\p{L}\p{N}])(?:v\d+(?:\.\d+)*|ver\.?\s?\d+|final|최종|수정본?|사본|copy)(?![\p{L}\p{N}])/giu
/** A form's name as people say it and as the skill finds the newest one: no extension, date, version or copy number
 * ("견적서_양식_v2 (1).xlsx" → "견적서 양식"). */
export function formStem(name: string): string {
  return name.normalize('NFC').replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/\s*\(\d+\)$/, '').replace(DATE_WORDS, ' ').replace(VERSION_WORDS, ' ')
    .replace(/[\s_.\-()[\]]+/g, ' ').trim().slice(0, 60)
}
const FORM_WORDS = /(?<![\p{L}\p{N}])(?:양식|서식|템플릿|templates?|forms?|plantillas?|formularios?|templat|formulir|様式|書式|テンプレート|ひな形)(?![\p{L}\p{N}])/giu
/** What a form makes, for "팀원이 '견적서 만들어줘' 하면": its name without the words for a form ("견적서 양식" → "견적서"); the
 * name itself when nothing is left. */
export function formKind(stem: string): string {
  const k = stem.replace(FORM_WORDS, ' ').replace(/\s+/g, ' ').trim()
  return k || stem
}

export const StartFormSkillDraft = z.object({
  /** the team file of the form (a .hwp, .hwpx, .xlsx or .docx the team can open) */
  path: RelPath,
}).strict()
export type StartFormSkillDraft = z.infer<typeof StartFormSkillDraft>

export const SKILL_SHARE = {
  startSkillDraft: endpoint({ method: 'POST', path: '/api/onboarding/skill-draft', auth: 'admin', owner: 'B', body: StartSkillDraft, response: SkillDraftStarted, status: 201,
    summary: 'Draft a team skill from one of the caller\'s chats, in a new chat of theirs (a turn without tools; only the specifics of that run become inputs). 409 for a confidential chat, one with web or outside content, or one that used files the team cannot open. Again for the same answer: the same draft, its one rewrite, or a new draft after a failed one.' }),
  startFormSkillDraft: endpoint({ method: 'POST', path: '/api/onboarding/skill-draft/from-form', auth: 'admin', owner: 'B', body: StartFormSkillDraft, response: SkillDraftStarted, status: 201,
    summary: 'Draft a team skill from a form in the team folder (a .hwp, .hwpx, .xlsx or .docx), in a new chat of the caller: a turn without tools reads the form\'s text and names the skill and the blanks teammates are asked; the steps are fixed (find the newest form of that name, fill a copy, save it as a new file). 409 for a file the team cannot open or whose name holds a customer\'s or company\'s name. Again for the same form: the same unsaved draft, its one rewrite, or a new draft after a failed one. Read and share it with the calls below.' }),
  getSkillDraft: endpoint({ method: 'GET', path: '/api/onboarding/skill-draft/:chatId', auth: 'admin', owner: 'B', response: SkillDraftState,
    summary: 'The state of a team skill draft chat of the caller: title, one line, inputs and team files read from its latest answer (never the steps).' }),
  saveSkillDraft: endpoint({ method: 'POST', path: '/api/onboarding/skill-draft/:chatId/save', auth: 'admin', owner: 'B', body: SaveSkillDraft, response: SavedSkillDraft,
    summary: 'Share the drafted skill with the team: written as the caller to skills/<pack folder>/<name>/SKILL.md (the server picks the name).' }),
} as const
