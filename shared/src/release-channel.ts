// This product's release channel: where its updates come from and the keys that sign them (docs/EDITION-RELEASE.md).
// The core product and each edition built from it have their own, so an installation only takes its own product's
// releases: a release must verify with one of these keys, and an office manifest must name officeProduct.
// Written by scripts/edition-release.ts (with native/internal/bundle/release_keys.go); an edition changes it with
// `bun scripts/edition-release.ts editions/<name>/release-channel.json --apply`, never by hand.
export const RELEASE_CHANNEL = {
  /** https origin of the feed: offices read <feed>/<officeDir>/<channel>.json, Linux servers <feed>/server/<channel>.json */
  feed: "https://updates.trina.app",
  /** Ed25519 release public keys (raw 32 bytes, base64), the only keys an installation trusts for updates. A key is
   *  replaced by adding the new one first, shipping that build, then signing with the new key. */
  keys: [
    "jdltMFlx7RlZaB2fHZoplBVCE0drUl1Xycw1lXPNquk=", // key id 086478d11148fd06
    "FA6/4xpI1X0VWQ5wQNyK4yVFMl3Jr+R8FTPk4F2BS00=", // key id a8f40309cdceb532
  ] as readonly string[],
  /** the product field of a signed office manifest */
  officeProduct: "trina-ax-office",
  /** the feed's folder for office releases */
  officeDir: "office",
  /** the owner's signing key on the release Mac: ~/.config/<keyDir>/release-key.pem (scripts/release/keygen.ts) */
  keyDir: "trina-ax-release",
  /** where the feed is hosted (scripts/release/hosting.ts): the Cloudflare zone of the feed's host, the R2 bucket, the Worker */
  hosting: { zone: "trina.app", bucket: "trina-ax-updates", worker: "trina-ax-updates" },
} as const
