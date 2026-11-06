// The AI's knowledge_explore tool (docs/KNOWLEDGE-GRAPH.md): code, functions and how they connect, from the knowledge
// graph's indexes. Offered only while the knowledge graph is on (CodeGraph here and an admin did not turn it off); not
// in confidential chats (safe-ops/confidential.ts keeps those to the local file tools).
//
// What it may show is decided at the question, file by file, by authorize(read) for the person asking (service.ts
// explore): the indexes hold whole folders, the answers only what that person may read now. Each file it names joins
// the chat's read scope like a read would (TurnFiles.readPaths), and the hits are the answer's sources.
import { z } from 'zod'
import type { AppContext } from '../context'
import { authorize } from '../policy/authorize'
import type { ToolRegistry } from '../tools/registry'
import { sourceLink } from '../files/locations'
import { personLocale } from '../files/media-text'
import { knowledgeGraphOf, type ExploreHit } from './service'

export const KNOWLEDGE_EXPLORE = 'knowledge_explore'

export const KnowledgeExploreInput = z.object({
  query: z.string().min(2).max(300).describe('What to find, in words or names: "where the order total is computed", "checkout", "useAuth"'),
  path: z.string().max(500).optional().describe('Only this folder (team path, e.g. "projects/web-app"); default: every folder the user can read'),
  limit: z.number().int().min(1).max(20).default(8).describe('How many functions, classes and other symbols (default 8)'),
})

export const KNOWLEDGE_EXPLORE_DESCRIPTION =
  "Find code, functions and how things connect across the team's files. Give words or names; returns the matching functions, " +
  'classes and other symbols with their file path and lines, their first lines of code, and what calls them and what they call, ' +
  'only from files the user can read. Cite the paths; read a file for its full code. Use grep for exact text.'

const refLine = (r: { name: string; filePath: string; startLine: number }) => `${r.name} (${r.filePath}:${r.startLine})`

function hitText(h: ExploreHit, i: number, link: string): string {
  const out = [`${i + 1}. ${h.kind} ${h.name} — ${h.path}:${h.line}${h.endLine > h.line ? `-${h.endLine}` : ''}`, `   link: ${link}`]
  if (h.signature) out.push(`   signature: ${h.signature.replace(/\s+/g, ' ').slice(0, 200)}`)
  if (h.callers.length) out.push(`   called by: ${h.callers.map(refLine).join('; ')}`)
  if (h.callees.length) out.push(`   calls: ${h.callees.map(refLine).join('; ')}`)
  if (h.snippet) out.push(h.snippet)
  return out.join('\n')
}

/** Registers knowledge_explore. Offered while the knowledge graph is on. */
export function registerKnowledgeExplore(ctx: AppContext, reg: ToolRegistry): void {
  const kg = knowledgeGraphOf(ctx)
  reg.register({
    name: KNOWLEDGE_EXPLORE,
    description: KNOWLEDGE_EXPLORE_DESCRIPTION,
    input: KnowledgeExploreInput,
    available: () => kg.enabled(),
    describe: (a) => `${KNOWLEDGE_EXPLORE}${a.path ? ' ' + a.path : ''}`,
    async run(a, t) {
      const rules = ctx.files.rules()
      // the folder as for search: the person must be able to read it (a hidden one answers "not found or no access")
      const base = a.path ? authorize(ctx.files.fx, rules, t.user, a.path, 'read').rel || undefined : undefined
      const r = await kg.explore(t.user, a.query, { base, limit: a.limit })
      for (const p of r.files) t.files.readPaths.add(p)
      for (const h of r.hits) t.files.sources.note(h.path, 'search', { agent: t.files.agent })
      const lang = personLocale(ctx.db, t.user.id)
      const note = r.pending ? `\n(${r.pending} folders are still being indexed; grep finds exact text in them now)` : ''
      const text = r.hits.length
        ? r.hits.map((h, i) => hitText(h, i, sourceLink(h.path, null, lang))).join('\n\n') + note
        : r.indexed ? `No indexed code matches.${note}` : `No code is indexed in the folders this user can read yet.${note || ' Use grep and read.'}`
      return {
        text,
        summary: `${KNOWLEDGE_EXPLORE} q(len=${a.query.length})${base ? ' in ' + base : ''} -> ${r.hits.length} symbols${r.pending ? `, ${r.pending} pending` : ''}`,
        structured: { hits: r.hits.map((h) => ({ path: h.path, kind: h.kind, name: h.name, line: h.line, endLine: h.endLine, callers: h.callers, callees: h.callees })) },
      }
    },
  })
}
