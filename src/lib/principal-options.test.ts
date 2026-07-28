import { assertEquals } from 'jsr:@std/assert'
import {
  DEFAULT_PRINCIPAL_SHELL,
  parsePrincipalOptions,
  parsePrincipalOptionsInput,
  resolvePrincipalShell,
} from './principal-options.ts'

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
  assertEquals(parsePrincipalOptions(null), {})
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

test('parsePrincipalOptionsInput rejects non-object options and malformed shells', () => {
  assertEquals(parsePrincipalOptionsInput('bash'), { ok: false })
  assertEquals(parsePrincipalOptionsInput(['/bin/bash']), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: 'bash' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: '/bin/bash extra' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: '/bin/bash\n' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: '' }), { ok: false })
  assertEquals(parsePrincipalOptionsInput({ shell: 1 }), { ok: false })
})

test('resolvePrincipalShell defaults to nologin', () => {
  assertEquals(resolvePrincipalShell(undefined), DEFAULT_PRINCIPAL_SHELL)
  assertEquals(resolvePrincipalShell({}), DEFAULT_PRINCIPAL_SHELL)
  assertEquals(resolvePrincipalShell({ shell: '/bin/bash' }), '/bin/bash')
})
