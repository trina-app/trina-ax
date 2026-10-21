// Team skills: reusable workflows kept as Markdown files under skills/ (any depth), so the folder rules decide who
// may use one (skills/재무/ can be the finance group's) and who may write one. A skill file starts with a header:
//
//   ---
//   name: 주간 보고서
//   description: shared/회의록의 이번 주 회의록으로 주간 보고서 docx를 만든다
//   ---
//   (the steps)
//
// A .md in skills/ without that header stays a team rule (read every turn, prompt.ts teamRules). A skill is used when
// the person starts a message with "/<name>" (the server puts the skill into that turn) or when the AI picks it from
// the list in its instructions and reads it.
import fs from 'node:fs'
import path from 'node:path'
import type { FileService } from '../files/service'
import type { Principal } from '../policy/access'

export interface SkillInfo { path: string; name: string; description: string }
export interface Skill extends SkillInfo { body: string }

const SKILLS_DIR = 'skills'
const MAX_DEPTH = 3
const MAX_FILES = 200
export const SKILL_BODY_MAX = 16_000
const NAME_MAX = 60
const DESCRIPTION_MAX = 300

/** The header of a skill file, or null when the file has none (a team rule) or no usable name. */
export function parseSkill(text: string): { name: string; description: string; body: string } | null {
  const t = text.replace(/^﻿/, '')
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  const name = (fields.name ?? '').replace(/\s+/g, ' ').trim()
  // a name can't start with "/" or hold another slash command, and must fit one line in the picker
  if (!name || name.length > NAME_MAX || name.includes('/')) return null
  return { name, description: (fields.description ?? '').slice(0, DESCRIPTION_MAX), body: t.slice(m[0].length) }
}

/** Every skill file under skills/ the person can read, sorted by name. Symlinks and hard-linked files are skipped. */
export function listSkills(files: FileService, user: Principal): Skill[] {
  const rules = files.rules()
  const root = files.fx.root
  const out: Skill[] = []
  let seen = 0
  const walk = (rel: string[], depth: number) => {
    let names: string[]
    try { names = fs.readdirSync(path.join(root, ...rel)).sort() } catch { return }
    for (const n of names) {
      if (seen >= MAX_FILES || n.startsWith('.')) continue
      const segs = [...rel, n]
      if (rules.access(user, segs) === 'none') continue
      let st: fs.Stats
      try { st = fs.lstatSync(path.join(root, ...segs)) } catch { continue }
      if (st.isDirectory()) { if (depth < MAX_DEPTH) walk(segs, depth + 1); continue }
      if (!st.isFile() || st.nlink > 1 || !n.endsWith('.md')) continue
      seen++
      let text: string
      try { text = fs.readFileSync(path.join(root, ...segs), 'utf8').slice(0, SKILL_BODY_MAX + 2000) } catch { continue }
      const s = parseSkill(text)
      if (s) out.push({ path: segs.join('/'), name: s.name, description: s.description, body: s.body.slice(0, SKILL_BODY_MAX) })
    }
  }
  try { if (fs.lstatSync(path.join(root, SKILLS_DIR)).isDirectory()) walk([SKILLS_DIR], 1) } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

/**
 * The skill a message starts with ("/주간 보고서 이번 주 것"), matched against the person's skills by name (longest name
 * first, so "/보고서 요약" beats "/보고서") or by file name without .md. Returns the skill and the text after it.
 */
export function invokedSkill(skills: Skill[], content: string): { skill: Skill; input: string } | null {
  const t = content.trimStart()
  if (!t.startsWith('/')) return null
  const rest = t.slice(1)
  const fold = (s: string) => s.normalize('NFC').toLowerCase()
  const candidates = skills.flatMap((s) => [{ s, key: s.name }, { s, key: path.posix.basename(s.path, '.md') }])
    .sort((a, b) => b.key.length - a.key.length)
  for (const { s, key } of candidates) {
    const head = rest.slice(0, key.length)
    const next = rest.charAt(key.length)
    if (fold(head) === fold(key) && (next === '' || /\s/.test(next))) return { skill: s, input: rest.slice(key.length).trim() }
  }
  return null
}

/** The folder of a skill file (for the chat's read scope). */
export const skillFolder = (p: string) => p.slice(0, p.lastIndexOf('/'))
