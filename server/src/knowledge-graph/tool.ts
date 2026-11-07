// The AI's knowledge_explore tool (docs/KNOWLEDGE-GRAPH.md): passages of the team's documents, the documents linked to
// them, and code with what calls what, from the knowledge graph's indexes. Offered while either part is on (documents:
// on by default; code: with CodeGraph); not in confidential chats (safe-ops/confidential.ts keeps those to the local
// file tools) nor restricted drafts.
//
// What it may show is decided at the question, file by file, by authorize(read) for the person asking (service.ts
// explore, whose document part is lookup's): the indexes hold whole folders, the answers only what that person may read
// now. Each file it names joins the chat's read scope like a read would (TurnFiles.readPaths), and what it shows is the
// answer's sources.
//
// The answer: up to LOOKUP_LONG passages of about LOOKUP_LONG_CHARS to answer from, then about LOOKUP_SHORT short
// labelled matches, the related documents and the code, at most TOOL_TOKENS_MAX estimated tokens in all (tokens.ts:
// Korean takes about a token per character, English about a quarter), so the AI can answer from the passages without
// reading and searching again.
import { z } from 'zod'
import type { AppContext } from '../context'
import { authorize } from '../policy/authorize'
import type { ToolRegistry } from '../tools/registry'
import { locLabel, sourceLink } from '../files/locations'
import { personLocale } from '../files/media-text'
import { knowledgeGraphOf, type ExploreHit, type ExploreRelated, type ExploreResult, type LookupPassage } from './service'
import { estimateTokens, fitTokens } from './tokens'

export const KNOWLEDGE_EXPLORE = 'knowledge_explore'

export const KnowledgeExploreInput = z.object({
  query: z.string().min(2).max(300).describe('What to find, in words or names: "where the order total is computed", "refund policy", "useAuth"'),
  alt_query: z.string().min(2).max(300).optional().describe('The same question in other words or another language, e.g. English for a Korean question; both are searched'),
  path: z.string().max(500).optional().describe('Only this folder (team path, e.g. "projects/web-app"); default: every folder the user can read'),
  limit: z.number().int().min(1).max(20).default(8).describe('How many functions, classes and other symbols (default 8)'),
})

/** the answer when nothing is found, the same whether or not anything is indexed (F1) */
export const NOTHING_FOUND = 'Nothing in the indexed documents or code matches, or nothing is indexed there yet. If the documents may be in another language, search again with alt_query in that language (Korean or English); look at file names with glob, and use grep for exact text.'

/** the whole answer's size in estimated tokens */
export const TOOL_TOKENS_MAX = 6_000
/** one passage to answer from, and one short match, in estimated tokens: an English passage of LOOKUP_LONG_CHARS is
 * about 400 and stays whole; a Korean one is cut to about 1,000 characters with its spaces, so three of them and the
 * short matches still leave room for the rest */
export const LONG_TOKENS = 900
export const SHORT_TOKENS = 150

export const KNOWLEDGE_EXPLORE_DESCRIPTION =
  "Search the team's documents and code in one call. Give the question in words or names (any language), and alt_query: " +
  'the same question in other words or another language (e.g. English for a Korean question). Returns up to 3 passages of ' +
  'documents (PDF, Word, Excel, PowerPoint, Hangul, text and more) to answer from, each with its file, page or section and ' +
  'a link, shorter matches after them, the documents linked to them and why, and matching functions and classes with ' +
  'their lines and what calls them, only from files the user can read. Answer from the passages when they are enough and ' +
  'cite their links; read a file only for more than they show. Use grep for exact text.'

type Lang = Parameters<typeof locLabel>[1]
const where = (x: LookupPassage, lang: Lang) => (x.loc ? ` · ${locLabel(x.loc, lang)}` : '')
const indent = (s: string) => s.split('\n').map((l) => (l ? `   ${l}` : '')).join('\n')

/** `text` within `budget` estimated tokens, with a mark when it was cut */
const fit = (text: string, budget: number) => { const t = fitTokens(text, budget - 1); return t.length < text.length ? t.trimEnd() + ' …' : t }
/** a passage to answer from: its lines as they are in the document */
const longText = (x: LookupPassage, n: number, lang: Lang, link: string) =>
  [`${n}. ${x.path}${where(x, lang)}`, `   link: ${link}`, indent(fit(x.text.replace(/[^\S\n]+\n/g, '\n').trim(), LONG_TOKENS))].join('\n')
