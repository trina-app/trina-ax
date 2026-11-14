// The two server modules web/test/mock/server.ts imports that only touch the disk: the credential sealer (Admin › AI
// connections, never reached in the demo: the visitor is a member) and the static web server (the demo's pages are
// static files). web/demo/vite.ts aliases them here in the demo build only.
export class Sealer {
  constructor(_dir: string) {}
  publicKey(): never { throw new Error('demo: no sealing') }
  async unseal(): Promise<never> { throw new Error('demo: no sealing') }
}
export const serveWeb = (): Response | null => null
