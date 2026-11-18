// Route module "link-names" (docs/decisions/20261118-named-app-links.md). Implements: LINK_NAMES
// (shared/src/api/link-names.ts: the names of links to things in this app, pasted into messages). Logic:
// server/src/link-names/resolve.ts. Every name is decided for the signed-in caller with the page's own check; no access
// and not there answer alike (name null). Registered after the chats and files modules (the chat runtime, the file
// links).
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { linkNames } from '../link-names/resolve'

export const linkNamesRoutes: RouteModule = {
  name: 'link-names',
  owner: 'B',
  register(kit, ctx) {
    kit.handle(API.linkNames, ({ c, auth, body }) => { c.header('Cache-Control', 'no-store'); return { items: linkNames(ctx, auth.user.id, body.links) } })
  },
}
