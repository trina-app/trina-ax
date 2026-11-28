// Builds the extension into chrome-extension/dist/ (load it unpacked from there); `--zip` also writes
// chrome-extension/release/<artifactBase>-chrome-<version>.zip for the Chrome Web Store. The name and icons come from
// the branding at build time (PRODUCT in shared/src/product.ts, editions/trina/branding/chrome/). Run: bun chrome-extension/build.ts [--zip]
import { $ } from 'bun'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT } from '../shared/src/product'
import { chromeMessages, LOCALES } from './src/messages'

/** The extension's own version (semver; the Web Store wants plain numbers). Never edit it by hand: `bun run chrome:bump
 * patch|minor|major` sets it and records chrome-extension/shipped.json (the store never gets one version twice;
 * docs/RELEASE-CI.md "Chrome extension releases"). */
export const EXTENSION_VERSION = '0.3.2'

const HERE = import.meta.dir
const ROOT = join(HERE, '..')
const DIST = join(HERE, 'dist')
// What the zip is built from, besides the code the entry points import (chrome-extension/inputs.ts fingerprints the same
// lists, repository-relative)
export const ENTRYPOINTS = ['chrome-extension/src/worker.ts', 'chrome-extension/src/popup.ts', 'chrome-extension/src/pair.ts'] as const
export const PAGES = ['popup.html', 'popup.css', 'pair.html'] as const
export const ICON_SIZES = [16, 32, 48, 128] as const
export const ICONS_DIR = 'editions/trina/branding/chrome'
export const PAGE_SCRIPT_FILE = 'desktop/src/main/pane/page-script.js'
const ICONS = join(ROOT, ICONS_DIR)
const PAGE_SCRIPT = join(ROOT, PAGE_SCRIPT_FILE)

/** The public key of unpacked builds (chrome-extension/dev-key.pub): their id is fixed (CHROME_EXTENSION_IDS.dev), so
 * the desktop app's native helper can name it in a development run. Never in the store zip (the store gives its own). */
export const DEV_KEY = readFileSync(join(import.meta.dir, 'dev-key.pub'), 'utf8').trim()

export function manifest(version: string, o: { dev?: boolean } = {}) {
  return {
    ...(o.dev ? { key: DEV_KEY } : {}),
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: PRODUCT.shortName.slice(0, 12),
    description: '__MSG_extDescription__',
    version,
    default_locale: 'en',
    minimum_chrome_version: '125',
    background: { service_worker: 'worker.js', type: 'module' },
    action: {
      default_title: '__MSG_actionTitle__',
      default_popup: 'popup.html',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    // nativeMessaging: only to pair through the desktop app on this computer (chrome-native.ts); Chrome shows
    // "Communicate with cooperating native applications" at install
    permissions: ['debugger', 'tabGroups', 'storage', 'alarms', 'activeTab', 'nativeMessaging'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  }
}

async function build(dev: boolean) {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(join(DIST, 'icons'), { recursive: true })
  const r = await Bun.build({
    entrypoints: ENTRYPOINTS.map((f) => join(ROOT, f)),
    outdir: DIST,
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    // the desktop pane's page script, as is, injected into an isolated world of the pages the AI reads
    define: { __PAGE_SCRIPT__: JSON.stringify(readFileSync(PAGE_SCRIPT, 'utf8')) },
  })
  if (!r.success) {
    for (const l of r.logs) console.error(l)
    throw new Error('extension build failed')
  }
  for (const f of PAGES) cpSync(join(HERE, 'src', f), join(DIST, f))
  for (const s of ICON_SIZES) {
    const icon = join(ICONS, `icon-${s}.png`)
    if (!existsSync(icon)) throw new Error(`missing ${icon}`)
    cpSync(icon, join(DIST, 'icons', `icon-${s}.png`))
  }
  for (const loc of LOCALES) {
    mkdirSync(join(DIST, '_locales', loc), { recursive: true })
    writeFileSync(join(DIST, '_locales', loc, 'messages.json'), `${JSON.stringify(chromeMessages(loc, PRODUCT.displayName), null, 2)}\n`)
  }
  writeFileSync(join(DIST, 'manifest.json'), `${JSON.stringify(manifest(EXTENSION_VERSION, { dev }), null, 2)}\n`)
  console.log(`built ${DIST} (version ${EXTENSION_VERSION})`)
}

async function zip() {
  const out = join(HERE, 'release')
  mkdirSync(out, { recursive: true })
  const file = join(out, `${PRODUCT.artifactBase}-chrome-${EXTENSION_VERSION}.zip`)
  rmSync(file, { force: true })
  // stored paths relative to dist (manifest.json at the zip's root, as the Web Store wants)
  await $`zip -q -r -X ${file} .`.cwd(DIST)
  console.log(`wrote ${file}`)
}

if (import.meta.main) {
  // the store zip has no key (the store gives the item its own id); an unpacked build keeps the fixed dev id
  const forStore = process.argv.includes('--zip')
  await build(!forStore)
  if (forStore) await zip()
}
