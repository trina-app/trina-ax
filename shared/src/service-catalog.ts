// The app's list of known services (the "Discover" list of Connectors): each service's own name and its official MCP
// address. Every one is an MCP server that signs in with OAuth (dynamic client registration), as the list's entries
// answered on 2026-11-02 (docs/INTEGRATIONS.md "Discover"). The web adds its logos and descriptions
// (web/src/lib/connectors.ts); the server uses the same list so that the AI's connect card for a known service always
// goes to the official address (server/src/chat/connect-service.ts, docs/DECISIONS.md "The chat's connect card trusts
// the app's list"). One list, here only.
export const SERVICE_CATALOG = [
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp' },
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp' },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp' },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com/' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp' },
  { id: 'higgsfield', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp' },
  { id: 'ahrefs', name: 'Ahrefs', url: 'https://api.ahrefs.com/mcp/mcp' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp' },
  { id: 'brex', name: 'Brex', url: 'https://api.brex.com/mcp' },
  { id: 'calendly', name: 'Calendly', url: 'https://mcp.calendly.com' },
  { id: 'clickup', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp' },
  { id: 'cloudinary', name: 'Cloudinary', url: 'https://asset-management.mcp.cloudinary.com/mcp' },
  { id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/api/v4/mcp' },
  { id: 'indeed', name: 'Indeed', url: 'https://mcp.indeed.com/claude/mcp' },
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp' },
  { id: 'mermaid', name: 'Mermaid Chart', url: 'https://mcp.mermaid.ai/mcp' },
  { id: 'mintlify', name: 'Mintlify', url: 'https://mcp.mintlify.com' },
  { id: 'monday', name: 'Monday', url: 'https://mcp.monday.com/mcp' },
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp' },
  { id: 'netlify', name: 'Netlify', url: 'https://netlify-mcp.netlify.app/mcp' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://mcp.openrouter.ai/mcp' },
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp' },
  { id: 'planetscale', name: 'PlanetScale', url: 'https://mcp.pscale.dev/mcp/planetscale' },
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  { id: 'postman', name: 'Postman', url: 'https://mcp.postman.com/mcp' },
  { id: 'railway', name: 'Railway', url: 'https://mcp.railway.com' },
  { id: 'razorpay', name: 'Razorpay', url: 'https://mcp.razorpay.com/mcp' },
  { id: 'resend', name: 'Resend', url: 'https://mcp.resend.com/mcp' },
  { id: 'sanity', name: 'Sanity', url: 'https://mcp.sanity.io' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/mcp' },
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com/' },
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp' },
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp' },
  { id: 'wordpress', name: 'WordPress.com', url: 'https://public-api.wordpress.com/wpcom/v2/mcp/v1' },
] as const

export type CatalogService = (typeof SERVICE_CATALOG)[number]
export type CatalogServiceId = CatalogService['id']
/** how every listed service connects */
export const CATALOG_KIND = 'mcp' as const
export const CATALOG_AUTH = 'oauth' as const

/** The same service, whatever the spelling of its address: host and path, in lower case, without a trailing slash
 * (no scheme, query or fragment). */
export function canonicalService(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

/** The listed service at this address, if it is one's official address. */
export function catalogAt(url: string): CatalogService | undefined {
  const key = canonicalService(url)
  return SERVICE_CATALOG.find((c) => canonicalService(c.url) === key)
}

/** words a name can carry around a service's own name and still mean that service ("Notion MCP", "the Notion app") */
const FILLER = new Set(['mcp', 'server', 'app', 'api', 'official', 'the', 'connector', 'integration', 'com', 'my'])
const words = (s: string) => s.normalize('NFKC').toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? []
/** a listed service's name and id, as the joined words they are compared by ("clickup", "mermaidchart", "mermaid") */
const namesOf = (c: CatalogService) => [...new Set([words(c.name).filter((w) => !FILLER.has(w)).join(''), c.id])]

/**
 * Which listed service a name means, as the AI wrote it:
 * - `exact`: the name is that service's own ("Notion", "notion", "Notion MCP", "ClickUp", "Click Up", "WordPress").
 * - `contains`: the name holds it among other words ("Notion workspace", "Acme GitLab"). A card under such a name at
 *   another address would read as that service's, so it is not offered there.
 * Undefined: the name names no listed service.
 */
export function catalogNamed(name: string): { service: CatalogService; exact: boolean } | undefined {
  const all = words(name)
  const core = all.filter((w) => !FILLER.has(w)).join('')
  let contains: CatalogService | undefined
  for (const c of SERVICE_CATALOG) {
    const names = namesOf(c)
    if (core && names.includes(core)) return { service: c, exact: true }
    // any run of the name's words, joined, that is the service's name ("Click Up Tasks" holds "clickup")
    if (!contains) {
      outer: for (let i = 0; i < all.length; i++) {
        let joined = ''
        for (let j = i; j < all.length; j++) {
          joined += all[j]
          if (names.includes(joined)) { contains = c; break outer }
          if (joined.length > 40) break
        }
      }
    }
  }
  return contains ? { service: contains, exact: false } : undefined
}
