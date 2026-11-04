// A skill's input form (components/skills/SkillForm.tsx): what the company profile fills in, and the message that runs
// the skill. The message is the ordinary skill command ("/<name>" first, server/src/chat/skills.ts invokedSkill),
// followed by one "label: value" line per filled field, so the chat shows what was asked and the AI gets it as the
// skill's input.
import { API, profilePrefill, type SkillInfo, type SkillInput } from '@mycel/shared/api'
import { api } from './api'

/** What a form can fill in: the company profile as skill-input prefill values (`company.<field>` → text, shared
 * `profilePrefill`: tone chips joined with ", ", empty fields left out). */
export type Prefill = Readonly<Record<string, string>>

/** The team's company profile (GET /api/onboarding/profile) as prefill values; empty when none is saved, the person
 * cannot read it, or the server has no profiles (404) or any other failure. */
export async function loadPrefill(): Promise<Prefill> {
  try { return profilePrefill((await api.call(API.getCompanyProfile)).profile) } catch { return {} }
}

/** The text for one field ('' when the profile has none). A one-line field gets the lines of a longer profile field
 * joined with ", " (a text box drops line breaks, which would glue the lines together). */
export function prefillValue(prefill: Prefill, input: Pick<SkillInput, 'prefill' | 'multiline'>): string {
  const v = (input.prefill && prefill[input.prefill]) || ''
  return input.multiline ? v : v.split('\n').map((l) => l.trim()).filter(Boolean).join(', ')
}

/** Start values: from the profile where a field asks for it, without touching what the person already typed. */
export function withPrefill(inputs: readonly SkillInput[], prefill: Prefill, values: Record<string, string>, typed: ReadonlySet<string>): Record<string, string> {
  const next = { ...values }
  for (const i of inputs) if (!typed.has(i.name) && !next[i.name]?.trim()) next[i.name] = prefillValue(prefill, i)
  return next
}

/** The required fields left empty. */
export const missingRequired = (inputs: readonly SkillInput[], values: Record<string, string>) =>
  inputs.filter((i) => i.required && !values[i.name]?.trim()).map((i) => i.name)

/** The message that runs the skill. A skill without a form takes one free text after its name. With nothing filled
 * in it is "/<name> " (the space: the message box's "/" menu takes the skill as chosen and stays closed). */
export function composeSkillMessage(name: string, inputs: readonly SkillInput[] | undefined, values: Record<string, string>, free = ''): string {
  if (!inputs?.length) return `/${name} ${free.trim()}`
  const parts = inputs.flatMap((i) => {
    const v = (values[i.name] ?? '').replace(/\r\n?/g, '\n').trim()
    if (!v) return []
    return [i.multiline || v.includes('\n') ? `${i.label}:\n${v}` : `${i.label}: ${v}`]
  })
  return parts.length ? `/${name}\n${parts.join('\n\n')}` : `/${name} `
}

/** The skill "/<name>" runs for this person, from their list (GET /api/skills), as the server picks it
 * (server/src/chat/skills.ts invokedSkill): the same name, a personal skill first, then the first path. A form runs by
 * name, so a form whose skill is not this one would run another skill. */
export function skillRunBy(skills: readonly SkillInfo[], name: string): SkillInfo | null {
  const key = (s: string) => s.normalize('NFC').toLowerCase()
  return skills.filter((s) => key(s.name) === key(name))
    .sort((a, b) => Number(!!b.personal) - Number(!!a.personal) || a.path.localeCompare(b.path))[0] ?? null
}

/** /skills?run=<path>: the link that opens a skill's form (the invite link and the welcome steps use it too). */
export const skillRunLink = (path: string) => `/skills?run=${encodeURIComponent(path)}`
