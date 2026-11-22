// my_folders (docs/decisions/20261122-demo-permission-scene.md; plan docs/AGENTS/plan/20261122-0506-demo-permission-scene.md):
// the folders the person's AI can see, each with its access, for "Show me the management folder" when no such folder
// is open to them, and for "which folders can I open?". The step carries the list (Step.folders) and the app shows it
// as a card under the answer, "Folders your AI can see" (web/src/components/chat/MyFoldersCard.tsx).
//
// - Never a folder the person cannot open. The list is made like the instructions' folder lines (prompt.ts
//   writableFolders): the rule folders, shared/ and their own folder, each kept only when RuleSet.access gives them
//   read or write (another person's folder under users/ never), and only when it is there on disk (their own folder and
//   shared/ always). A folder inside a listed one with the same access adds nothing and is left out; one with less
//   access stays (shared/ Can edit, shared/policies Read only). A folder a plugin manages (skills/<plugin>,
//   policy/authorize.ts fx.managed) refuses every write, so it shows as Read only. A team-root rule ('') opens the
//   top-level folders on disk: each one is a candidate too, checked like the others.
// - The tool takes no input, so its answer cannot depend on what was asked: a folder that does not exist and one
//   hidden from the person give the same text and the same card (the file tools' "not found or no access" rule,
//   docs/DECISIONS.md "권한 없음과 없는 파일은 같은 문구", tests/security/r3-hidden-vs-missing.test.ts).
// - Off (myFoldersOff) where others would read the list: a shared chat or one other people wrote in; and in a guest's
//   turn, a scheduled run, a question from Slack, a confidential chat, a template or restricted run; never a sub-agent
//   (subagents.ts PARENT_ONLY_TOOLS, and refused when reached). The record is the runner's alone (ChatStore.viewSteps).
import fs from 'node:fs'
import path from 'node:path'
import { MyFoldersInput } from '@mycel/shared'
import { MY_FOLDERS_MAX, type Step } from '@mycel/shared/api'
import { z } from 'zod'
import { isGuestUser } from '../credentials/guest-ai'
import type { FileService } from '../files/service'
import type { Principal } from '../policy/access'
import { hiddenEntry } from '../policy/names'
import { actionOff, mainOnly } from './shared-actions'
import type { Tool } from './tools'
import type { TurnExec } from './turn'

export const MY_FOLDERS_TOOL = 'my_folders'
export const MY_FOLDERS_DESCRIPTION = 'The folders the user\'s AI can see, each with its access (can edit or read only). No parameters. A card under this step shows the user the same list. Call it once when the user asks to see or open a folder or file that is in none of their folders (a file tool answered "not found or no access"), or asks which folders they can open. It never lists a folder the user cannot open, and its answer is the same whether a folder they asked for does not exist or is not open to them, so it never tells you which.'

export type MyFolder = NonNullable<Step['folders']>[number]

type OffExec = Pick<TurnExec, 'rt' | 'spec' | 'shared' | 'restricted' | 'templateRun' | 'otherAuthors'>
/** Why my_folders is not offered in this turn (and refused when reached anyway), or null: it is. */
export function myFoldersOff(exec: OffExec): string | null {
  if (exec.shared) return 'a shared chat'
  if (exec.otherAuthors) return 'a chat other people wrote in'
  const off = actionOff(exec, null)
  if (off) return off === 'schedule' ? 'a scheduled run' : off === 'confidential' ? 'a confidential chat' : off === 'slack' ? 'a question from Slack' : 'a run limited to one task'
  if (isGuestUser(exec.rt.db, exec.spec.userId)) return 'a guest'
  return null
}

/** where a folder goes in the list: shared/, groups/, projects/, skills/, any other, the person's own folder last */
const order = (p: string, own: string) => (p === own || p.startsWith(`${own}/`) ? 9 : p === 'shared' || p.startsWith('shared/') ? 0 : p.startsWith('groups/') ? 1 : p.startsWith('projects/') ? 2 : p === 'skills' || p.startsWith('skills/') ? 3 : 4)

/**
 * The folders `user` can open, each with its access: the rule folders they read or write, shared/ and their own folder
 * (as the instructions' writableFolders), the top-level folders a team-root rule opens and the plugin folders in
 * skills/ (always Read only), without a folder inside a listed one with the same access, and without one that is not on disk (their own folder and shared/ stay: Files shows them). Sorted shared/, groups/,
 * projects/, skills/, the rest, their own folder last; by path within each.
 */