/** a short labelled match: one line of text */
const shortText = (x: LookupPassage, n: number, lang: Lang, link: string) =>
  [`${n}. ${x.path}${where(x, lang)}`, `   link: ${link}`, `   ${fit(x.text.replace(/\s+/g, ' ').trim(), SHORT_TOKENS)}`].join('\n')
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

/**
 * The tool's text for an explore result, at most `max` estimated tokens (tokens.ts): the passages to answer from (each
 * at most LONG_TOKENS), the short matches (SHORT_TOKENS), the related documents and the code, in that order, each item
 * whole or not at all (a note says when some were left out). Returns what it shows, for the sources.
 */
export function exploreText(r: Pick<ExploreResult, 'passages' | 'related' | 'hits' | 'pending'>, lang: Lang, max = TOOL_TOKENS_MAX):
  { text: string; passages: LookupPassage[]; related: ExploreRelated[]; hits: ExploreHit[] } {
  const note = r.pending ? `\n(${r.pending} folders are still being indexed; grep finds exact text in them now)` : ''
  const CUT = '\n\n(More matches were left out to keep this short: ask again with path or a narrower question.)'
  const room = max - estimateTokens(note) - estimateTokens(CUT)
  const shown = { passages: [] as LookupPassage[], related: [] as ExploreRelated[], hits: [] as ExploreHit[] }
  const sections: string[] = []
  let used = 0, cut = false
  /** one section: its heading, then items while they fit */
  const section = <T>(head: string, items: T[], render: (x: T, i: number) => string, keep: T[], sep = '\n\n') => {
    if (cut || !items.length) return
    const parts: string[] = []
    for (const [i, x] of items.entries()) {
      const s = render(x, i)
      const add = estimateTokens((parts.length ? sep : (sections.length ? '\n\n' : '') + head + '\n') + s)
      if (used + add > room) { cut = true; break }
      used += add
      parts.push(s)
      keep.push(x)
    }
    if (parts.length) sections.push(`${head}\n${parts.join(sep)}`)
  }
  const long = r.passages.filter((x) => x.long), short = r.passages.filter((x) => !x.long)
  section('Documents:', long, (x, i) => longText(x, i + 1, lang, sourceLink(x.path, x.loc, lang)), shown.passages)
  section('More matches:', short, (x, i) => shortText(x, long.length + i + 1, lang, sourceLink(x.path, x.loc, lang)), shown.passages)
  section('Related documents:', r.related, relatedLine, shown.related, '\n')
  section('Code:', r.hits, (h, i) => hitText(h, i, sourceLink(h.path, null, lang)), shown.hits)
  // one wording whether or not anything is indexed: which of the two it was could tell the person that a folder they
  // can only partly see holds documents or code in the part hidden from them (security review F1)
  const text = sections.length ? sections.join('\n\n') + (cut ? CUT : '') + note : `${NOTHING_FOUND}${note}`
  return { text: fitTokens(text, max), ...shown }
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
      const r = await kg.explore(t.user, a.query, { base, limit: a.limit, alt: a.alt_query })
      // every file named joins the read scope (also one left out of the text for its size: the narrower scope is the safe side)
      for (const p of r.files) t.files.readPaths.add(p)
      const lang = personLocale(ctx.db, t.user.id)
      const out = exploreText(r, lang)
      for (const x of out.passages) t.files.sources.note(x.path, 'search', { agent: t.files.agent, locs: [x.loc] })
      for (const h of out.hits) t.files.sources.note(h.path, 'search', { agent: t.files.agent })
      return {
        text: out.text,
        summary: `${KNOWLEDGE_EXPLORE} q(len=${a.query.length})${a.alt_query ? ` alt(len=${a.alt_query.length})` : ''}${base ? ' in ' + base : ''} -> ${out.passages.length} passages (${r.strength}), ${out.related.length} related, ${out.hits.length} symbols${r.pending ? `, ${r.pending} pending` : ''}`,
        structured: {
          passages: out.passages.map((x) => ({ path: x.path, ...(x.loc ? { loc: x.loc } : {}), long: x.long })),
          related: out.related.map((x) => ({ path: x.path, from: x.from, reason: x.reason })),
          hits: out.hits.map((h) => ({ path: h.path, kind: h.kind, name: h.name, line: h.line, endLine: h.endLine, callers: h.callers, callees: h.callees })),
        },
      }
    },
  })
}
