// Route module "relay" — owner: component F (docs/WORKPLAN.md).
// No HTTP endpoints of its own: init() starts the relay client (server/src/relay-client/*) when config.relay.url is
// set, installs ctx.services.relay (status for GET /api/admin/connection), and forwards relayed requests with
// ctx.appFetch(req, { ip: <OPEN-frame ip>, via: 'relay' }).
import { startRelayClient } from '../relay-client'
import type { RouteModule } from './module'

export const relayRoutes: RouteModule = {
  name: 'relay',
  owner: 'F',
  init(ctx) {
    const relay = startRelayClient(ctx)
    ctx.services.relay = relay
    ctx.onClose(() => relay.stop())
  },
  register(_kit, _ctx) {
    // nothing to register: relayed requests enter through ctx.appFetch, relayed WebSockets through the realtime hub
  },
}
