import { assertEquals } from '@std/assert'
import {
  DEFAULT_PRINCIPAL_SHELL,
  isValidPrincipalIdOverride,
  parsePrincipalOptions,
  parsePrincipalOptionsInput,
  resolvePrincipalIdOverride,
  resolvePrincipalShell,
} from './principal-options.ts'
import {
  PRINCIPAL_RESERVED_UID_MAX,
  PRINCIPAL_RESERVED_UID_MIN,
  PRINCIPAL_UID_START,
} from './naming.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parsePrincipalOptions accepts absolute shell paths', () => {
  assertEquals(parsePrincipalOptions({ shell: '/bin/bash' }), { shell: '/bin/bash' })
  assertEquals(parsePrincipalOptions({ shell: ' /usr/bin/zsh ' }), {
    shell: '/usr/bin/zsh',
  })
})

test('parsePrincipalOptions drops invalid shells', () => {
  assertEquals(parsePrincipalOptions({ shell: 'bash' }), {})
  assertEquals(parsePrincipalOptions({ shell: '/bin/bash extra' }), {})
  assertEquals(parsePrincipalOptions({ shell: '/bin/bash\n' }), {})
  assertEquals(parsePrincipalOptions({ shell: '' }), {})
  assertEquals(parsePrincipalOptions({ shell: '/usr/bin/../bin/bash' }), {})
  assertEquals(parsePrincipalOptions({ shell: '/../bin/bash' }), {})
  assertEquals(parsePrincipalOptions(null), {})
})

test('parsePrincipalOptions accepts a valid uid/gid override pair', () => {
  assertEquals(
    parsePrincipalOptions({ shell: '/bin/bash', uid: 10001, gid: 10001 }),
    { shell: '/bin/bash', uid: 10001, gid: 10001 },
  )
})

test('parsePrincipalOptions drops a partial or invalid uid/gid pair', () => {
  assertEquals(parsePrincipalOptions({ uid: 10001 }), {})
  assertEquals(parsePrincipalOptions({ uid: 10001, gid: 9999 }), {})
  assertEquals(parsePrincipalOptions({ uid: 5000, gid: 5000 }), {})
  assertEquals(parsePrincipalOptions({ uid: 1.5, gid: 10001 }), {})
})

test('parsePrincipalOptionsInput defaults omitted/null/empty options to nologin', () => {
  assertEquals(parsePrincipalOptionsInput(undefined), {
    ok: true,
    value: { shell: DEFAULT_PRINCIPAL_SHELL },
  })
  assertEquals(parsePrincipalOptionsInput(null), {
    ok: true,
    value: { shell: DEFAULT_PRINCIPAL_SHELL },
  })
  assertEquals(parsePrincipalOptionsInput({}), {
    ok: true,
    value: { shell: DEFAULT_PRINCIPAL_SHELL },
  })
})

test('parsePrincipalOptionsInput accepts a valid shell', () => {
  assertEquals(parsePrincipalOptionsInput({ shell: '/bin/bash' }), {
    ok: true,
    value: { shell: '/bin/bash' },
  })
  assertEquals(parsePrincipalOptionsInput({ shell: ' /usr/bin/zsh ' }), {
    ok: true,
    value: { shell: '/usr/bin/zsh' },
  })
})

test('parsePrincipalOptionsInput accepts uid/gid at or above the override floor', () => {
  assertEquals(
    parsePrincipalOptionsInput({ uid: 10001, gid: 10002 }),
    { ok: true, value: { shell: DEFAULT_PRINCIPAL_SHELL, uid: 10001, gid: 10002 } },
  )
})

test('parsePrincipalOptionsInput rejects invalid or one-of-two uid/gid overrides', () => {
  assertEquals(parsePrincipalOptionsInput({ uid: 10001 }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ gid: 10001 }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ uid: 9999, gid: 9999 }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ uid: 5000, gid: 5000 }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ uid: 1.5, gid: 10001 }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ uid: '10001', gid: 10001 }), { ok: false })
})

test('parsePrincipalOptionsInput rejects non-object options and malformed shells', () => {
  assertEquals(parsePrincipalOptionsInput('bash'), { ok: false })
  assertEquals(parsePrincipalOptionsInput(['/bin/bash']), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: 'bash' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: '/bin/bash extra' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: '/bin/bash\n' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: '' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: 1 }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: '/usr/bin/../bin/bash' }), {
    ok: false,
  })
  assertEquals(parsePrincipalOptionsInput({ shell: '/../etc/passwd' }), {
    ok: false,
  })
})

test('resolvePrincipalShell defaults to nologin', () => {
  assertEquals(resolvePrincipalShell(undefined), DEFAULT_PRINCIPAL_SHELL)
  assertEquals(resolvePrincipalShell({}), DEFAULT_PRINCIPAL_SHELL)
  assertEquals(resolvePrincipalShell({ shell: '/bin/bash' }), '/bin/bash')
})

test('isValidPrincipalIdOverride enforces floor and reserved service band', () => {
  assertEquals(isValidPrincipalIdOverride(PRINCIPAL_UID_START), true)
  assertEquals(isValidPrincipalIdOverride(PRINCIPAL_UID_START + 1), true)
  assertEquals(isValidPrincipalIdOverride(PRINCIPAL_RESERVED_UID_MIN), false)
  assertEquals(isValidPrincipalIdOverride(PRINCIPAL_RESERVED_UID_MAX), false)
  assertEquals(isValidPrincipalIdOverride(PRINCIPAL_UID_START - 1), false)
  assertEquals(isValidPrincipalIdOverride(1.5), false)
})

test('resolvePrincipalIdOverride returns a pair or null', () => {
  assertEquals(resolvePrincipalIdOverride({ uid: 10001, gid: 10001 }), {
    uid: 10001,
    gid: 10001,
  })
  assertEquals(resolvePrincipalIdOverride({ uid: 10001 }), null)
  assertEquals(resolvePrincipalIdOverride({}), null)
})
