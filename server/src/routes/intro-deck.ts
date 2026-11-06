// Route module "intro-deck" (docs/DECISIONS.md "D2 — The first result is the company's intro deck"). Implements
// INTRO_DECK (shared/src/api/intro-deck.ts): an intro deck's info and its PowerPoint and PDF files, for the owner of
// the chat it is in.
import { API } from '@mycel/shared/api'
import { introDeckInfo, introDeckPdf, introDeckPptx } from '../intro-deck/files'
import { streamFile } from '../team-files/download'
import type { RouteModule } from './module'

export const introDeckRoutes: RouteModule = {
  name: 'intro-deck',
  owner: 'B',
  register(kit, ctx) {
    kit.handle(API.getIntroDeck, ({ params, auth }) => introDeckInfo(ctx, auth.user.id, params.id))
    kit.handle(API.downloadIntroDeckPptx, ({ params, auth, c }) => {
      const f = introDeckPptx(ctx, auth.user.id, params.id)
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: 'attachment' })
    })
    kit.handle(API.downloadIntroDeckPdf, async ({ params, auth, c }) => {
      const f = await introDeckPdf(ctx, auth.user.id, params.id)
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: 'attachment' })
    })
  },
}
