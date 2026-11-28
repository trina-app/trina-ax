// Builds the extension into chrome-extension/dist/ (load it unpacked from there); `--zip` also writes
// chrome-extension/release/<artifactBase>-chrome-<version>.zip for the Chrome Web Store. The name and icons come from
// the branding at build time (PRODUCT in shared/src/product.ts, editions/trina/branding/chrome/). Run: bun chrome-extension/build.ts [--zip]
import { $ } from 'bun'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT } from '../shared/src/product'
import { chromeMessages, LOCALES } from './src/messages'

/** The extension's own version (semver; the Web Store wants plain numbers). Bump it with each store upload. */
export const EXTENSION_VERSION = '0.1.0'

const HERE = import.meta.dir
const ROOT = join(HERE, '..')
const DIST = join(HERE, 'dist')
const ICONS = join(ROOT, 'editions/trina/branding/chrome')
const PAGE_SCRIPT = join(ROOT, 'desktop/src/main/pane/page-script.js')

export function manifest(version: string) {
  return {
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
    permissions: ['debugger', 'tabGroups', 'storage', 'alarms', 'activeTab'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  }
}

async function build() {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(join(DIST, 'icons'), { recursive: true })
  const r = await Bun.build({
    entrypoints: [join(HERE, 'src/worker.ts'), join(HERE, 'src/popup.ts')],
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
  for (const f of ['popup.html', 'popup.css']) cpSync(join(HERE, 'src', f), join(DIST, f))
  for (const s of [16, 32, 48, 128]) {
    const icon = join(ICONS, `icon-${s}.png`)
    if (!existsSync(icon)) throw new Error(`missing ${icon}`)
    cpSync(icon, join(DIST, 'icons', `icon-${s}.png`))
  }
  for (const loc of LOCALES) {
    mkdirSync(join(DIST, '_locales', loc), { recursive: true })
    writeFileSync(join(DIST, '_locales', loc, 'messages.json'), `${JSON.stringify(chromeMessages(loc, PRODUCT.displayName), null, 2)}\n`)
  }
  writeFileSync(join(DIST, 'manifest.json'), `${JSON.stringify(manifest(EXTENSION_VERSION), null, 2)}\n`)
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
  await build()
  if (process.argv.includes('--zip')) await zip()
}
