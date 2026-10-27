import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'bun:test'
import { brandedProduct, parseProductBrand } from '../../scripts/product-brand'
const source = fs.readFileSync(path.resolve(import.meta.dir, '../../shared/src/product.ts'), 'utf8')
const brand = { displayName: 'Example AX', shortName: 'Example AX', artifactBase: 'Example-AX', officeBundle: 'ExampleAX-office' }

test('edition branding changes only four names and is repeatable, preserving existing installation identity', () => {
  const result = brandedProduct(source, brand)
  expect(brandedProduct(result, brand)).toBe(result)
  const before = source.split('\n'), after = result.split('\n')
  const changed = before.filter((line, i) => line !== after[i])
  expect(changed).toHaveLength(4)
  expect(changed.every(line => /^  (displayName|shortName|artifactBase|officeBundle): /.test(line))).toBe(true)
  for (const key of ['id', 'desktopDataDir', 'envPrefix', 'mcpServerName', 'tmpPrefix', 'systemDir']) expect(after.find(line => line.startsWith(`  ${key}: `))).toBe(before.find(line => line.startsWith(`  ${key}: `)))
})
test('unknown stable ID overrides, shell/source injection and unsupported identifiers are refused', () => {
  for (const value of [{ ...brand, id: 'changed' }, { ...brand, displayName: "quote'" }, { ...brand, artifactBase: '../outside' }, { ...brand, officeBundle: 'arbitrary' }, { ...brand, shortName: 'x\ny' }, null]) expect(() => parseProductBrand(value)).toThrow()
})
test('missing or duplicate product fields fail without producing a partial result', () => {
  expect(() => brandedProduct(source.replace(/^  displayName:.*$/m, ''), brand)).toThrow()
  expect(() => brandedProduct(source + "\n  displayName: 'duplicate',\n", brand)).toThrow()
})
