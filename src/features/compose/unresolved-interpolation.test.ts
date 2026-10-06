import { assertEquals } from '@std/assert'
import { findUnresolvedComposeInterpolations } from './unresolved-interpolation.ts'

Deno.test('flags ${VAR} the env file does not define', () => {
  const yaml = 'environment:\n  A: ${GREETING}\n  B: ${web__NAME}\n  C: $${ESCAPED}\n'
  assertEquals(findUnresolvedComposeInterpolations(yaml, 'web__NAME=x\n# c\n'), ['GREETING'])
  assertEquals(findUnresolvedComposeInterpolations('a: b', ''), [])
})
