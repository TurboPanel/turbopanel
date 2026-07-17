import { describe, expect, it } from 'vitest'
import {
  parsePublicUrlEntries,
  publicUrlEntryToInstallOrigin,
} from './public-urls.ts'
import { parseInstallBaseUrl } from '../lib/resolve-public-base-url.ts'

describe('publicUrlEntryToInstallOrigin', () => {
  it('accepts https origins in production (no allowance)', () => {
    expect(publicUrlEntryToInstallOrigin('https://panel.example.com')).toBe(
      'https://panel.example.com',
    )
  })

  it('rejects plaintext http origins in production (no allowance)', () => {
    expect(publicUrlEntryToInstallOrigin('http://panel.example.com')).toBeNull()
    expect(publicUrlEntryToInstallOrigin('http://dev.example.com:8880')).toBeNull()
  })

  it('allows plaintext http origins only with the dev-only allowance', () => {
    expect(
      publicUrlEntryToInstallOrigin('http://dev.example.com:8880', '8443', {
        allowHttp: true,
      }),
    ).toBe('http://dev.example.com:8880')
  })

  it('upgrades bare host entries to https regardless of allowance', () => {
    expect(publicUrlEntryToInstallOrigin('panel.example.com')).toBe(
      'https://panel.example.com:8443',
    )
  })
})

describe('parsePublicUrlEntries', () => {
  it('rejects plaintext http entries in production (no allowance)', () => {
    const parsed = parsePublicUrlEntries([
      'https://panel.example.com',
      'http://panel.example.com',
    ])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.invalid).toContain('http://panel.example.com')
    }
  })

  it('accepts only https origins in production', () => {
    const parsed = parsePublicUrlEntries(['https://panel.example.com'])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.urls).toEqual(['https://panel.example.com'])
    }
  })

  it('allows plaintext http entries only with the dev-only allowance', () => {
    const parsed = parsePublicUrlEntries(['http://dev.example.com:8880'], {
      allowHttp: true,
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.urls).toEqual(['http://dev.example.com:8880'])
    }
  })
})

describe('parseInstallBaseUrl', () => {
  it('accepts https base URLs in production (no allowance)', () => {
    expect(parseInstallBaseUrl('https://panel.example.com')).toBe(
      'https://panel.example.com',
    )
  })

  it('rejects plaintext http base URLs in production (no allowance)', () => {
    expect(parseInstallBaseUrl('http://panel.example.com')).toBeNull()
  })

  it('allows plaintext http base URLs only with the dev-only allowance', () => {
    expect(
      parseInstallBaseUrl('http://dev.example.com:8880', { allowHttp: true }),
    ).toBe('http://dev.example.com:8880')
  })
})
