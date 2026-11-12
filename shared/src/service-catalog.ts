// The app's list of known services (the "Discover" list of Connectors): each service's own name and its official MCP
// address. Every one is an MCP server that signs in with OAuth (dynamic client registration), as the list's entries
// answered on 2026-11-02 (docs/INTEGRATIONS.md "Discover"). The web adds its logos and descriptions
// (web/src/lib/connectors.ts); the server uses the same list so that the AI's connect card for a known service always
// goes to the official address (server/src/chat/connect-service.ts, docs/DECISIONS.md "The chat's connect card trusts
// the app's list"). One list, here only.
export const SERVICE_CATALOG = [
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', aliases: ['노션', 'ノーション'] },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', ambiguous: true, aliases: ['리니어'] },
  { id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', aliases: ['아틀라시안', 'jira', '지라', 'confluence', '컨플루언스'] },
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', aliases: ['캔바'] },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', aliases: ['피그마', 'フィグマ'] },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com/', ambiguous: true, aliases: ['스트라이프'] },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', aliases: ['수파베이스'] },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', aliases: ['클라우드플레어'] },
  { id: 'higgsfield', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', aliases: ['힉스필드'] },
  { id: 'ahrefs', name: 'Ahrefs', url: 'https://api.ahrefs.com/mcp/mcp' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', aliases: ['에어테이블'] },
  { id: 'brex', name: 'Brex', url: 'https://api.brex.com/mcp' },
  { id: 'calendly', name: 'Calendly', url: 'https://mcp.calendly.com' },
  { id: 'clickup', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp', aliases: ['클릭업'] },
  { id: 'cloudinary', name: 'Cloudinary', url: 'https://asset-management.mcp.cloudinary.com/mcp' },
  { id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/api/v4/mcp', aliases: ['깃랩'] },
  { id: 'indeed', name: 'Indeed', url: 'https://mcp.indeed.com/claude/mcp', ambiguous: true },
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', ambiguous: true },
  { id: 'mermaid', name: 'Mermaid Chart', url: 'https://mcp.mermaid.ai/mcp', ambiguous: true },
  { id: 'mintlify', name: 'Mintlify', url: 'https://mcp.mintlify.com' },
  { id: 'monday', name: 'Monday', url: 'https://mcp.monday.com/mcp', ambiguous: true, aliases: ['먼데이닷컴'] },
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', ambiguous: true },
  { id: 'netlify', name: 'Netlify', url: 'https://netlify-mcp.netlify.app/mcp' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://mcp.openrouter.ai/mcp' },
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp', aliases: ['페이팔'] },
  { id: 'planetscale', name: 'PlanetScale', url: 'https://mcp.pscale.dev/mcp/planetscale' },
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  { id: 'postman', name: 'Postman', url: 'https://mcp.postman.com/mcp', ambiguous: true },
  { id: 'railway', name: 'Railway', url: 'https://mcp.railway.com', ambiguous: true },
  { id: 'razorpay', name: 'Razorpay', url: 'https://mcp.razorpay.com/mcp' },
  { id: 'resend', name: 'Resend', url: 'https://mcp.resend.com/mcp', ambiguous: true },
  { id: 'sanity', name: 'Sanity', url: 'https://mcp.sanity.io', ambiguous: true },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', ambiguous: true },
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/mcp', ambiguous: true },
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com/', aliases: ['버셀'] },
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp' },
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp', aliases: ['윅스'] },
  { id: 'wordpress', name: 'WordPress.com', url: 'https://public-api.wordpress.com/wpcom/v2/mcp/v1', aliases: ['워드프레스'] },
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

/** The listed service at this address by host and path (any scheme, query or letter case): for a logo or a list
 * match. To vouch for an address, use officialService. */
export function catalogAt(url: string): CatalogService | undefined {
  const key = canonicalService(url)
  return SERVICE_CATALOG.find((c) => canonicalService(c.url) === key)
}

/** The listed service whose official address this is, exactly: https, the same host and path (a trailing slash aside),
 * no user name, password, port of its own, query or fragment. Only this makes a card or dialog say "official". */
export function officialService(url: string): CatalogService | undefined {
  let u: URL
  try { u = new URL(url) } catch { return undefined }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return undefined
  const path = u.pathname.replace(/\/+$/, '')
  return SERVICE_CATALOG.find((c) => { const o = new URL(c.url); return o.host === u.host && o.pathname.replace(/\/+$/, '') === path })
}

/** The official host of a listed service ("mcp.notion.com"). */
export const catalogHost = (c: CatalogService) => new URL(c.url).host

/** Letters that look like Latin ones in other scripts (Cyrillic, Greek, Armenian, IPA, small capitals) and digits that
 * pass for letters, mapped to the Latin letter they imitate: a name is compared by its look ("Nоtion" with a Cyrillic
 * о, "ΝOTION" with a Greek Ν, "N0tion"), not its code points. Capitals are mapped before lower case, since a Greek Ν
 * becomes ν ("v") when lowered. Not the whole Unicode confusables table: the letters service names are made of;
 * mixedScript catches the rest. */
const LOOKALIKE: Record<string, string> = {
  // Greek capitals that look like Latin capitals (before lower case)
  Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x',
  // Cyrillic capitals (lowered they map below too; listed so the first pass already reads them)
  А: 'a', В: 'b', С: 'c', Е: 'e', Н: 'h', І: 'i', Ј: 'j', К: 'k', М: 'm', О: 'o', Р: 'p', Ѕ: 's', Т: 't', Х: 'x', Ү: 'y',
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', ё: 'e', һ: 'h', н: 'h', і: 'i', ї: 'i', ј: 'j', к: 'k', ӏ: 'l', м: 'm', о: 'o',
  р: 'p', ԛ: 'q', ѕ: 's', т: 't', у: 'y', ү: 'y', х: 'x', ԝ: 'w', ɡ: 'g', ɑ: 'a', ɩ: 'i', ο: 'o', α: 'a', β: 'b',
  ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', σ: 'o',
  // Armenian, dotless i
  օ: 'o', ո: 'n', ս: 'u', ı: 'i',
  // small capitals (Latin letters in the phonetic blocks)
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n',
  ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
  '0': 'o', '1': 'l',
}
const lookalikes = (s: string) => [...s].map((ch) => LOOKALIKE[ch] ?? ch).join('')
/** a name as it looks: compatibility forms folded (full-width, ligatures), accents dropped, look-alike letters and
 * digits made Latin (before and after lower case), lower case */
export function nameSkeleton(s: string): string {
  return lookalikes(lookalikes(s.normalize('NFKD').replace(/\p{M}+/gu, '')).toLowerCase())
}

/** A word of the name mixes Latin letters with letters of an alphabet that has Latin look-alikes (Cyrillic, Greek,
 * Armenian, Cherokee): "Nоtion" with a Cyrillic о. Whatever the table above knows, such a name is never shown as a
 * listed service's (posesAsListed). A name in one script ("Нотион", "노션") or words in separate scripts ("Acme Нотион")
 * are not mixed. */
export function mixedScript(name: string): boolean {
  for (const w of name.normalize('NFKD').replace(/\p{M}+/gu, '').match(/\p{L}+/gu) ?? []) {
    if (/\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u.test(w)) return true
  }
  return false
}

/** The name a card may show for a connection at `url`: the name itself, unless the address is not exactly a listed
 * service's official one and the name is (or looks like, or holds) a listed service's, or mixes alphabets in a word;
 * then the address's host, so the card never reads as that service. A template's name is the admin's and keeps it. */
export function posesAsListed(name: string, url: string): boolean {
  return !officialService(url) && (!!catalogNamed(name) || mixedScript(name))
}

/** words a name can carry around a service's own name and still mean that service ("Notion MCP", "the Notion app") */
const FILLER = new Set(['mcp', 'server', 'app', 'api', 'official', 'the', 'connector', 'integration', 'com', 'my'])
const words = (s: string) => nameSkeleton(s).match(/\p{L}+|\p{N}+/gu) ?? []
/** a listed service's names (its name, id and local names such as 노션), as the joined words they are compared by */
const namesOf = (c: CatalogService) => [...new Set([words(c.name).filter((w) => !FILLER.has(w)).join(''), c.id, ...('aliases' in c ? c.aliases.map((a) => words(a).join('')) : [])])]

/**
 * Which listed service a name means, as the AI wrote it, compared by how it looks (nameSkeleton: "Nоtion" with a
 * Cyrillic о, "Notíon", "N0tion" and "노션" are Notion):
 * - `exact`: the name is that service's own ("Notion", "notion", "Notion MCP", "Click Up", "WordPress", "노션").
 * - `contains`: the name holds it among other words ("Notion workspace", "Acme GitLab"). A service whose name is an
 *   ordinary word (`ambiguous`: Square, Linear, Monday …) is matched only exactly, so "Square Feet API" names none.
 * Undefined: the name names no listed service.
 */
export function catalogNamed(name: string): { service: CatalogService; exact: boolean } | undefined {
  const all = words(name)
  const core = all.filter((w) => !FILLER.has(w)).join('')
  let contains: CatalogService | undefined
  for (const c of SERVICE_CATALOG) {
    const names = namesOf(c)
    if (core && names.includes(core)) return { service: c, exact: true }
    if (contains || ('ambiguous' in c && c.ambiguous)) continue
    // any run of the name's words, joined, that is the service's name ("Click Up Tasks" holds "clickup")
    outer: for (let i = 0; i < all.length; i++) {
      let joined = ''
      for (let j = i; j < all.length; j++) {
        joined += all[j]
        if (names.includes(joined)) { contains = c; break outer }
        if (joined.length > 40) break
      }
    }
  }
  return contains ? { service: contains, exact: false } : undefined
}

/**
 * The name a connection to `url` may be shown under, on the card and on the chat's step line alike (docs/DECISIONS.md
 * "The chat's connect card trusts the app's list"):
 * - the list's name at exactly a listed service's official address, or for a listed name ("Notion", "노션") at its
 *   official host or with no address yet;
 * - the address's host when the name is, looks like or holds a listed service's, or mixes alphabets in a word, and the
 *   address is not the official one (a self-hosted edition, a made-up address);
 * - else the name as written.
 * `claimed`: the listed service the name pretends to be at an address that is not its official one (for the card's
 * "not Notion's official address" line), when there is one.
 */
export function trustedServiceName(name: string, url?: string | null): { name: string; listed?: CatalogService; claimed?: CatalogService } {
  const named = catalogNamed(name)
  let u: URL | null = null
  try { u = url ? new URL(url) : null } catch { u = null }
  const official = url ? officialService(url) : undefined
  if (official) return { name: official.name, listed: official }
  if (named?.exact && (!url || (u && u.host.toLowerCase() === catalogHost(named.service)))) return { name: named.service.name, listed: named.service }
  if (u && (named || mixedScript(name))) return { name: u.host.slice(0, 60), ...(named ? { claimed: named.service } : {}) }
  return { name }
}
