// Which `_FILES.md` a file's line goes into (docs/AGENTS/plan/20261111-0630-file-list.md "The access unit").
//
// RuleSet.decide() (policy/access.ts) answers for a path by: `.system/` and server temp names (nobody); `users/<id>/…`
// (that person only, rules there ignored); owner and admins (everything else); for members, the deepest prefix of the
// path — the path itself included — that has rules applying to them. Only prefixes that carry rule rows are ever looked
// at, deepest first, and which prefixes carry rules does not depend on who asks. So two paths outside users/ with the
// same rule-bearing prefixes (their rule chain) give every person the same access, and a list placed where its own rule
// chain equals its files' chain can be read by exactly the people who can read every file it names.
//
// - unit key: users/<id> for a personal file; else the deepest parent folder of the file with rule rows ('' = the
//   team root without a rule). A file whose own path carries rule rows is not listed.
// - list folder: the deeper of the key and the file's top folder (shared, <top>, projects|groups|connected/<name>):
//   nothing between them has rules, so the chain is the same; a big list splits into sub-folders inside it, which have
//   no rules either (render.ts).
// - sameAccess() is checked again for every line before a list is written (render.ts): a line whose file's chain differs
//   from the list's own is left out.
import { PRODUCT } from '@mycel/shared'
import { FILE_LIST_NAME, isFileListName } from '@mycel/shared/api'
import { badSegment } from '../policy/names'

/** top folders whose sub-folders are each a unit of their own (users/ is handled apart) */
export const CONTAINERS: ReadonlySet<string> = new Set(['projects', 'groups', 'connected'])
/** top folders whose files are not listed: team skills (the AI is given the skill list already; a plugin's managed
 * folder there must never change) */
export const NOT_LISTED_TOP: ReadonlySet<string> = new Set(['skills'])

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))

export class Units {
  private rules: Set<string>
  /** `ruleFolders`: every folder path with at least one rule row (RuleSet.ruleFolders(); '' = the team root). Rows
   * under users/ never decide anything (decide() answers a personal path before looking at rules) and are dropped. */
  constructor(ruleFolders: Iterable<string>) {
    this.rules = new Set([...ruleFolders].filter((f) => f !== 'users' && !f.startsWith('users/')))
  }

  /** The rule chain of a path (its own path included), as one comparable string. Personal paths: their person. */
  chain(segs: readonly string[]): string {
    if (segs[0] === 'users' && segs.length >= 2) return `@users/${segs[1]}`
    const out: string[] = []
    for (let len = segs.length; len >= 0; len--) {
      const p = segs.slice(0, len).join('/')
      if (this.rules.has(p)) out.push(p)
    }
    return out.join('\u0000')
  }

  /** Same access for every person (see the top of this file). */
  sameAccess(a: readonly string[], b: readonly string[]): boolean { return this.chain(a) === this.chain(b) }

  /** Whether a file at this team path gets a line at all: inside a folder, not a server or hidden name, not the list. */
  listable(segs: readonly string[]): boolean {
    if (segs.length < 2) return false // loose files at the team root
    if (NOT_LISTED_TOP.has(segs[0]!) || segs[0] === PRODUCT.systemDir) return false
    if (segs[0] === 'users' && segs.length < 3) return false
    for (const s of segs) if (s.startsWith('.') || badSegment(s) !== null) return false
    if (isFileListName(segs[segs.length - 1]!)) return false
    // a rule row on the file's own path: its access differs from every folder's
    if (segs[0] !== 'users' && this.rules.has(segs.join('/'))) return false
    return true
  }

  /** The unit key of a listable file: users/<id>, or the deepest parent folder with rules ('' = none). */
  keyOf(segs: readonly string[]): string {
    if (segs[0] === 'users') return `users/${segs[1]}`
    for (let len = segs.length - 1; len >= 0; len--) {
      const p = segs.slice(0, len).join('/')
      if (this.rules.has(p)) return p
    }
    return ''
  }

  /** The file's top folder: users/<id>, projects|groups|connected/<name>, or the first folder. */
  topOf(segs: readonly string[]): string {
    if (segs[0] === 'users' || (CONTAINERS.has(segs[0]!) && segs.length >= 3)) return `${segs[0]}/${segs[1]}`
    return segs[0]!
  }

  /** The folder whose `_FILES.md` lists this file (before a split): the deeper of the unit key and the top folder. */
  listFolderOf(segs: readonly string[]): string {
    const key = this.keyOf(segs), top = this.topOf(segs)
    return segsOf(key).length >= segsOf(top).length ? key : top
  }

  /** The list file's path in a folder. */
  static listPath(folder: string): string { return folder === '' ? FILE_LIST_NAME : `${folder}/${FILE_LIST_NAME}` }
}
