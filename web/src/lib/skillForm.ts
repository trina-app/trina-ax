// A skill's input form (components/skills/SkillForm.tsx): what the company profile fills in, and the message that runs
// the skill. The message is the ordinary skill command ("/<name>" first, server/src/chat/skills.ts invokedSkill),
// followed by one "label: value" line per filled field, so the chat shows what was asked and the AI gets it as the
// skill's input.
import { z } from 'zod'
import { endpoint, type SkillInput, type SkillInputPrefill } from '@mycel/shared/api'
import { api } from './api'

/** The company profile fields a form uses (GET /api/onboarding/profile; the full type belongs to the profile work).
 * Unknown fields are ignored and every field is optional, so a newer profile still fills what it can. */
const ProfileFields = z.looseObject({
  website: z.string().optional(),
  oneLine: z.string().optional(),
  products: z.string().optional(),
  audience: z.string().optional(),
  tone: z.array(z.string()).optional(),
  avoid: z.string().optional(),
})
export type ProfileFields = z.infer<typeof ProfileFields>

const getProfile = endpoint({ method: 'GET', path: '/api/onboarding/profile', auth: 'user', owner: 'B', response: z.object({ profile: ProfileFields.nullable() }), summary: 'The company profile, for prefilling skill forms.' })

/** The company profile, or null: none saved yet, or a server without profiles (404) or any other failure. */
export async function loadProfile(): Promise<ProfileFields | null> {
  try { return (await api.call(getProfile)).profile } catch { return null }
}

/** The profile's text for one prefill key ('' when the profile has none). */
export function prefillValue(profile: ProfileFields | null, key: SkillInputPrefill | undefined): string {
  if (!profile || !key) return ''
  const v = profile[key.slice('company.'.length) as keyof ProfileFields]
  return (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).join(', ') : typeof v === 'string' ? v : '').trim()
}

/** Start values: from the profile where a field asks for it, without touching what the person already typed. */
export function withPrefill(inputs: readonly SkillInput[], profile: ProfileFields | null, values: Record<string, string>, typed: ReadonlySet<string>): Record<string, string> {
  const next = { ...values }
  for (const i of inputs) if (!typed.has(i.name) && !next[i.name]?.trim()) next[i.name] = prefillValue(profile, i.prefill)
  return next
}

/** The required fields left empty. */
export const missingRequired = (inputs: readonly SkillInput[], values: Record<string, string>) =>
  inputs.filter((i) => i.required && !values[i.name]?.trim()).map((i) => i.name)

/** The message that runs the skill. A skill without a form takes one free text after its name. */
export function composeSkillMessage(name: string, inputs: readonly SkillInput[] | undefined, values: Record<string, string>, free = ''): string {
  if (!inputs?.length) return free.trim() ? `/${name} ${free.trim()}` : `/${name}`
  const parts = inputs.flatMap((i) => {
    const v = (values[i.name] ?? '').replace(/\r\n?/g, '\n').trim()
    if (!v) return []
    return [i.multiline || v.includes('\n') ? `${i.label}:\n${v}` : `${i.label}: ${v}`]
  })
  return parts.length ? `/${name}\n${parts.join('\n\n')}` : `/${name}`
}

/** /skills?run=<path>: the link that opens a skill's form (the invite link and the welcome steps use it too). */
export const skillRunLink = (path: string) => `/skills?run=${encodeURIComponent(path)}`
