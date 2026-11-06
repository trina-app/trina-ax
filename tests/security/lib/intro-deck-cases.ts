// The intro deck's info and its PowerPoint and PDF files (docs/DECISIONS.md "D2"; server/src/intro-deck/files.ts):
// only the person whose chat holds the deck, never the team's owner or admins (a chat is its owner's alone). Alice's
// deck is a row of intro_decks on her artifact in chat A with both files already built, their bytes and the title
// carrying her artifact canary, so a 2xx to anyone else leaks it. A built file is given again as it is, so nothing is
// laid out or compiled here.
import fs from 'node:fs'
import path from 'node:path'
import type { Spec } from './cases'
import { C, type World } from './world'
import { pdfAvailable } from '../../../server/src/intro-deck/files'

/** alice's intro deck (made once, on the first case that needs it): its id */
function aliceDeck(w: World): string {
  const id = w.ids.artifact
  const ctx = w.inst.ctx
  const dir = path.join(ctx.engineConfig.dataDir, 'intro-decks')
  fs.mkdirSync(dir, { recursive: true })
  for (const ext of ['pptx', 'pdf']) {
    const file = path.join(dir, `${id}.${ext}`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${ext.toUpperCase()} ${C.aliceArtifact}`)
  }
  ctx.db.query("INSERT OR IGNORE INTO intro_decks (artifact_id, chat_id, user_id, spec, created_at) VALUES (?, ?, 'alice', ?, ?)")
    .run(id, w.ids.chatA, JSON.stringify({ title: `deck ${C.aliceArtifact}`, sources: [], doc: { theme: 'paper', slides: [] } }), new Date().toISOString())
  return id
}

/** The PDF is offered only where typst is (CI has none): for this request a stand-in path makes it available, so the
 * built file is given to alice and the check is the permission, not the tool. */
async function withPdf<T>(run: () => Promise<T>): Promise<T> {
  if (pdfAvailable()) return run()
  const prev = process.env.MYCEL_TYPST_BIN
  process.env.MYCEL_TYPST_BIN = process.execPath
  try { return await run() } finally { if (prev === undefined) delete process.env.MYCEL_TYPST_BIN; else process.env.MYCEL_TYPST_BIN = prev }
}

/** alice's deck being built in chat A (round 2): a build row whose title and first slide picture carry her canary */
function aliceBuild(w: World): string {
  const id = `build-${w.ids.artifact}`
  const ctx = w.inst.ctx
  const dir = path.join(ctx.engineConfig.dataDir, 'intro-decks', 'builds', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 's00.png'), `PNG ${C.aliceArtifact}`)
  ctx.db.query("INSERT OR IGNORE INTO intro_deck_builds (id, chat_id, turn_id, message_id, user_id, status, plan, state, started_at, outline_at) VALUES (?, ?, NULL, NULL, 'alice', 'building', ?, ?, ?, ?)")
    .run(id, w.ids.chatA, JSON.stringify({ title: `deck ${C.aliceArtifact}`, stubs: [{ kind: 'cover', section: 'cover', headline: C.aliceArtifact }], tier: 'quick', web: [] }),
      JSON.stringify({ slides: [{ kind: 'cover', headline: C.aliceArtifact }], accents: {}, treat: {}, tries: [1], notes: [[]], skipped: [], rev: [1], current: null, outlineTries: 1, findings: [], reviewed: false }),
      new Date().toISOString(), new Date().toISOString())
  return id
}

export const INTRO_DECK_SPECS: Record<string, Spec> = {
  listDeckBuilds: { build: (c, w) => { aliceBuild(w); return c.get(`/api/intro-decks/builds?chatId=${w.ids.chatA}`) }, scope: 'own-alice' },
  deckBuildSlide: { build: (c, w) => c.get(`/api/intro-decks/builds/${aliceBuild(w)}/slides/0`), scope: 'own-alice' },
  getIntroDeck: { build: (c, w) => c.get(`/api/intro-decks/${aliceDeck(w)}`), scope: 'own-alice' },
  downloadIntroDeckPptx: { build: (c, w) => c.get(`/api/intro-decks/${aliceDeck(w)}/pptx`), scope: 'own-alice' },
  downloadIntroDeckPdf: { build: (c, w) => withPdf(() => c.get(`/api/intro-decks/${aliceDeck(w)}/pdf`)), scope: 'own-alice' },
}
