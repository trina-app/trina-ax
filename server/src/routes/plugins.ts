// Admin > Plugins (contract shared/src/api/plugins.ts, docs/PLUGINS.md), registered by the files route module
// (component C). Owners and admins only (the endpoint auth level), CSRF and session checks as for every admin route;
// the install request must carry the manifest digest the admin was shown. Logic: server/src/plugins/manager.ts.
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { pluginsOf } from '../plugins/manager'

export function registerPluginRoutes(kit: RouteKit, ctx: AppContext) {
  const m = () => pluginsOf(ctx)
  kit.handle(API.listPlugins, ({ c }) => m().list(c.get('locale')))
  kit.handle(API.inspectPluginFile, async ({ c, auth, body }) => m().inspect(auth.user.id, new Uint8Array(await body.file.arrayBuffer()), 'file', c.get('locale')))
  kit.handle(API.inspectPluginSource, ({ c, auth, body }) => body.source === 'catalog'
    ? m().inspectCatalog(auth.user.id, body.id, c.get('locale'))
    : m().inspectImport(auth.user.id, body.name, c.get('locale')))
  kit.handle(API.installPlugin, ({ c, auth, body }) => m().install(auth.user.id, body, c.get('locale')))
  kit.handle(API.enablePlugin, ({ c, auth, params, body }) => m().enable(auth.user.id, params.id, body, c.get('locale')))
  kit.handle(API.disablePlugin, ({ c, auth, params }) => m().disable(auth.user.id, params.id, c.get('locale')))
  kit.handle(API.rollbackPlugin, ({ c, auth, params }) => m().rollback(auth.user.id, params.id, c.get('locale')))
  kit.handle(API.uninstallPlugin, ({ auth, params }) => { m().uninstall(auth.user.id, params.id) })
}
