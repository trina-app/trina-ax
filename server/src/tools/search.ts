// The engine's "search" tool: team documents by meaning (server/src/search/semantic.ts), for questions whose words or
// file names the AI doesn't know ("where did we decide the refund policy?"). Results are passages of files the person
// can read (the same visibility check as grep); the AI reads the files it needs. Off unless MYCEL_SEMANTIC=on (not
// registered, no index, no model): on a folder of thousands of files it ranked unrelated passages first, used up to
// ~1.9 GB while indexing and took most cores for minutes (docs/DECISIONS.md, 2026-11-01). When on, it says so when the
// model can't run here; grep stays the tool for exact words.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context'
import { authorize, visiblePath } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { localEmbedder, SemanticIndex, type Embed } from '../search/semantic'
import type { ToolRegistry } from './registry'
import { installId } from '../admin/settings'
import { limitsActive } from '../system/limits'
import { sourceLabel, sourceLink } from '../files/locations'
import { personLocale } from '../files/media-text'

export const SearchInput = z.object({
  query: z.string().min(2).max(500).describe('What to find, in plain words (Korean or English), e.g. "the meeting where we decided the refund policy"'),
  path: z.string().max(500).optional().describe('Only this folder (team path, e.g. "shared/meetings"); default: everything the user can read'),
  limit: z.number().int().min(1).max(20).default(8).describe('How many passages (default 8)'),
})

const SNIPPET = 400
const REFRESH_MS = 3000
const BACKGROUND_EVERY_MS = 5 * 60_000
/** a background run's time; while older pieces are being made again (the one-time re-index after an update) the next
 * run starts after a pause as long as the run itself, so the re-index takes at most half the time of this server */
const BACKGROUND_BUDGET_MS = 60_000
const REINDEX_PAUSE_MIN_MS = 10_000

/** The first background indexing after a start: 20 s as before; where the limits apply (Linux, a plan: many teams on one
 * host restart together after an update) 10 minutes plus 0–5 minutes from the install id. */
export function firstRefreshMs(id: string): number {
  if (!limitsActive()) return 20_000
  return 10 * 60_000 + (createHash('sha256').update(id).digest().readUInt16BE(0) % 300) * 1000
}

export function semanticEnabled(): boolean {
  return process.env.MYCEL_SEMANTIC === 'on'
}

/** tests: an embedder in place of the local model for the apps made after this call (null: the model again) */
let testEmbedder: Embed | null = null
export function setSearchEmbedderForTests(e: Embed | null) { testEmbedder = e }

/** Registers the search tool and, outside tests, keeps the index up to date in the background. */
export function registerSearch(ctx: AppContext, reg: ToolRegistry): boolean {
  if (!semanticEnabled()) return false
  const dataDir = ctx.engineConfig.dataDir
  // a host's read-only model folder ($MYCEL_MODELS_DIR/semantic, the hosted cloud) is used when it matches; else <data>/models
  const shared = process.env.MYCEL_MODELS_DIR ? path.join(process.env.MYCEL_MODELS_DIR, 'semantic') : null
  const fixed = testEmbedder
  const embedder = fixed ? Object.assign(async () => fixed, { loaded: () => true, checkIdle: async () => false, unload: async () => {} }) : localEmbedder(path.join(dataDir, 'models'), ctx.log, { sharedDir: shared })
  const index = new SemanticIndex({ dataDir, root: ctx.files.fx.root, office: ctx.files.office, embedder, quarantine: ctx.files.quarantine })
  ctx.onClose(() => { index.db.close(); void embedder.unload() })
  if (process.env.NODE_ENV !== 'test') {
    let soon: ReturnType<typeof setTimeout> | null = null
    let ticking = false
    let closed = false
    const tick = async () => {
      if (ticking || closed) return
      ticking = true
      const t0 = Date.now()
      try {
        const r = await index.refresh(BACKGROUND_BUDGET_MS, { background: true })
        // the re-index of older pieces (and a backlog of new files) goes on after a pause as long as this run took
        if ((r.upgrading > 0 || r.pending > 0) && !closed && !soon) {
          soon = setTimeout(() => { soon = null; void tick() }, Math.max(REINDEX_PAUSE_MIN_MS, Date.now() - t0))
          soon.unref?.()
        }
        if (r.upgrading === 0 && upgradingAtStart > 0 && !reported) { reported = true; ctx.log.info('semantic index: older pieces made again', { files: upgradingAtStart, ms: Date.now() - startedAt }) }
      } catch (e) { ctx.log.warn('semantic index refresh failed', { err: String(e) }) } finally { ticking = false }
    }
    const startedAt = Date.now()
    const upgradingAtStart = index.upgrading()
    let reported = false
    if (upgradingAtStart) ctx.log.info('semantic index: older pieces will be made again in the background', { files: upgradingAtStart })
    const first = setTimeout(() => void tick(), firstRefreshMs(installId(ctx.db)))
    const every = setInterval(() => void tick(), BACKGROUND_EVERY_MS)
    first.unref?.(); every.unref?.()
    ctx.onClose(() => { closed = true; clearTimeout(first); clearInterval(every); if (soon) clearTimeout(soon) })
  }
  reg.register({
    name: 'search',
    description: 'Find team documents by meaning (Korean or English) when you don\'t know the exact words or file names. ' +
      'Returns the closest passages with their file paths and places (page, sheet range, slide or section) and a link to each place, only from files the user can read; read a file for its full text. ' +
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
      for (const h of hits) {
        t.files.readPaths.add(h.path)
        t.files.sources.note(h.path, 'search', { agent: t.files.agent, locs: [h.loc], sha256: h.hash || null })
      }
      const lang = personLocale(ctx.db, t.user.id)
      const note = pending ? `\n(${pending} recently changed files are still being indexed; grep finds exact words in them now)` : ''
      // "1. 매출보고서.pdf · p.12 — finance/매출보고서.pdf (match 0.83)", a link the answer can use as it is, the passage
      const text = hits.length
        ? hits.map((h, i) => `${i + 1}. ${sourceLabel(h.path, h.loc, lang)} — ${h.path} (match ${h.score.toFixed(2)})\n   link: ${sourceLink(h.path, h.loc, lang)}\n${h.text.slice(0, SNIPPET).replace(/^/gm, '   ')}`).join('\n\n') + note
        : `No indexed documents match.${note}`
      return { text, summary: `search q(len=${a.query.length})${base ? ' in ' + base : ''} -> ${hits.length} passages${pending ? `, ${pending} pending` : ''}`, structured: { hits: hits.map((h) => ({ path: h.path, score: h.score, ...(h.loc ? { loc: h.loc } : {}) })) } }
    },
  })
  return true
}