export function myFolders(files: FileService, user: Principal): MyFolder[] {
  const rules = files.rules()
  const own = `users/${user.id}`
  const root = files.cfg.teamRoot
  const there = (p: string) => {
    if (p === own || p === 'shared') return true
    try { return fs.lstatSync(path.join(root, ...p.split('/'))).isDirectory() } catch { return false }
  }
  const managed = files.fx.managed
  const dirs = (rel: string) => {
    try {
      return fs.readdirSync(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !hiddenEntry(d.name, rel ? 1 : 0))
        .map((d) => (rel ? `${rel}/${d.name}` : d.name))
    } catch { return [] }
  }
  const boundary = rules.boundaryFolders()
  // a team-root rule opens the top-level folders that carry no rule of their own; a plugin's folder skills/<plugin>
  // carries none either, and is read only even to someone who can edit skills/
  const extra = [...(boundary.includes('') ? dirs('') : []), ...(managed ? dirs('skills').filter((p) => managed.managerOf(p.split('/'))) : [])]
  const all: MyFolder[] = [...new Set([...boundary, ...extra, 'shared', own])]
    .filter((p) => p && p !== 'users' && !(p.startsWith('users/') && p !== own && !p.startsWith(`${own}/`)))
    .flatMap((p): MyFolder[] => {
      const segs = p.split('/')
      const a = rules.access(user, segs)
      // writes in a plugin's folder are refused for everyone (authorize.ts), so Can edit would be untrue there
      return a === 'write' && !managed?.managerOf(segs) ? [{ path: p, access: 'edit' }] : a === 'read' || a === 'write' ? [{ path: p, access: 'view' }] : []
    })
    .filter((f) => there(f.path))
  // left out: a folder whose nearest listed parent gives the same access (it adds nothing). One with less access than
  // that parent stays, so the list never says Can edit where a write is refused
  const parentOf = (f: MyFolder) => all.filter((g) => f.path.startsWith(`${g.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
  const kept = all.filter((f) => parentOf(f)?.access !== f.access)
  return kept.sort((a, b) => order(a.path, own) - order(b.path, own) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The tool's text for the AI: the list (paths as the other tools take them), then how to answer. */
export function myFoldersText(list: readonly MyFolder[], own: string): string {
  const line = (f: MyFolder) => `- ${f.path}/ (${f.access === 'edit' ? 'can edit' : 'read only'})${f.path === own ? ': the user\'s own folder' : ''}`
  return [
    'The folders the user\'s AI can see (a card under this step shows the user this same list, so do not repeat it in full):',
    ...list.map(line),
    'This list never shows a folder the user cannot open, and it is the same whether a folder they asked for does not exist or is not open to them.',
    'If they asked for a folder or file that is not here, answer in one or two short sentences in their language, naming only the word they used, for example: "I can\'t find a \'management\' folder among the folders open to you. If it exists, ask its owner or an admin to share it with you." Never say or guess that it exists, that it is hidden or that permission is the reason.',
  ].join('\n')
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })
const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }

export function myFoldersTool(exec: TurnExec): Tool {
  return {
    name: MY_FOLDERS_TOOL, description: MY_FOLDERS_DESCRIPTION, inputSchema: schema(MyFoldersInput),
    async call(args, files) {
      const a = MyFoldersInput.safeParse(args ?? {})
      if (!a.success) return text('Invalid input: my_folders takes no parameters. Call it with {}.', true)
      const off = myFoldersOff(exec)
      if (off) return { ...text(`Not available here (${off}). Tell the user they can see the folders open to them in Files.`, true), summary: `${MY_FOLDERS_TOOL} -> refused: not here` }
      const main = mainOnly(exec, files)
      if (main === 'sub-agent') return { ...text('Not available to a sub-agent. Report what you could not find; the main assistant answers the user.', true), summary: `${MY_FOLDERS_TOOL} -> refused: sub-agent` }
      if (main === 'disabled') return { ...text('Access denied: this account is disabled.', true), summary: `${MY_FOLDERS_TOOL} -> denied: account disabled` }
      const me = exec.livePrincipal()
      const list = myFolders(exec.rt.files, me)
      const shown = list.slice(0, MY_FOLDERS_MAX)
      // the card's record, written by the server from the rules (never from the AI's words)
      try { exec.patchToolStep(MY_FOLDERS_TOOL, () => ({ folders: shown, ...(list.length > shown.length ? { moreFolders: list.length - shown.length } : {}) })) } catch {}
      return { ...text(myFoldersText(list, `users/${me.id}`)), summary: `${MY_FOLDERS_TOOL} -> ${list.length} folders` }
    },
  }
}
