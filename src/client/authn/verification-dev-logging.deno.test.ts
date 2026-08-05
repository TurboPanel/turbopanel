import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { isVerificationDevLoggingEnabled } from './http.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const KEYS = [
  'TURBOPANEL_DEV_SURFACE',
  'TURBOPANEL_MODE',
  'TURBOPANEL_UI_MODE',
] as const

function withEnv(
  overrides: Partial<Record<(typeof KEYS)[number], string | undefined>>,
  fn: () => void,
): void {
  const saved = new Map<string, string | undefined>()
  for (const key of KEYS) saved.set(key, Deno.env.get(key))
  try {
    for (const key of KEYS) {
      const value = overrides[key]
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

describe('isVerificationDevLoggingEnabled', () => {
  it('is disabled when TURBOPANEL_UI_MODE is unset', () => {
    withEnv({}, () => {
      assertEquals(
        isVerificationDevLoggingEnabled({
          runtime: 'deno',
          signupEnvOverride: undefined,
        }),
        false,
      )
    })
  })

  it('is disabled for TURBOPANEL_UI_MODE=dev without TURBOPANEL_MODE=development', () => {
    withEnv({ TURBOPANEL_UI_MODE: 'dev' }, () => {
      assertEquals(
        isVerificationDevLoggingEnabled({
          runtime: 'deno',
          signupEnvOverride: undefined,
        }),
        false,
      )
    })
  })

  it('is enabled only under explicit development (mode + ui pair)', () => {
    withEnv(
      { TURBOPANEL_MODE: 'development', TURBOPANEL_UI_MODE: 'dev' },
      () => {
        assertEquals(
          isVerificationDevLoggingEnabled({
            runtime: 'deno',
            signupEnvOverride: undefined,
          }),
          true,
        )
      },
    )
  })

  it('is enabled via TURBOPANEL_DEV_SURFACE=1', () => {
    withEnv({ TURBOPANEL_DEV_SURFACE: '1' }, () => {
      assertEquals(
        isVerificationDevLoggingEnabled({
          runtime: 'deno',
          signupEnvOverride: undefined,
        }),
        true,
      )
    })
  })

  it('never enables on Workers even in explicit development', () => {
    withEnv(
      { TURBOPANEL_MODE: 'development', TURBOPANEL_UI_MODE: 'dev' },
      () => {
        assertEquals(
          isVerificationDevLoggingEnabled({
            runtime: 'workers',
            signupEnvOverride: undefined,
          }),
          false,
        )
      },
    )
  })
})

// Keep Deno.test discovery happy when the file is run under `deno test`.
test('isVerificationDevLoggingEnabled suite loaded', () => {
  assertEquals(typeof isVerificationDevLoggingEnabled, 'function')
})
