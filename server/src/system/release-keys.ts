// The Ed25519 release public keys (raw 32 bytes, base64): one place for every signed feed and bundle — the office feed
// (office/release.ts), the server feed and bundles (system/update.ts) and the bootstrap's --pubkey that the Linux
// installer writes. They come from this product's release channel (shared/src/release-channel.ts; editions set their own
// with scripts/edition-release.ts). The private key lives only on the owner's Mac (~/.config/<keyDir>/release-key.pem,
// scripts/release/keygen.ts). A key is replaced by adding the new one first, shipping that build, then signing with the
// new key (the old one stays until every install has the new build).
import { RELEASE_CHANNEL } from '@mycel/shared'

export const RELEASE_KEYS: readonly string[] = RELEASE_CHANNEL.keys
