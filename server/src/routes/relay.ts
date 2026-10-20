// Route module "relay" — owner: component F (docs/WORKPLAN.md).
// No HTTP endpoints of its own: init() starts the relay client (server/src/relay-client/*) when config.relay.url is
// set, installs ctx.services.relay (status for GET /api/admin/connection), and forwards relayed requests with
// ctx.appFetch(req, { ip: <OPEN-frame ip>, via: 'relay' }).
import type { RouteModule } from './module'

export const relayRoutes: RouteModule = {
  name: 'relay',
  owner: 'F',
  register(_kit, _ctx) {
    // Component F: nothing to register; start the relay client in init().
  },
}
