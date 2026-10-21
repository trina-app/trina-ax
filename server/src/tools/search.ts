// The engine's "search" tool: team documents by meaning (server/src/search/semantic.ts), for questions whose words or
// file names the AI doesn't know ("where did we decide the refund policy?"). Results are passages of files the person
// can read (the same visibility check as grep); the AI reads the files it needs. Not registered when it is off
// (MYCEL_SEMANTIC=off), and it says so when the model can't run here; grep stays the tool for exact words.
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context'
import { authorize, visiblePath } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { localEmbedder, SemanticIndex } from '../search/semantic'
import type { ToolRegistry } from './registry'

export const SearchInput = z.object({
  query: z.string().min(2).max(500).describe('What to find, in plain words (Korean or English), e.g. "the meeting where we decided the refund policy"'),
  path: z.string().max(500).optional().describe('Only this folder (team path, e.g. "shared/meetings"); default: everything the user can read'),
  limit: z.number().int().min(1).max(20).default(8).describe('How many passages (default 8)'),
})

const SNIPPET = 400
const REFRESH_MS = 3000
const BACKGROUND_EVERY_MS = 5 * 60_000

export function semanticEnabled(): boolean {
  return process.env.MYCEL_SEMANTIC !== 'off'
}

/** Registers the search tool and, outside tests, keeps the index up to date in the background. */
export function registerSearch(ctx: AppContext, reg: ToolRegistry): boolean {
  if (!semanticEnabled()) return false
  const dataDir = ctx.engineConfig.dataDir
  const index = new SemanticIndex({ dataDir, root: ctx.files.fx.root, office: ctx.files.office, embedder: localEmbedder(path.join(dataDir, 'models'), ctx.log) })
  ctx.onClose(() => index.db.close())
  if (process.env.NODE_ENV !== 'test') {
    const tick = () => { void index.refresh(60_000).catch((e) => ctx.log.warn('semantic index refresh failed', { err: String(e) })) }
    const first = setTimeout(tick, 20_000)
    const every = setInterval(tick, BACKGROUND_EVERY_MS)
    first.unref?.(); every.unref?.()
    ctx.onClose(() => { clearTimeout(first); clearInterval(every) })
  }
  reg.register({
    name: 'search',
    description: 'Find team documents by meaning (Korean or English) when you don\'t know the exact words or file names. ' +
      'Returns the closest passages with their file paths, only from files the user can read; read a file for its full text. ' +
      'Use grep for exact words, names or numbers.',
    input: SearchInput,
    describe: (a) => `search${a.path ? ' ' + a.path : ''}`,
    async run(a, t) {
      const rules = ctx.files.rules()
      const base = a.path ? authorize(ctx.files.fx, rules, t.user, a.path, 'read').rel : ''
      const inBase = (p: string) => !base || p === base || p.startsWith(base + '/')
      const { pending } = await index.refresh(REFRESH_MS)
      const hits = await index.query(a.query, (p) => inBase(p) && !!visiblePath(ctx.files.fx, rules, t.user, p), a.limit)
      if (!hits) throw new ToolError('search by meaning is not available on this server (the model could not load); use grep')
      for (const h of hits) t.files.readPaths.add(h.path)
      const note = pending ? `\n(${pending} recently changed files are still being indexed; grep finds exact words in them now)` : ''
      const text = hits.length
        ? hits.map((h, i) => `${i + 1}. ${h.path} (match ${h.score.toFixed(2)})\n${h.text.slice(0, SNIPPET).replace(/^/gm, '   ')}`).join('\n\n') + note
        : `No indexed documents match.${note}`
      return { text, summary: `search q(len=${a.query.length})${base ? ' in ' + base : ''} -> ${hits.length} passages${pending ? `, ${pending} pending` : ''}`, structured: { hits: hits.map((h) => ({ path: h.path, score: h.score })) } }
    },
  })
  return true
}
