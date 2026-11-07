import type { Spec } from './cases'
import { leaks, VISIBLE } from './matrix'
import { C, USER_OF, WHO, type Who, type World } from './world'
import type { LookupOptions, LookupResult } from '../../../server/src/knowledge-graph/service'

// The knowledge graph's admin routes (Admin › Team settings › Knowledge graph; docs/KNOWLEDGE-GRAPH.md). Admins and the
// owner only. The status names indexed folders and counts, never a file, and personal folders only as a total: an
// allowed answer must not name a users/ path. The access filter of the AI's answers is tested in
// tests/unit/c-knowledge-graph.test.ts.
const noPersonalPaths = (r: { status: number; text: string }) => {
  if (r.status === 200 && r.text.includes('users/')) throw new Error('the knowledge graph status names a personal folder')
}
export const KNOWLEDGE_GRAPH_SPECS: Record<string, Spec> = {
  knowledgeGraphStatus: { build: (c) => c.get('/api/admin/knowledge-graph'), scope: 'byLevel', check: noPersonalPaths },
  // an empty change: answers the status, changes nothing
  updateKnowledgeGraph: { build: (c) => c.patch('/api/admin/knowledge-graph', {}), scope: 'byLevel', check: noPersonalPaths },
  // needs the knowledge graph on (CodeGraph installed): 409 on a server without it, so the allowed side is in the unit test
  rebuildKnowledgeGraph: { skipPositive: true, build: (c) => c.post('/api/admin/knowledge-graph/rebuild', {}), scope: 'byLevel' },
}

// ---------------------------------------------------------------- lookup()
// KnowledgeGraph.lookup() is no route of its own: it is the document search behind the AI's knowledge_explore tool, the
// lookup the server makes before the model starts (its passages go into the prompt) and the Files search. A file the
// person may not read must never appear in its answer: not its path, not its text, not in `files`, whether it is in
// another person's folder, in a hidden sub-folder of a folder they can read, in a group folder they are not in, or a
// skill restricted to a group. Run against the world (world.ts) with the documents part of the knowledge graph on and
// indexed (tests/unit/c-kg-lookup-security.test.ts); a route that calls lookup() (GET /api/files/search) has its own
// cases in cases.ts.

/** the canaries that are the text of a team file (world.ts: users/alice/todo.md, users/alice/skills/mine.md,
 * users/bob/notes.md, the finance budget, the finance group's skill, the marketing salaries, the marketing brief, the
 * falcon plan), and two that are a file's NAME (in users/alice/ and the finance folder) */
const FILE_TEXT: readonly string[] = [C.aliceFile, C.aliceSkill, C.bobFile, C.finFile, C.finSkill, C.salary, C.mktBrief, C.falconPlan]
const FILE_NAME: readonly string[] = [C.aliceFileName, C.finName]

export interface LookupCase {
  who: Who
  label: string
  queries: string[]
  o?: LookupOptions
  /** a canary this person may read: the answer must hold it (the case is not passing on an empty index) */
  mustFind?: string
}
/** lookup() as the person with this sign-in id */
export type LookupAs = (userId: string, queries: string[], o?: LookupOptions) => Promise<LookupResult>

/** Every signed-in persona × every file canary: one wording, two wordings, the Files search's call (short hits only),
 * and inside the folder that holds a part hidden from them (`base`). */
export function lookupCases(w: World): LookupCase[] {
  const out: LookupCase[] = []
  const all = [...FILE_TEXT, ...FILE_NAME]
  for (const who of WHO) {
    if (!USER_OF[who]) continue
    for (const q of all) {
      const mustFind = FILE_TEXT.includes(q) && VISIBLE[who].includes(q) ? q : undefined
      out.push({ who, label: `${who}: ${q}`, queries: [q], ...(mustFind ? { mustFind } : {}) })
      out.push({ who, label: `${who}: ${q} + another wording`, queries: [`what does ${q} say`, all[(all.indexOf(q) + 3) % all.length]!] })
      out.push({ who, label: `${who}: ${q}, short hits (the Files search)`, queries: [q], o: { long: 0, short: 20 } })
    }
    out.push({ who, label: `${who}: inside ${w.groups.mktFolder}`, queries: [`${C.salary} ${C.mktBrief}`], o: { base: w.groups.mktFolder } })
    out.push({ who, label: `${who}: inside users/`, queries: [`${C.aliceFile} ${C.bobFile}`], o: { base: 'users' } })
    out.push({ who, label: `${who}: everything at once`, queries: [FILE_TEXT.join(' '), FILE_NAME.join(' ')] })
  }
  return out
}

/** The problems of one case (empty: it passes): a canary hidden from the person anywhere in the answer, or one they
 * may read missing from it. */
export async function judgeLookup(k: LookupCase, lookupAs: LookupAs): Promise<string[]> {
  const r = await lookupAs(USER_OF[k.who]!, k.queries, k.o)
  const text = JSON.stringify({ passages: r.passages, strength: r.strength, files: [...r.files] })
  const problems: string[] = []
  const l = leaks(k.who, text)
  if (l.length) problems.push(`lookup() shows canaries hidden from ${k.who}: ${l.join(', ')}`)
  if (k.mustFind && !text.includes(k.mustFind)) problems.push(`lookup() did not find ${k.mustFind}, which ${k.who} may read`)
  return problems
}
