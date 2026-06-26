import { describe, expect, it } from 'vitest'
import {
  getClientPublicStatus,
  normalizeSignupEnvOverride,
  resolveIsSignupEnabled,
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

describe('getClientPublicStatus (Workers)', () => {
  it('reflects numeric and string signup env bindings without a database', async () => {
    await expect(getClientPublicStatus(undefined, 'workers', 1)).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
    })
    await expect(getClientPublicStatus(undefined, 'workers', 0)).resolves.toEqual({
      ok: true,
      isSignupEnabled: false,
    })
    await expect(getClientPublicStatus(undefined, 'workers', '1')).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
    })
    await expect(getClientPublicStatus(undefined, 'workers', '0')).resolves.toEqual({
      ok: true,
      isSignupEnabled: false,
    })
  })

  it('defaults signup to enabled on Workers when env is unset', async () => {
    await expect(getClientPublicStatus(undefined, 'workers', undefined)).resolves.toEqual({
      ok: true,
      isSignupEnabled: true,
    })
  })
})
