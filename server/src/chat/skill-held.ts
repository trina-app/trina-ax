// A new skill's other files, held for its SKILL.md card (QA MAN-052, docs/decisions/20261117-new-skill-files-on-card.md).
// "Make this a skill" from a form wrote SKILL.md and the form in two calls, each with its own card of raw text. A plain
// text file (a form, a template) written into a NEW skill's folder before its SKILL.md in the same answer is held, not
// saved: the SKILL.md card lists it (name, size, first lines, the whole text folded), a Save approves exactly those
// bytes, and the AI's second write of the same bytes saves with no card (chat/turn.ts askSkillWrite). Instructions,
// scripts, code and anything that looks like a skill never wait here: they keep their own card with their own text.
import crypto from 'node:crypto'
import { hiddenText } from '../integrations/connections/service'

/** at most this many files wait for one SKILL.md card (more: their own cards) */
export const HELD_MAX_FILES = 5
/** a held file's size, at most (bytes, UTF-8): a form or template; a larger file shows its own card */
export const HELD_MAX_BYTES = 16_000
/** the card's first lines of a held file: at most this many lines and characters */
const LINES_MAX = 3
const LINE_CHARS = 160

/** plain text a person reads on the card as it is (Markdown, text, a table) */
const PLAIN = /\.(md|txt|csv|tsv)$/i
/** folders inside a skill whose files steer the AI or run (the Agent Skills layout: references/ holds more
 * instructions, scripts/ code), and folders other tools load instructions from */
const STEERING_DIRS = new Set(['references', 'reference', 'scripts', 'script', 'bin', 'agents', 'commands', 'hooks', 'rules', 'prompts'])
/** files tools load as instructions by their name */
const INSTRUCTION_NAME = /^(SKILL|CLAUDE|AGENTS?|GEMINI|COPILOT|CURSOR|CODEX|WINDSURF|CLINE)([._-].*)?$|^\.?(cursorrules|windsurfrules|clinerules)$|instructions?\.md$/i

/** One file held for its skill's card: the bytes the card shows and a Save approves. */
export interface HeldFile<N = unknown> { rel: string; text: string; sha: string; size: number; need?: N | null }

/** May `text` at `rel` (actual names, as the file layer resolved them) wait for the SKILL.md card of the skill in
 * `folder`? A plain text file inside that folder (not at a hidden, steering or instruction path), small, with no NUL
 * and no skill header ("---" first: it would look like a skill). Structural only: the person reads the text itself. */
export function heldFileOk(folder: string, rel: string, text: string): boolean {
  if (!rel.startsWith(folder + '/')) return false
  const inner = rel.slice(folder.length + 1).split('/')
  const name = inner.at(-1) ?? ''
  if (!name || !PLAIN.test(name) || INSTRUCTION_NAME.test(name)) return false
  if (inner.some((s) => !s || s.startsWith('.'))) return false
  // the skill's own folder name too (a skill called "commands" or "agents" would be such a folder for a plugin)
  if ([folder.split('/').at(-1) ?? '', ...inner.slice(0, -1)].some((s) => STEERING_DIRS.has(s.toLowerCase()))) return false
  // invisible or direction-changing characters in the path or the text (zero-width, bidi, tags): what the card shows
  // would not be what is there
  if (hiddenText(rel) || hiddenText(text)) return false
  if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > HELD_MAX_BYTES) return false
  if (/^﻿?[ \t]*---[ \t]*\r?$/m.test(text.split('\n', 1)[0] ?? '')) return false
  return true
}

export function heldFile<N>(rel: string, text: string, need?: N | null): HeldFile<N> {
  return { rel, text, need, sha: crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'), size: Buffer.byteLength(text, 'utf8') }
}

/** The card's list (SkillWritePreview.files): every held file with its size, first lines and whole text. */
export function heldPreview(files: Iterable<HeldFile>): { path: string; size: number; lines: string; text: string; truncated: boolean }[] {
  return [...files].map((f) => ({
    path: f.rel,
    size: f.size,
    lines: f.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, LINES_MAX).map((l) => (l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) + '…' : l)).join('\n'),
    text: f.text,
    truncated: false,
  }))
}

/** The answer of a held write (what the AI reads): not saved yet, and what to do next. */
export function heldRefusal(rel: string, folder: string): string {
  return `Not saved yet: '${rel}' is held for the new skill in '${folder}/'. A new skill's files are saved together on one card: write '${folder}/SKILL.md' next, in this answer (its card shows the user this file too). After the user says Save on it, write '${rel}' again with exactly the same content: it is then saved without another card. If the user does not save the skill, nothing is saved.`
}

/** After the SKILL.md save: the held files its card approved, for the AI to write again unchanged. */
export function heldNote(rels: readonly string[]): string {
  return `The user said Save on the skill card, which also showed ${rels.map((r) => `'${r}'`).join(', ')}. Write ${rels.length === 1 ? 'it' : 'each'} again now with exactly the same content as before: no new card. A changed text asks the user on its own card.`
}
