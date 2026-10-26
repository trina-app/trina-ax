// The product name lives here and only here. Everything else imports PRODUCT, or reads a file built from it:
//   web/index.html title, manifest.webmanifest and the service worker's offline page (web/vite.config.ts, at build),
//   desktop/electron-builder.config.ts (app name, installer names, shortcut), app/product.env in the office zip and
//   product.env next to the server bundle (the shell scripts' text, scripts/product-env.ts), the menubar app's
//   Info.plist (menubar/build.sh).
// Renaming the product = change displayName / shortName / artifactBase (and officeBundle, see there) below, then
// rebuild. tests/unit/product-name.test.ts fails when the name is written anywhere else in user-facing source.
// Names already on people's machines (the ~/TeamAX office folder, the `teamax` command, LaunchAgent labels, data
// folders, env variables, bundle ids) are NOT derived from the name, so a rename never strands an installation.
export const PRODUCT = {
  /** machine name: folders, sockets, bundle ids, temp-file prefixes, env prefix (MYCEL_*). Keep stable. */
  id: 'mycel',
  /** what people see in the UI, window titles, the menubar app, installers and emails */
  displayName: "Trina AX",
  /** where space is short: the PWA home-screen label (manifest short_name, apple-mobile-web-app-title) */
  shortName: "Trina AX",
  /** file names (no spaces): desktop installers <artifactBase>-Setup-<v>-x64.exe and <artifactBase>-<v>-mac-universal.dmg,
   *  the fetch tool's User-Agent token */
  artifactBase: "Trina-AX",
  /** the office zip <officeBundle>-<version>-mac.zip and its one folder. Offices from this version on accept any
   *  "<name>-office-<version>" folder in an update, so changing it only needs older offices to install one zip by hand. */
  officeBundle: "TrinaAX-office",
  /** the desktop app's own settings folder (Electron userData: remembered teams, window size, language). This is a
   *  path on the desks, not a name: it stays when the product is renamed, or every desk would forget its teams. */
  desktopDataDir: 'Team AX',
  /** prefix of environment variables the server reads (MYCEL_PORT, MYCEL_CONFIG, ...) */
  envPrefix: 'MYCEL_',
  /** MCP server name the engine sees: tools appear as mcp__team__<tool> */
  mcpServerName: 'team',
  /** prefix for the server's own temp files inside the team folder (never visible to tools) */
  tmpPrefix: '.mycel-tmp-',
  /** reserved top-level folder for history / trash (tools can never reach it) */
  systemDir: '.system',
} as const

export const TEAM_TOOL_PREFIX = `mcp__${PRODUCT.mcpServerName}__`

/** The lines of product.env (KEY=value, no quotes; shell scripts read it with sed, never `source`). Values are checked
 * by tests/unit/product-name.test.ts to be safe there: no quotes, $, backslash, backtick or line breaks. */
export function productEnv(extra: Record<string, string> = {}): string {
  const vars: Record<string, string> = {
    PRODUCT_ID: PRODUCT.id,
    PRODUCT_NAME: PRODUCT.displayName,
    PRODUCT_SHORT_NAME: PRODUCT.shortName,
    PRODUCT_ARTIFACT_BASE: PRODUCT.artifactBase,
    PRODUCT_OFFICE_BUNDLE: PRODUCT.officeBundle,
    ...extra,
  }
  for (const [k, v] of Object.entries(vars)) if (!/^[A-Z_]+$/.test(k) || /["'`$\\\n\r]/.test(v)) throw new Error(`product.env: unsafe ${k}=${v}`)
  return Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join('')
}
