import { describe, expect, test } from 'bun:test'
import { addressToTell } from '../../src/lib/team-address'

describe('the new team address to tell the team after a saved change (QA TC-1232)', () => {
  test('a relay rename is followed by the apps: nothing to tell', () => {
    expect(addressToTell('https://acme.example.com', 'https://acme-sales.example.com')).toBeNull()
  })
  test('another relay or domain: tell the new address', () => {
    expect(addressToTell('https://acme.example.com', 'https://acme.example.org')).toBe('acme.example.org')
    expect(addressToTell('https://acme.example.com', 'https://team.other.net')).toBe('team.other.net')
  })
  test('nothing before, nothing now, or no change: nothing to tell', () => {
    expect(addressToTell(null, 'https://acme.example.org')).toBeNull()
    expect(addressToTell('https://acme.example.com', null)).toBeNull()
    expect(addressToTell('https://acme.example.com', 'https://acme.example.com')).toBeNull()
  })
  test('an office address over plain http is told with its http:// as people type it', () => {
    expect(addressToTell('https://acme.example.com', 'http://192.168.1.2:19300')).toBe('http://192.168.1.2:19300')
  })
})
