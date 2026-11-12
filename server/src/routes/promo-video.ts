// Route module "promo-video" (docs/DECISIONS.md "V — The first result is the company's promo video"). Implements
// PROMO_VIDEO (shared/src/api/promo-video.ts): a promo video's state and its MP4, for the owner of the chat it is in.
import { API } from '@mycel/shared/api'
import { promoVideoFile, promoVideoInfo, renderPromoVideo } from '../promo-video/render'
import { streamFile } from '../team-files/download'
import type { RouteModule } from './module'

export const promoVideoRoutes: RouteModule = {
  name: 'promo-video',
  owner: 'B',
  register(kit, ctx) {
    kit.handle(API.getPromoVideo, ({ params, auth }) => promoVideoInfo(ctx, auth.user.id, params.id))
    kit.handle(API.renderPromoVideo, ({ params, auth }) => renderPromoVideo(ctx, auth.user.id, params.id))
    kit.handle(API.downloadPromoVideo, ({ params, auth, c }) => {
      const f = promoVideoFile(ctx, auth.user.id, params.id)
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: 'attachment', via: c.get('info')?.via })
    })
  },
}
