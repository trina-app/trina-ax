// Route module "intro-deck" (docs/DECISIONS.md "D2 — The first result is the company's intro deck"). Implements
// INTRO_DECK (shared/src/api/intro-deck.ts): an intro deck's info and its PowerPoint and PDF files, for the owner of
// the chat it is in.
import { API } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { buildSlideFile, listBuilds } from '../intro-deck/build'
import { introDeckInfo, introDeckPdf, introDeckPptx } from '../intro-deck/files'
import { streamFile } from '../team-files/download'
import type { RouteModule } from './module'

export const introDeckRoutes: RouteModule = {
  name: 'intro-deck',
  owner: 'B',
  register(kit, ctx) {
    // the builds first: "/api/intro-decks/builds" must not be read as a deck id
    kit.handle(API.listDeckBuilds, ({ query, auth }) => ({ builds: listBuilds(ctx, auth.user.id, query.chatId) }))
    kit.handle(API.deckBuildSlide, ({ params, auth, c }) => {
      const abs = buildSlideFile(ctx, auth.user.id, params.id, Number(params.n))
      if (!abs) throw new HttpError('not_found')
      return streamFile({ abs, name: `slide-${params.n}.png`, req: c.req.raw, disposition: 'inline', via: c.get('info')?.via })
    })
    kit.handle(API.getIntroDeck, ({ params, auth }) => introDeckInfo(ctx, auth.user.id, params.id))
    kit.handle(API.downloadIntroDeckPptx, async ({ params, auth, c }) => {
      const f = await introDeckPptx(ctx, auth.user.id, params.id)
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: 'attachment', via: c.get('info')?.via })
    })
    kit.handle(API.downloadIntroDeckPdf, async ({ params, auth, c }) => {
      const f = await introDeckPdf(ctx, auth.user.id, params.id)
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: 'attachment', via: c.get('info')?.via })
    })
  },
}
