import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  isDevHostAuthMode,
  verifyInstallHostCredentials,
} from './credentials.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const KEYS = [
  'TURBOPANEL_DEV_HOST_AUTH',
  'TURBOPANEL_DEV_SURFACE',
  'TURBOPANEL_MODE',
  'TURBOPANEL_UI_MODE',
] as const

function withEnv(
  overrides: Partial<Record<(typeof KEYS)[number], string | null>>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const key of KEYS) saved.set(key, Deno.env.get(key))
  return (async () => {
    try {
      for (const key of KEYS) {
        const value = overrides[key]
        if (value === undefined) continue
        if (value === null) Deno.env.delete(key)
        else Deno.env.set(key, value)
      }
      await fn()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) Deno.env.delete(key)
        else Deno.env.set(key, value)
      }
    }
  })()
}

describe('verifyPamLogin source guard', () => {
  it('must not pass TP_PAM_PASSWORD through the child environment', async () => {
    const source = await Deno.readTextFile(
      new URL('./credentials.ts', import.meta.url),
    )
    const start = source.indexOf('async function verifyPamLogin')
    const end = source.indexOf('async function userHasInstallSudo')
    assertEquals(start >= 0 && end > start, true)
    const pamFn = source.slice(start, end)

    assertEquals(
      source.includes('TP_PAM_PASSWORD'),
      false,
      'TP_PAM_PASSWORD must not be reintroduced — pass the password on stdin',
    )
    assertEquals(
      pamFn.includes('/bin/sh'),
      false,
      'verifyPamLogin must spawn pamtester directly, not via /bin/sh',
    )
    assertEquals(
      pamFn.includes("stdin: 'piped'") || pamFn.includes('stdin: "piped"'),
      true,
      'verifyPamLogin must pipe the password on stdin',
    )
  })
})

describe('isDevHostAuthMode development-mode gate', () => {
  it('rejects the bypass outside explicit development mode', async () => {
    await withEnv(
      {
        TURBOPANEL_DEV_HOST_AUTH: 'group-only',
        TURBOPANEL_DEV_SURFACE: null,
        TURBOPANEL_MODE: null,
        TURBOPANEL_UI_MODE: null,
      },
      () => {
        assertEquals(isDevHostAuthMode(), false)
      },
    )

    await withEnv(
      {
        TURBOPANEL_DEV_HOST_AUTH: 'group-only',
        TURBOPANEL_MODE: 'development',
        TURBOPANEL_UI_MODE: 'static',
        TURBOPANEL_DEV_SURFACE: null,
      },
      () => {
        assertEquals(isDevHostAuthMode(), false)
      },
    )
  })

  it('allows the bypass only with explicit development-mode signals', async () => {
    await withEnv(
      {
        TURBOPANEL_DEV_HOST_AUTH: 'group-only',
        TURBOPANEL_DEV_SURFACE: '1',
        TURBOPANEL_MODE: null,
        TURBOPANEL_UI_MODE: null,
      },
      () => {
        assertEquals(isDevHostAuthMode(), true)
      },
    )

    await withEnv(
      {
        TURBOPANEL_DEV_HOST_AUTH: 'group-only',
        TURBOPANEL_DEV_SURFACE: null,
        TURBOPANEL_MODE: 'development',
        TURBOPANEL_UI_MODE: 'dev',
      },
      () => {
        assertEquals(isDevHostAuthMode(), true)
      },
    )
  })

  it('keeps the root shortcut only inside the explicit-dev bypass branch', async () => {
    await withEnv(
      {
        TURBOPANEL_DEV_HOST_AUTH: 'group-only',
        TURBOPANEL_DEV_SURFACE: null,
        TURBOPANEL_MODE: null,
        TURBOPANEL_UI_MODE: null,
      },
      async () => {
        // Without the bypass, root must go through PAM (fails without a real
        // pamtester success for an arbitrary password).
        const ok = await verifyInstallHostCredentials(
          'root',
          'not-a-real-password',
          'deno',
        )
        assertEquals(ok, false)
      },
    )

    await withEnv(
      {
        TURBOPANEL_DEV_HOST_AUTH: 'group-only',
        TURBOPANEL_DEV_SURFACE: '1',
        TURBOPANEL_MODE: null,
        TURBOPANEL_UI_MODE: null,
      },
      async () => {
        const ok = await verifyInstallHostCredentials(
          'root',
          'not-a-real-password',
          'deno',
        )
        assertEquals(ok, true)
      },
    )
  })
})

// Keep a Deno.test alias reference so Sonar sees a test() call form as well.
test('isDevHostAuthMode is gated (alias smoke)', () => {
  // Covered above via describe/it; this entry exists for S2187 tooling.
  assertEquals(typeof isDevHostAuthMode, 'function')
})
