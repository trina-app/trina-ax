// Microsoft Store build of the desktop app (README.md here): an MSIX package for Partner Center. It reuses
// desktop/electron-builder.config.ts and changes only what the store needs: the appx target, the package identity that
// Partner Center gives the reserved name, the store version, the tile images and the manifest (microphone). The store
// signs the package, so it is built unsigned. electron-builder runs in desktop/ on Windows (it calls makeappx.exe):
//   MSSTORE_VERSION=<x.y.z> bunx electron-builder \
//     --config ../editions/trina/microsoft-store/electron-builder.msix.config.ts --win appx --x64 --publish never
// The base appId stays as it is: the NSIS app is identified by it.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import base from '../../../desktop/electron-builder.config'
import { PRODUCT } from '../../../shared/src/product'

// Partner Center › Trina AX › Product management › Product identity: Package/Identity/Name and Package/Identity/Publisher.
// Empty until Microsoft finishes the account check and the name is reserved.
const IDENTITY = { name: '', publisher: '' }
// Package/Properties/PublisherDisplayName: the publisher name on the Partner Center account, letter for letter
const PUBLISHER_NAME = 'Trina Inc.'

// this folder, for build-resources/. electron-builder compiles this file into a cache folder first (config-file-ts),
// where __dirname is not this folder; it runs in desktop/, so the folder is also found from there.
const HERE = [__dirname, resolve(process.cwd(), '..', 'editions', 'trina', 'microsoft-store')].find((d) => existsSync(join(d, 'build-resources', 'appxmanifest.xml')))
if (!HERE) throw new Error('editions/trina/microsoft-store not found: run electron-builder in desktop/')

// every package needs a higher version than the last one sent to the store, and the store keeps the 4th part at 0.
// A prerelease (0.4.0-beta.10) would collapse to 0.4.0.0, so the store version is given.
const version = process.env.MSSTORE_VERSION ?? ''
if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) throw new Error('MSSTORE_VERSION: x.y.z, higher than the last package sent to the store')
// MSSTORE_TEST=1: a placeholder identity, to check that the package builds before the name is reserved (the store
// refuses such a package)
const test = process.env.MSSTORE_TEST === '1'
const identity = test ? { name: 'TrinaInc.TrinaAXTest', publisher: 'CN=Trina Inc. Test' } : IDENTITY
if (!identity.name || !identity.publisher) throw new Error('IDENTITY: copy Package/Identity/Name and Publisher from Partner Center (or MSSTORE_TEST=1 for a test package)')

export default {
  ...base,
  // the package version is <version>.0; the app shows the same version
  extraMetadata: { ...base.extraMetadata, version },
  // appx/ (tile images) and appxmanifest.xml are found in buildResources
  directories: { ...base.directories, buildResources: join(HERE, 'build-resources') },
  // the store updates the app (desktop/src/common/update.ts turns the app's own update check off in a store build)
  publish: null,
  win: {
    ...base.win,
    target: [{ target: 'appx', arch: ['x64'] }],
    // the exe keeps the desktop app's icon (buildResources above no longer holds it)
    icon: resolve(HERE, '..', '..', '..', 'desktop', 'build-resources', 'icon.png'),
  },
  appx: {
    identityName: identity.name,
    publisher: identity.publisher,
    publisherDisplayName: PUBLISHER_NAME,
    applicationId: 'TrinaAX',
    // the reserved name in Partner Center
    displayName: PRODUCT.displayName,
    backgroundColor: '#14110f',
    // store listings: English (default) and Korean; the app itself still has its five languages
    languages: ['en-US', 'ko-KR'],
    minVersion: '10.0.17763.0',
    maxVersionTested: '10.0.26100.0',
    customManifestPath: 'appxmanifest.xml',
    artifactName: `${PRODUCT.artifactBase}-\${version}-store-\${arch}${test ? '-test' : ''}.msix`,
  },
}
