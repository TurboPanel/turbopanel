import { describe, expect, it } from 'vitest'
import { parseSignupBody } from './http.ts'

// Direct sign-up API tests: parseSignupBody gates POST /api/client/v1/auth/sign-up
// and must reject weak passwords that the old min-length-only policy accepted,
// so a direct API call cannot bypass the UI's password requirements.
describe('parseSignupBody password policy', () => {
  const email = 'new-user@example.com'

  it('rejects a password with no digit or special character', () => {
    const result = parseSignupBody({ email, password: 'abcdefgh' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Password must include at least one number')
    }
  })

  it('rejects a digits-only password (no special character)', () => {
    const result = parseSignupBody({ email, password: '12345678' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe(
        'Password must include at least one special character',
      )
    }
  })

  it('rejects a password with leading/trailing whitespace', () => {
    const result = parseSignupBody({ email, password: ' passw0rd! ' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe(
        'Password must not have leading or trailing whitespace',
      )
    }
  })

  it('accepts a password that satisfies every rule', () => {
    const result = parseSignupBody({ email, password: 'sup3r-secret!' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.email).toBe(email)
      expect(result.password).toBe('sup3r-secret!')
    }
  })
})
