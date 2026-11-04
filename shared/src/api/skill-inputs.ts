// A skill's input form (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms"). A SKILL.md may
// declare the few facts it needs in its header's `metadata` map, as one string holding a small JSON list:
//
//   metadata:
//     inputs: |
//       [{"name": "product", "label": "알릴 제품·서비스", "required": true, "prefill": "company.products"}]
//
// The server reads it (server/src/chat/skills.ts) and lists it with the skill (GET /api/skills); the web app shows a
// short form (web/src/components/skills/SkillForm.tsx) that starts a chat with "/<name>" and the filled values. The
// form is a convenience only: it grants nothing, and a skill whose inputs do not parse still loads (without a form)
// with a warning for the people who manage it (skill issue `inputs`).
import { z } from 'zod'

/** Company profile fields a form may fill in for the person (GET /api/onboarding/profile). */
export const SKILL_INPUT_PREFILL = ['company.oneLine', 'company.products', 'company.audience', 'company.tone', 'company.avoid', 'company.website'] as const
export type SkillInputPrefill = (typeof SKILL_INPUT_PREFILL)[number]

export const SKILL_INPUTS_MAX = 8
export const SKILL_INPUT_LABEL_MAX = 60
export const SKILL_INPUT_PLACEHOLDER_MAX = 200
/** what a person can type into one field (single line / multiline) */
export const SKILL_INPUT_VALUE_MAX = 300
export const SKILL_INPUT_TEXT_MAX = 6000

const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\r\n]/.test(s), { message: 'one line' })

export const SkillInput = z.strictObject({
  /** a key for the value: lowercase letters, digits and _ */
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: oneLine(SKILL_INPUT_LABEL_MAX),
  placeholder: oneLine(SKILL_INPUT_PLACEHOLDER_MAX).optional(),
  required: z.boolean().optional(),
  /** a company profile field to start the field with (the person can change it) */
  prefill: z.enum(SKILL_INPUT_PREFILL).optional(),
  multiline: z.boolean().optional(),
})
export type SkillInput = z.infer<typeof SkillInput>

export const SkillInputs = z.array(SkillInput).min(1).max(SKILL_INPUTS_MAX)
  .refine((list) => new Set(list.map((i) => i.name)).size === list.length, { message: 'input names must be different' })

/** The `inputs` value of a skill's metadata: the list, or why it is not one (a short English reason). */
export function parseSkillInputs(raw: string): { ok: true; inputs: SkillInput[] } | { ok: false; reason: string } {
  let json: unknown
  try { json = JSON.parse(raw) } catch { return { ok: false, reason: 'not valid JSON' } }
  const r = SkillInputs.safeParse(json)
  if (r.success) return { ok: true, inputs: r.data }
  const first = r.error.issues[0]
  const where = first?.path.length ? ` at ${first.path.join('.')}` : ''
  return { ok: false, reason: `${first?.message ?? 'not a list of inputs'}${where}` }
}
