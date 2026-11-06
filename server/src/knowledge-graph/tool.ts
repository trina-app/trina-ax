// The AI's knowledge_explore tool (docs/KNOWLEDGE-GRAPH.md): passages of the team's documents, the documents linked to
// them, and code with what calls what, from the knowledge graph's indexes. Offered while either part is on (documents:
// on by default; code: with CodeGraph); not in confidential chats (safe-ops/confidential.ts keeps those to the local
// file tools) nor restricted drafts.
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
import { locLabel } from '../files/locations'
import { knowledgeGraphOf, type ExploreHit, type ExplorePassage, type ExploreRelated } from './service'

export const KNOWLEDGE_EXPLORE = 'knowledge_explore'

export const KnowledgeExploreInput = z.object({
  query: z.string().min(2).max(300).describe('What to find, in words or names: "where the order total is computed", "checkout", "useAuth"'),
  path: z.string().max(500).optional().describe('Only this folder (team path, e.g. "projects/web-app"); default: every folder the user can read'),
  limit: z.number().int().min(1).max(20).default(8).describe('How many functions, classes and other symbols (default 8)'),
})

export const KNOWLEDGE_EXPLORE_DESCRIPTION =
  "Find documents, code and how things connect across the team's files. Give words or names (any language); returns matching " +
  'passages of documents (PDF, Word, Excel, PowerPoint, Hangul, text and more) with the file, page or section and a link, the documents ' +
  'linked to them and why, and matching functions and classes with their lines and what calls them, only from files the user can read. ' +
  'Cite the paths; read a file for its full text. Use grep for exact text.'

function passageText(x: ExplorePassage, i: number, lang: Parameters<typeof locLabel>[1], link: string): string {
  const where = x.loc ? ` · ${locLabel(x.loc, lang)}` : ''
  return [`${i + 1}. ${x.path}${where}`, `   link: ${link}`, x.snippet.replace(/\s+\n/g, '\n').trim().split('\n').map((l) => `   ${l}`).join('\n')].join('\n')
}
const relatedLine = (r: ExploreRelated) => `- ${r.path} — ${r.reason.kind}${r.reason.detail ? `: ${r.reason.detail}` : ''} (linked to ${r.from})`

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
    available: () => kg.enabled() || kg.docsOn(),
    describe: (a) => `${KNOWLEDGE_EXPLORE}${a.path ? ' ' + a.path : ''}`,
    async run(a, t) {
      const rules = ctx.files.rules()
      // the folder as for search: the person must be able to read it (a hidden one answers "not found or no access")
      const base = a.path ? authorize(ctx.files.fx, rules, t.user, a.path, 'read').rel || undefined : undefined
      const r = await kg.explore(t.user, a.query, { base, limit: a.limit })
      for (const p of r.files) t.files.readPaths.add(p)
      for (const x of r.passages) t.files.sources.note(x.path, 'search', { agent: t.files.agent, locs: [x.loc] })
      for (const h of r.hits) t.files.sources.note(h.path, 'search', { agent: t.files.agent })
      const lang = personLocale(ctx.db, t.user.id)
      const note = r.pending ? `\n(${r.pending} folders are still being indexed; grep finds exact text in them now)` : ''
      const parts: string[] = []
      if (r.passages.length) parts.push('Documents:\n' + r.passages.map((x, i) => passageText(x, i, lang, sourceLink(x.path, x.loc, lang))).join('\n\n'))
      if (r.related.length) parts.push('Related documents:\n' + r.related.map(relatedLine).join('\n'))
      if (r.hits.length) parts.push('Code:\n' + r.hits.map((h, i) => hitText(h, i, sourceLink(h.path, null, lang))).join('\n\n'))
      const text = parts.length
        ? parts.join('\n\n') + note
        : r.indexed ? `Nothing in the indexed documents or code matches.${note}` : `Nothing is indexed yet in the folders this user can read.${note || ' Use grep and read.'}`
      return {
        text,
        summary: `${KNOWLEDGE_EXPLORE} q(len=${a.query.length})${base ? ' in ' + base : ''} -> ${r.passages.length} passages, ${r.related.length} related, ${r.hits.length} symbols${r.pending ? `, ${r.pending} pending` : ''}`,
        structured: {
          passages: r.passages.map((x) => ({ path: x.path, ...(x.loc ? { loc: x.loc } : {}) })),
          related: r.related.map((x) => ({ path: x.path, from: x.from, reason: x.reason })),
          hits: r.hits.map((h) => ({ path: h.path, kind: h.kind, name: h.name, line: h.line, endLine: h.endLine, callers: h.callers, callees: h.callees })),
        },
      }
    },
  })
}
