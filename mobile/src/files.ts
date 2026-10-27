// Cache only; never store session cookies or remote URLs here. Every async write is awaited by FileTransfers.
import { Directory, File, Paths } from 'expo-file-system'
import * as Crypto from 'expo-crypto'
import * as Sharing from 'expo-sharing'
import type { TransferIO } from './bridge'
const cache = () => new Directory(Paths.cache, 'team-ax-transfers')
export function clearDownloadCache() { const root = cache(); if (root.exists) root.delete() }
export function fileTransferIO(): TransferIO {
  const open = new Map<string, { file: File; dir: Directory; mime: string }>()
  const get = (id: string) => { const item = open.get(id); if (!item) throw new Error('transfer_missing'); return item }
  return {
    async create(id, name, mime) {
      const root = cache(); if (!root.exists) root.create({ intermediates: true })
      const dir = new Directory(root, id); dir.create()
      try {
        const file = new File(dir, name); file.create()
        open.set(id, { file, dir, mime })
      } catch (error) {
        if (dir.exists) dir.delete()
        throw error
      }
    },
    async append(id, b64) { await get(id).file.write(b64, { encoding: 'base64', append: true }) },
    async inspect(id) {
      const bytes = await get(id).file.bytes()
      const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)
      return { size: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') }
    },
    async share(id) {
      if (!(await Sharing.isAvailableAsync())) throw new Error('sharing_unavailable')
      const item = get(id)
      await Sharing.shareAsync(item.file.uri, { mimeType: item.mime, dialogTitle: item.file.name })
    },
    async remove(id) {
      const item = open.get(id); open.delete(id)
      if (item?.dir.exists) item.dir.delete()
    },
  }
}
