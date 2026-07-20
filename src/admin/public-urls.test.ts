import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  parsePublicUrlEntries,
  publicUrlEntryToInstallOrigin,
} from './public-urls.ts'
import {
  parseInstallBaseUrl,
  resolvePublicBaseUrl,
} from '../lib/resolve-public-base-url.ts'

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

  it('rejects origins with paths, query strings, and credentials', () => {
    expect(
      publicUrlEntryToInstallOrigin('https://panel.example.com/admin'),
    ).toBeNull()
    expect(
      publicUrlEntryToInstallOrigin('https://panel.example.com?x=1'),
    ).toBeNull()
    expect(
      publicUrlEntryToInstallOrigin('https://user:pass@panel.example.com'),
    ).toBeNull()
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

  it('rejects shell metacharacters, paths, and query strings', () => {
    expect(
      parseInstallBaseUrl('https://panel.example.com; curl http://evil'),
    ).toBeNull()
    expect(parseInstallBaseUrl('https://panel.example.com/path')).toBeNull()
    expect(parseInstallBaseUrl('https://panel.example.com?x=$(id)')).toBeNull()
    expect(
      parseInstallBaseUrl('https://panel.example.com/`whoami`'),
    ).toBeNull()
  })
})

describe('resolvePublicBaseUrl forwarded-host validation', () => {
  async function resolveFromHeaders(
    headers: Record<string, string>,
  ): Promise<string> {
    const app = new Hono()
    app.get('/t', async (c) => c.text(await resolvePublicBaseUrl(c)))
    const res = await app.request('https://internal.invalid/t', { headers })
    return res.text()
  }

  it('accepts a clean https forwarded host', async () => {
    const origin = await resolveFromHeaders({
      'x-forwarded-host': 'panel.example.com',
      'x-forwarded-proto': 'https',
    })
    expect(origin).toBe('https://panel.example.com')
  })

  it('ignores spoofed forwarded hosts with semicolons and command injection', async () => {
    const origin = await resolveFromHeaders({
      'x-forwarded-host': 'evil.example; curl http://attacker.example',
      'x-forwarded-proto': 'https',
    })
    expect(origin).not.toContain(';')
    expect(origin).not.toContain('curl')
    expect(origin).not.toContain('attacker.example')
  })

  it('ignores forwarded hosts with spaces, paths, and query strings', async () => {
    const withPath = await resolveFromHeaders({
      'x-forwarded-host': 'panel.example.com/admin',
      'x-forwarded-proto': 'https',
    })
    expect(withPath).not.toContain('/admin')

    const withQuery = await resolveFromHeaders({
      'x-forwarded-host': 'panel.example.com?x=$(id)',
      'x-forwarded-proto': 'https',
    })
    expect(withQuery).not.toContain('$(id)')
    expect(withQuery).not.toContain('?')

    const withSpaces = await resolveFromHeaders({
      'x-forwarded-host': 'panel example.com',
      'x-forwarded-proto': 'https',
    })
    expect(withSpaces).not.toContain('panel example')
  })

  it('ignores plaintext http forwarded origins in production', async () => {
    const origin = await resolveFromHeaders({
      'x-forwarded-host': 'panel.example.com',
      'x-forwarded-proto': 'http',
    })
    // http://panel.example.com is rejected without allowHttp — fall through.
    expect(origin).not.toBe('http://panel.example.com')
  })
})
