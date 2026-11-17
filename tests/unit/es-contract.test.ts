// Spanish "a el" / "de el" before a filled-in value (shared/src/es-contract.ts; QA TC-4372 wording nit, 2026-11-17).
import { expect, test } from 'bun:test'
import { esContract, esMark } from '../../shared/src/es-contract'
import { FOLDER_TEXT } from '../../server/src/chat/folder-access-tool'

const fill = (t: string, v: Record<string, string>, L = 'es') => esContract(t.replace(/\{(\w+)\}/g, (_, k) => esMark(L, v[k]!)))

test('a value that starts with "el": "a el" → "al", "de el" → "del"; after ¿ and inside a sentence', () => {
  expect(fill('¿Quitar a {who} de {folder}?', { who: 'el grupo QA-Design', folder: 'Toda la empresa › SALL-Team' })).toBe('¿Quitar al grupo QA-Design de Toda la empresa › SALL-Team?')
  expect(fill('Se quitó a {who} de {folder}', { who: 'el grupo Ventas (3 personas)', folder: 'Informes' })).toBe('Se quitó al grupo Ventas (3 personas) de Informes')
  expect(fill('Las notas de {who}', { who: 'el grupo Ventas' })).toBe('Las notas del grupo Ventas')
})

test('left alone: other languages, a person, "El" with a capital, a list that starts with a person, the text\'s own words', () => {
  expect(fill('Take {who} off', { who: 'el grupo X' }, 'en')).toBe('Take el grupo X off')
  expect(fill('¿Quitar a {who}?', { who: 'Ana' })).toBe('¿Quitar a Ana?')
  expect(fill('Viaje a {place}', { place: 'El Salvador' })).toBe('Viaje a El Salvador')
  expect(fill('Se notificó a {who}.', { who: 'Ana y el grupo Ventas' })).toBe('Se notificó a Ana y el grupo Ventas.')
  expect(fill('con {who}', { who: 'el grupo Ventas' })).toBe('con el grupo Ventas')
  expect(esContract('a el')).toBe('a el')
})

test('no Spanish text of the folder card writes "a el" or "de el" itself', () => {
  for (const v of Object.values(FOLDER_TEXT)) expect((v as Record<string, string>).es).not.toMatch(/\b(a|de) el\b/)
})
