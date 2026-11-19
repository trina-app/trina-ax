// scripts/image/files/axdata-resize: the data-disk grow that 90-axdata-resize.rules (block "change") and
// axdata-grow.service (each mount) run. It must call resize2fs only when the device is bigger than the file system:
// resize2fs opens the disk for writing, the close makes udev send another "change", and a bare resize2fs in the rule
// ran ax-axdata-resize.service 100-160 times in a first boot. A real grow (a plan upgrade) must still grow.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '../..')
const FILES = path.join(REPO, 'scripts/image/files')
const SCRIPT = path.join(FILES, 'axdata-resize')
const GiB = 1024 ** 3

function fakes(dir: string, dumpe2fs: string | null, devBytes: number | string) {
  const w = (name: string, body: string) => {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  if (dumpe2fs === null) w('dumpe2fs', 'echo "dumpe2fs: Bad magic number in super-block" >&2; exit 1')
  else w('dumpe2fs', `cat <<'EOF'\n${dumpe2fs}\nEOF`)
  w('blockdev', `[ "$1" = --getsize64 ] || exit 9; echo ${devBytes}`)
  w('resize2fs', `echo "$@" >> "${dir}/resize2fs.calls"`)
}

function head(blocks: number, bsize = 4096, perGroup = 32768): string {
  return [
    'Filesystem volume name:   axdata',
    `Block count:              ${blocks}`,
    'Reserved block count:     0',
    `Block size:               ${bsize}`,
    `Blocks per group:         ${perGroup}`,
  ].join('\n')
}

function run(dumpe2fs: string | null, devBytes: number | string, dev = '/dev/nvme1n1', bins?: { dumpe2fs: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axdata-resize-'))
  try {
    fakes(dir, dumpe2fs, devBytes)
    const env = {
      ...process.env,
      AXDATA_DUMPE2FS: bins?.dumpe2fs ?? path.join(dir, 'dumpe2fs'),
      AXDATA_BLOCKDEV: path.join(dir, 'blockdev'),
      AXDATA_RESIZE2FS: path.join(dir, 'resize2fs'),
    }
    const p = Bun.spawnSync(['sh', SCRIPT, dev], { env, stdout: 'pipe', stderr: 'pipe' })
    const callsFile = path.join(dir, 'resize2fs.calls')
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : []
    return { code: p.exitCode, calls, out: p.stdout.toString() + p.stderr.toString() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('axdata-resize', () => {
  const blocks20 = (20 * GiB) / 4096

  test('same size (the close of every resize2fs, the first mount): no resize2fs, so no new event', () => {
    const r = run(head(blocks20), 20 * GiB)
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.out).toContain('nothing to grow')
  })

  test('a device less than one block group bigger (resize2fs leaves a too-small tail out): no resize2fs', () => {
    expect(run(head(blocks20), 20 * GiB + 100 * 4096).calls).toEqual([])
    expect(run(head(blocks20), 20 * GiB + 32767 * 4096).calls).toEqual([])
  })

  test('a real grow (20 to 40 GiB, a plan upgrade) runs resize2fs on the device once', () => {
    const r = run(head(blocks20), 40 * GiB)
    expect(r.code).toBe(0)
    expect(r.calls).toEqual(['/dev/nvme1n1'])
    expect(r.out).toContain(`growing the file system from ${20 * GiB} to ${40 * GiB} bytes`)
    // exactly one block group bigger is a grow
    expect(run(head(blocks20), 20 * GiB + 32768 * 4096).calls).toEqual(['/dev/nvme1n1'])
    // 1 KiB blocks, 8192 per group (a small file system)
    expect(run(head(1024 * 1024, 1024, 8192), 2 * GiB, '/dev/vdb').calls).toEqual(['/dev/vdb'])
  })

  test('no ext4 superblock: nothing to do; sizes it cannot read or a bad argument: an error, never resize2fs', () => {
    const none = run(null, 20 * GiB)
    expect(none.code).toBe(0)
    expect(none.calls).toEqual([])
    const garbled = run('Block count: x', 20 * GiB)
    expect(garbled.code).toBe(1)
    expect(garbled.calls).toEqual([])
    expect(run(head(blocks20), '').calls).toEqual([])
    const bad = run(head(blocks20), 40 * GiB, 'nvme1n1')
    expect(bad.code).toBe(2)
    expect(bad.calls).toEqual([])
  })

  const realDumpe2fs = ['/usr/sbin/dumpe2fs', '/sbin/dumpe2fs'].find((p) => fs.existsSync(p))
  const realMkfs = ['/usr/sbin/mkfs.ext4', '/sbin/mkfs.ext4'].find((p) => fs.existsSync(p))
  test.skipIf(!realDumpe2fs || !realMkfs)('the real dumpe2fs output of an ext4 image parses (needs e2fsprogs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axdata-img-'))
    try {
      const img = path.join(dir, 'disk.img')
      fs.writeFileSync(img, '')
      fs.truncateSync(img, 256 * 1024 * 1024)
      const mk = Bun.spawnSync([realMkfs!, '-q', '-F', '-L', 'axdata', '-m', '0', img])
      expect(mk.exitCode).toBe(0)
      // the image as "/dev/..." is only a name for the check; dumpe2fs reads the real file through a wrapper
      const wrap = path.join(dir, 'dumpe2fs-wrap')
      fs.writeFileSync(wrap, `#!/bin/sh\nexec ${realDumpe2fs} -h ${img}\n`, { mode: 0o755 })
      expect(run(null, 256 * 1024 * 1024, '/dev/loop9', { dumpe2fs: wrap }).calls).toEqual([])
      expect(run(null, 512 * 1024 * 1024, '/dev/loop9', { dumpe2fs: wrap }).calls).toEqual(['/dev/loop9'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the rule and the mount-time service run the guard, and the image installs it executable', () => {
    const rule = fs.readFileSync(path.join(FILES, '90-axdata-resize.rules'), 'utf8')
    const lines = rule.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ACTION=="change"')
    expect(lines[0]).toContain('ENV{ID_FS_LABEL}=="axdata"')
    expect(lines[0]).toContain('systemd-run --no-block --collect --unit=ax-axdata-resize /usr/local/sbin/axdata-resize $devnode')
    expect(lines[0]).not.toContain('resize2fs')
    const grow = fs.readFileSync(path.join(FILES, 'axdata-grow.service'), 'utf8')
    expect(grow).toMatch(/^ExecStart=.*\/usr\/local\/sbin\/axdata-resize .*--mountpoint \/var\/lib\/mycel/m)
    expect(grow).not.toMatch(/^ExecStart=.*resize2fs/m)
    const customize = fs.readFileSync(path.join(REPO, 'scripts/image/customize.sh'), 'utf8')
    expect(customize).toContain('put_file "$FILES/axdata-resize" /usr/local/sbin/axdata-resize 0755')
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0)
  })
})
