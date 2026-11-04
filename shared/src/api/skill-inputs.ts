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
//
// A field is a text box by default. `"type": "choice"` makes it a row of chips (one pick) from `options` (each a
// `value` and the `label` people read and the message carries), starting on `default` when given:
//
//   {"name": "channel", "label": "어디에 실을까요", "type": "choice", "default": "instagram",
//    "options": [{"value": "instagram", "label": "인스타그램 피드"}, {"value": "sms", "label": "문자"}]}
//
// `"advanced": true` folds a field under "더 자세히 정하기" (it is still sent when filled, from the profile too), so the
// form shows only what most runs change.
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

/** a choice field's chips: at least two, at most this many */
export const SKILL_INPUT_OPTIONS_MAX = 8
export const SKILL_INPUT_OPTION_LABEL_MAX = 40

export const SkillInputOption = z.strictObject({
  /** a key for the option: lowercase letters, digits, _ and - */
  value: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  /** what people read on the chip and what the message carries */
  label: oneLine(SKILL_INPUT_OPTION_LABEL_MAX),
})
export type SkillInputOption = z.infer<typeof SkillInputOption>

export const SkillInput = z.strictObject({
  /** a key for the value: lowercase letters, digits and _ */
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: oneLine(SKILL_INPUT_LABEL_MAX),
  /** text (a box, the default) or choice (chips, one pick from `options`) */
  type: z.enum(['text', 'choice']).optional(),
  placeholder: oneLine(SKILL_INPUT_PLACEHOLDER_MAX).optional(),
  required: z.boolean().optional(),
  /** a company profile field to start the field with (the person can change it); text fields only */
  prefill: z.enum(SKILL_INPUT_PREFILL).optional(),
  /** text fields only */
  multiline: z.boolean().optional(),
  /** choice fields only: the chips, in order */
  options: z.array(SkillInputOption).min(2).max(SKILL_INPUT_OPTIONS_MAX).optional(),
  /** choice fields only: the option picked at the start (its `value`) */
  default: z.string().max(32).optional(),
  /** folded under "더 자세히 정하기" (still sent when filled) */
  advanced: z.boolean().optional(),
}).superRefine((i, c) => {
  if (i.type === 'choice') {
    if (!i.options) c.addIssue({ code: 'custom', path: ['options'], message: 'a choice needs options' })
    else {
      if (new Set(i.options.map((o) => o.value)).size !== i.options.length) c.addIssue({ code: 'custom', path: ['options'], message: 'option values must be different' })
      if (i.default !== undefined && !i.options.some((o) => o.value === i.default)) c.addIssue({ code: 'custom', path: ['default'], message: 'default must be one of the option values' })
    }
    for (const k of ['placeholder', 'prefill', 'multiline'] as const) if (i[k] !== undefined) c.addIssue({ code: 'custom', path: [k], message: `${k} is for text fields` })
  } else {
    for (const k of ['options', 'default'] as const) if (i[k] !== undefined) c.addIssue({ code: 'custom', path: [k], message: `${k} is for choice fields ("type": "choice")` })
  }
})
export type SkillInput = z.infer<typeof SkillInput>

/** a choice field (chips) */
export const isChoice = (i: SkillInput): i is SkillInput & { options: SkillInputOption[] } => i.type === 'choice' && !!i.options

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
