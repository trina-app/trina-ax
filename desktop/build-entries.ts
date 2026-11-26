// What desktop/build.ts bundles into dist/, and the files it copies there as they are. One list: build.ts builds from
// it, and the release's Windows rule (scripts/release/windows-inputs.ts) fingerprints the same bundle, so a new screen
// or preload cannot be built without counting as a change of the Windows app.

/** [entry under desktop/, output name under dist/, browser (a screen) or node (main and preloads)] */
export const BUNDLE_ENTRIES: readonly (readonly [entry: string, out: string, target: 'node' | 'browser'])[] = [
  ['src/main/main.ts', 'main.cjs', 'node'],
  ['src/preload/app.ts', 'preload-app.cjs', 'node'],
  ['src/preload/ui.ts', 'preload-ui.cjs', 'node'],
  ['src/preload/consent.ts', 'preload-consent.cjs', 'node'],
  ['src/ui/welcome.ts', 'ui/welcome.js', 'browser'],
  ['src/ui/pane.ts', 'ui/pane.js', 'browser'],
  ['src/ui/hostbar.ts', 'ui/hostbar.js', 'browser'],
  ['src/ui/findbar.ts', 'ui/findbar.js', 'browser'],
  ['src/ui/consent.ts', 'ui/consent.js', 'browser'],
]

/** the screens' pages under src/ui/ (the product name goes into their <title>) */
export const UI_PAGES = ['welcome.html', 'pane.html', 'hostbar.html', 'findbar.html', 'consent.html'] as const

/** copied as they are: [from under desktop/, to under dist/] */
export const COPIED: readonly (readonly [from: string, to: string])[] = [
  ['src/ui/ui.css', 'ui/ui.css'],
  ['src/main/pane/page-script.js', 'page-script.js'],
]
