export interface MobileProduct { name: string; accent: string; userAgent: string; scheme: string; bundleId: string; background?: string; appleTeamId?: string }
/** accent: this edition's (Trina Signal Orange, --c-accent in web/src/theme.edition.css); an edition config may replace it. */
export const DEFAULT_PRODUCT: MobileProduct = { name: 'Team AX', accent: '#e8521a', userAgent: 'TeamAX-Mobile', scheme: 'teamax-mobile', bundleId: 'app.teamax.mobile.dev' }

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * c(n >> 16) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255)
}
/** Text and icons on an accent fill (the Connect button): white or the warm black (#14110f, the web's --c-accent-ink),
 * whichever reads better on that accent. White on the orange is 3.7:1, too low for the button's 16px label. */
export function accentInk(accent: string): string {
  const l = luminance(accent)
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / (luminance('#14110f') + 0.05)) ? '#ffffff' : '#14110f'
}
/** Editions may replace explicit presentation/identifier fields, never URLs, permissions or executable code. */
export function mobileProduct(value: unknown): MobileProduct {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    name: typeof v.name === 'string' && /^[^\u0000-\u001f]{1,40}$/.test(v.name) ? v.name : DEFAULT_PRODUCT.name,
    accent: typeof v.accent === 'string' && /^#[a-f0-9]{6}$/i.test(v.accent) ? v.accent : DEFAULT_PRODUCT.accent,
    userAgent: typeof v.userAgent === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(v.userAgent) ? v.userAgent : DEFAULT_PRODUCT.userAgent,
    scheme: typeof v.scheme === 'string' && /^[a-z][a-z0-9-]{2,39}$/.test(v.scheme) ? v.scheme : DEFAULT_PRODUCT.scheme,
    bundleId: typeof v.bundleId === 'string' && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,6}$/.test(v.bundleId) ? v.bundleId : DEFAULT_PRODUCT.bundleId,
    // launch screen and Android icon background; the Apple developer team that signs the iOS build (not a secret)
    ...(typeof v.background === 'string' && /^#[a-f0-9]{6}$/i.test(v.background) ? { background: v.background } : {}),
    ...(typeof v.appleTeamId === 'string' && /^[A-Z0-9]{10}$/.test(v.appleTeamId) ? { appleTeamId: v.appleTeamId } : {}),
  }
}

/** iPhone: the keychain group the app shares with its notification service extension and the extension's bundle id
 * (src/labels.ts), for an edition that names its Apple team (the group carries the team id). null: no extension (the
 * neutral development app). Here, not in labels.ts: app.config.ts loads this file without a bundler. */
export function labelSetup(p: Pick<MobileProduct, 'bundleId' | 'appleTeamId'>): { accessGroup: string; extensionId: string } | null {
  if (!p.appleTeamId) return null
  return { accessGroup: `${p.appleTeamId}.${p.bundleId}.notifications`, extensionId: `${p.bundleId}.NotificationService` }
}

/** The edition's hosted service, as far as the first-run screen needs it: the team domain (`acme` -> acme.<teamDomain>,
 * editions/<name>/branding/service.json) and the source repository (source.json), whose install guide is the "install
 * it yourself" link (a page with no signup or pricing link: App Review 3.1.1, Google Play payments). Read by
 * app.config.ts at build time; anything that does not look right is dropped (no bare names, no docs link). */
export interface MobileService { teamDomain: string | null; repository: string | null }
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export function mobileService(service: unknown, source: unknown): MobileService {
  const d = service && typeof service === 'object' ? (service as Record<string, unknown>).teamDomain : undefined
  const r = source && typeof source === 'object' ? (source as Record<string, unknown>).repository : undefined
  return {
    teamDomain: typeof d === 'string' && HOST.test(d) ? d : null,
    repository: typeof r === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(r) ? r : null,
  }
}
/** The "install it yourself" page: the repository's Linux install guide (Korean, else English). */
export function installGuide(repository: string | null, korean: boolean): string | null {
  return repository ? `${repository}/blob/main/docs/INSTALL-LINUX${korean ? '' : '.en'}.md` : null
}
