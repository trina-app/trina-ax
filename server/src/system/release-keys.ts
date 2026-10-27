// The Ed25519 release public keys (raw 32 bytes, base64): one place for every signed feed and bundle — the office feed
// (office/release.ts), the server feed and bundles (system/update.ts) and the bootstrap's --pubkey that the Linux
// installer writes. The private key lives only on the owner's Mac (~/.config/teamax-release/release-key.pem,
// scripts/release/keygen.ts). A key is replaced by adding the new one here first, shipping that build, then signing
// with the new key (the old one stays until every install has the new build).
export const RELEASE_KEYS: readonly string[] = ['aBlaqvK85shocX702pWi4gM/aYEzGS56Yy9h7Pj4KF4=' /* key id 84b790c8b6439e8b, made 2026-10-21 */]
