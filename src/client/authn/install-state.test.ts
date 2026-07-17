import { describe, expect, it } from 'vitest'
import {
  getClientPublicStatus,
  normalizeSignupEnvOverride,
  resolveIsSignupEnabled,
  validateSuperadminPassword,
} from './install-state.ts'

describe('normalizeSignupEnvOverride', () => {
  it('returns undefined for nullish values', () => {
    expect(normalizeSignupEnvOverride(undefined)).toBeUndefined()
    expect(normalizeSignupEnvOverride(null)).toBeUndefined()
    expect(normalizeSignupEnvOverride('')).toBeUndefined()
    expect(normalizeSignupEnvOverride('   ')).toBeUndefined()
  })

  it('normalizes booleans and numbers', () => {
    expect(normalizeSignupEnvOverride(true)).toBe('1')
    expect(normalizeSignupEnvOverride(false)).toBe('0')
    expect(normalizeSignupEnvOverride(1)).toBe('1')
    expect(normalizeSignupEnvOverride(0)).toBe('0')
  })

  it('trims string bindings', () => {
    expect(normalizeSignupEnvOverride('  true  ')).toBe('true')
    expect(normalizeSignupEnvOverride('1')).toBe('1')
  })
})

describe('resolveIsSignupEnabled', () => {
  it('honors string and boolean env overrides', () => {
    expect(resolveIsSignupEnabled(undefined, '1', { runtime: 'workers' })).toBe(
      true,
    )
    expect(resolveIsSignupEnabled(undefined, 'true', { runtime: 'workers' })).toBe(
      true,
    )
    expect(resolveIsSignupEnabled(undefined, '0', { runtime: 'workers' })).toBe(
      false,
    )
    expect(resolveIsSignupEnabled(undefined, false, { runtime: 'workers' })).toBe(
      false,
    )
  })

  it('honors numeric env bindings from Wrangler', () => {
    expect(resolveIsSignupEnabled(undefined, 1, { runtime: 'workers' })).toBe(true)
    expect(resolveIsSignupEnabled(undefined, 0, { runtime: 'workers' })).toBe(false)
    expect(resolveIsSignupEnabled('0', 1, { runtime: 'workers' })).toBe(true)
  })

  it('falls back to DB when env is unrecognized', () => {
    expect(resolveIsSignupEnabled('1', 'maybe', { runtime: 'workers' })).toBe(
      true,
    )
    expect(resolveIsSignupEnabled('0', 'maybe', { runtime: 'deno' })).toBe(false)
  })

  it('defaults Workers bootstrap to enabled when unset', () => {
    expect(resolveIsSignupEnabled(undefined, undefined, { runtime: 'workers' })).toBe(
      true,
    )
    expect(resolveIsSignupEnabled(undefined, undefined, { runtime: 'deno' })).toBe(
      false,
    )
  })
})

describe('validateSuperadminPassword (canonical server policy)', () => {
  // This validator is the single server-side gate shared by the install wizard,
  // sign-up, and password reset. It must reject weak passwords that the old
  // min-length-only rule accepted, matching the UI mirror.
  it('rejects weak passwords that passed the old min-length-only rule', () => {
    // 8+ chars but no digit and no special char.
    expect(validateSuperadminPassword('abcdefgh')).toBe(
      'Password must include at least one number',
    )
    // Digits only, no special char.
    expect(validateSuperadminPassword('12345678')).toBe(
      'Password must include at least one special character',
    )
    // Letters + digit but no special char.
    expect(validateSuperadminPassword('password1')).toBe(
      'Password must include at least one special character',
    )
  })

  it('rejects passwords shorter than the minimum length', () => {
    expect(validateSuperadminPassword('aB1!')).toBe(
      'Password must be at least 8 characters',
    )
  })

  it('rejects passwords with leading or trailing whitespace', () => {
    expect(validateSuperadminPassword(' passw0rd! ')).toBe(
      'Password must not have leading or trailing whitespace',
    )
    expect(validateSuperadminPassword('passw0rd!\n')).toBe(
      'Password must not have leading or trailing whitespace',
    )
  })

  it('accepts a password that satisfies every rule', () => {
    expect(validateSuperadminPassword('sup3r-secret!')).toBeNull()
  })
})

describe('getClientPublicStatus (Workers)', () => {
  it('reflects numeric and string signup env bindings without a database', async () => {
    await expect(getClientPublicStatus(undefined, 'workers', 1)).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
      isSignupEmailVerificationEnabled: false,
    })
    await expect(getClientPublicStatus(undefined, 'workers', 0)).resolves.toEqual({
      ok: true,
      isSignupEnabled: false,
      isSignupEmailVerificationEnabled: false,
    })
    await expect(getClientPublicStatus(undefined, 'workers', '1')).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
      isSignupEmailVerificationEnabled: false,
    })
    await expect(getClientPublicStatus(undefined, 'workers', '0')).resolves.toEqual({
      ok: true,
      isSignupEnabled: false,
      isSignupEmailVerificationEnabled: false,
    })
  })

  it('defaults signup to enabled on Workers when env is unset', async () => {
    await expect(getClientPublicStatus(undefined, 'workers')).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
      isSignupEmailVerificationEnabled: false,
    })
  })

  it('enables email verification when Workers mailgun provider is configured', async () => {
    await expect(
      getClientPublicStatus(undefined, 'workers', '1', {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
        TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-abc',
        TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
      }),
    ).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
      isSignupEmailVerificationEnabled: true,
    })
  })

  it('disables email verification when Workers has no email delivery configured', async () => {
    await expect(
      getClientPublicStatus(undefined, 'workers', '1', {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
      }),
    ).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
      isSignupEmailVerificationEnabled: false,
    })
  })
})
