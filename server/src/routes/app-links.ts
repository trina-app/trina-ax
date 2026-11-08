// The two public files that let a tapped team link open the phone app (shared/src/app-links.ts): Apple's
// apple-app-site-association and Android's assetlinks.json. No sign-in, no cookie, no redirect; JSON. Off the API
// contract (they are the platforms' formats), like the OAuth metadata in remote-mcp.ts.
import { appleAppSiteAssociation, assetLinks } from '@mycel/shared/app-links'
import type { RouteModule } from './module'

const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }

export const appLinksRoutes: RouteModule = {
  name: 'app-links', owner: 'G',
  register(kit) {
    kit.raw('GET', '/.well-known/apple-app-site-association', () => new Response(JSON.stringify(appleAppSiteAssociation()), { status: 200, headers }))
    kit.raw('GET', '/.well-known/assetlinks.json', () => {
      const body = assetLinks()
      return body ? new Response(JSON.stringify(body), { status: 200, headers }) : new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    })
  },
}
