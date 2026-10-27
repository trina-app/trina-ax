export interface MobileProduct { name: string; accent: string; userAgent: string; scheme: string; bundleId: string }
export const DEFAULT_PRODUCT: MobileProduct = { name: 'Team AX', accent: '#176b55', userAgent: 'TeamAX-Mobile', scheme: 'teamax-mobile', bundleId: 'app.teamax.mobile.dev' }
/** Editions may replace explicit presentation/identifier fields, never URLs, permissions or executable code. */
export function mobileProduct(value: unknown): MobileProduct {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    name: typeof v.name === 'string' && /^[^\u0000-\u001f]{1,40}$/.test(v.name) ? v.name : DEFAULT_PRODUCT.name,
    accent: typeof v.accent === 'string' && /^#[a-f0-9]{6}$/i.test(v.accent) ? v.accent : DEFAULT_PRODUCT.accent,
    userAgent: typeof v.userAgent === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(v.userAgent) ? v.userAgent : DEFAULT_PRODUCT.userAgent,
    scheme: typeof v.scheme === 'string' && /^[a-z][a-z0-9-]{2,39}$/.test(v.scheme) ? v.scheme : DEFAULT_PRODUCT.scheme,
    bundleId: typeof v.bundleId === 'string' && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,6}$/.test(v.bundleId) ? v.bundleId : DEFAULT_PRODUCT.bundleId,
  }
}
