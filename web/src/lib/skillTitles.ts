// Skills by the name people read (docs/DECISIONS.md "P — skill titles", "M — One meeting note, everyone's own tasks"):
// the receipt under an answer, a question that runs a skill ("/meeting-tasks 내 할 일 정리해 줘" shows as the chip "할 일
// 정리" and the question), and the composer's skill chip. One list per page load (GET /api/skills, the person's own: the
// same order "/name" runs in), asked again after a failure.
import { useEffect, useState } from 'react'
import { skillTitle, type SkillInfo } from '@mycel/shared/api'
import { api, API } from './api'

let list: Promise<SkillInfo[]> | null = null
export function skillList(): Promise<SkillInfo[]> {
  if (!list) {
    const p = api.call(API.listSkills).then((r) => r.items)
    list = p
    p.catch(() => { if (list === p) list = null })
  }
  return list
}
/** sign-out and tests: the next person asks again */
export const forgetSkillList = () => { list = null }

/** "/name rest": the command at the start of a message and what follows it (a space or a new line between), or null. */
export function splitCommand(text: string): { name: string; rest: string } | null {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:[ \t]+|\r?\n|$)/.exec(text)
  return m ? { name: m[1]!, rest: text.slice(m[0].length) } : null
}

/** The skill "/name" runs for this person: the same rule as the server (a personal skill first, then the first path,
 * names compared in any case), from the list in its order. */
export const skillByName = (items: SkillInfo[], name: string): SkillInfo | null => items.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? null

/** The skill list once it is here (null until then, or when it cannot be read). */
export function useSkillList(enabled = true): SkillInfo[] | null {
  const [items, setItems] = useState<SkillInfo[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    skillList().then((r) => live && setItems(r), () => {})
    return () => { live = false }
  }, [enabled])
  return items
}

/** A skill's title by its path; `fallback` (the recorded name) until the list says, or when the person cannot see it. */
export function useSkillTitle(path: string | null, fallback: string): string {
  const items = useSkillList(!!path)
  const s = path ? items?.find((x) => x.path === path) : null
  return s ? skillTitle(s) : fallback
}
