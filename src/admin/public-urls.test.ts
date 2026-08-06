import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  hostFromPublicUrlEntry,
  parsePublicUrlEntries,
  publicUrlEntryToInstallOrigin,
} from './public-urls.ts'
import {
  parseInstallBaseUrl,
  resolvePublicBaseUrl,
} from '../lib/resolve-public-base-url.ts'

describe('hostFromPublicUrlEntry', () => {
  it('returns null for empty and whitespace-only entries', () => {
    expect(hostFromPublicUrlEntry('')).toBeNull()
    expect(hostFromPublicUrlEntry('   ')).toBeNull()
  })

  it('extracts hostname from https and bare host entries', () => {
    expect(hostFromPublicUrlEntry('https://panel.example.com')).toBe(
      'panel.example.com',
    )
    expect(hostFromPublicUrlEntry('panel.example.com')).toBe('panel.example.com')
    expect(hostFromPublicUrlEntry('  panel.example.com:8443  ')).toBe(
      'panel.example.com',
    )
  })

  it('strips IPv6 brackets from literal hosts', () => {
    expect(hostFromPublicUrlEntry('https://[2001:db8::1]')).toBe('2001:db8::1')
    expect(hostFromPublicUrlEntry('[2001:db8::1]:8443')).toBe('2001:db8::1')
  })

  it('rejects localhost, null host, and invalid URLs', () => {
    expect(hostFromPublicUrlEntry('localhost')).toBeNull()
    expect(hostFromPublicUrlEntry('https://localhost')).toBeNull()
    expect(hostFromPublicUrlEntry('null')).toBeNull()
    expect(hostFromPublicUrlEntry('not a url')).toBeNull()
    expect(hostFromPublicUrlEntry('://missing-scheme')).toBeNull()
  })

  it('extracts hostname from http entries without validating scheme', () => {
    expect(hostFromPublicUrlEntry('http://panel.example.com')).toBe(
      'panel.example.com',
    )
  })
})

describe('publicUrlEntryToInstallOrigin', () => {
  it('returns null for empty entries', () => {
    expect(publicUrlEntryToInstallOrigin('')).toBeNull()
    expect(publicUrlEntryToInstallOrigin('   ')).toBeNull()
  })

  it('accepts https origins in production (no allowance)', () => {
    expect(publicUrlEntryToInstallOrigin('https://panel.example.com')).toBe(
      'https://panel.example.com',
    )
    expect(
      publicUrlEntryToInstallOrigin('https://panel.example.com:9443'),
    ).toBe('https://panel.example.com:9443')
  })

  it('trims trailing slashes from https origins', () => {
    expect(publicUrlEntryToInstallOrigin('https://panel.example.com/')).toBe(
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

  it('honors explicit port on bare host entries and custom default port', () => {
    expect(publicUrlEntryToInstallOrigin('panel.example.com:9443')).toBe(
      'https://panel.example.com:9443',
    )
    expect(publicUrlEntryToInstallOrigin('panel.example.com', '9443')).toBe(
      'https://panel.example.com:9443',
    )
  })

  it('formats IPv6 bare hosts with brackets in the install origin', () => {
    expect(publicUrlEntryToInstallOrigin('https://[2001:db8::1]:9443')).toBe(
      'https://[2001:db8::1]:9443',
    )
    // Bracketed bare entries keep URL parser brackets; formatHostForUrl re-wraps.
    expect(publicUrlEntryToInstallOrigin('[2001:db8::1]')).toBe(
      'https://[[2001:db8::1]]:8443',
    )
  })

  it('rejects non-http(s) schemes, localhost, and null host', () => {
    expect(publicUrlEntryToInstallOrigin('ftp://panel.example.com')).toBeNull()
    expect(publicUrlEntryToInstallOrigin('localhost')).toBeNull()
    expect(publicUrlEntryToInstallOrigin('null')).toBeNull()
  })

  it('rejects bare hosts with path-like or credential characters', () => {
    expect(publicUrlEntryToInstallOrigin('panel.example.com/admin')).toBeNull()
    expect(publicUrlEntryToInstallOrigin('panel.example.com?x=1')).toBeNull()
    expect(publicUrlEntryToInstallOrigin('user@panel.example.com')).toBeNull()
  })

  it('rejects origins with paths, query strings, hashes, and credentials', () => {
    expect(
      publicUrlEntryToInstallOrigin('https://panel.example.com/admin'),
    ).toBeNull()
    expect(
      publicUrlEntryToInstallOrigin('https://panel.example.com?x=1'),
    ).toBeNull()
    expect(
      publicUrlEntryToInstallOrigin('https://panel.example.com#frag'),
    ).toBeNull()
    expect(
      publicUrlEntryToInstallOrigin('https://user:pass@panel.example.com'),
    ).toBeNull()
  })
})

describe('parsePublicUrlEntries', () => {
  it('returns an empty list for no entries', () => {
    const parsed = parsePublicUrlEntries([])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.urls).toEqual([])
    }
  })

  it('rejects plaintext http entries in production (no allowance)', () => {
    const parsed = parsePublicUrlEntries([
      'https://panel.example.com',
      'http://panel.example.com',
    ])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toBe('One or more public URL entries are invalid')
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

  it('normalizes bare host and host:port entries', () => {
    const parsed = parsePublicUrlEntries([
      'panel.example.com',
      'backup.example.com:9443',
    ])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.urls).toEqual(['panel.example.com', 'backup.example.com:9443'])
    }
  })

  it('deduplicates repeated https origins and trailing-slash variants', () => {
    const parsed = parsePublicUrlEntries([
      'https://panel.example.com',
      'https://panel.example.com/',
      'https://panel.example.com',
    ])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.urls).toEqual(['https://panel.example.com'])
    }
  })

  it('reports every invalid entry and rejects the whole batch', () => {
    const parsed = parsePublicUrlEntries([
      'https://panel.example.com',
      'localhost',
      '',
      'https://panel.example.com/admin',
    ])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.invalid).toEqual([
        'localhost',
        '',
        'https://panel.example.com/admin',
      ])
    }
  })

  it('rejects localhost, null host, and non-origin https URLs', () => {
    const parsed = parsePublicUrlEntries([
      'localhost',
      'null',
      'https://panel.example.com?x=1',
    ])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.invalid).toHaveLength(3)
    }
  })

  it('accepts IPv6 bare host entries with explicit ports', () => {
    const parsed = parsePublicUrlEntries(['[2001:db8::1]:9443'])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.urls).toEqual(['[2001:db8::1]:9443'])
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
