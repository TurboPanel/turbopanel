/**
 * Host-free coverage for the deploy inputs digest: the part of `desiredHash`
 * that lets the host skip a redeploy which would change nothing.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import { deployInputsDigest } from './deploy-inputs-digest.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SHA = 'a'.repeat(40)

function inputs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceMaterial: [{ composeServiceName: 'web', commitSha: SHA, buildEnv: { A: '1' } }],
    secretVariables: [{ key: 'TOKEN', valueEnvelope: 'tpsecret.v1.same' }],
    hostings: [{ hostname: 'example.test', targetPort: 80 }],
    ...overrides,
  }
}

test('the same inputs digest the same, whatever the key order', async () => {
  const a = await deployInputsDigest(inputs())
  const b = await deployInputsDigest({
    hostings: [{ targetPort: 80, hostname: 'example.test' }],
    secretVariables: [{ valueEnvelope: 'tpsecret.v1.same', key: 'TOKEN' }],
    sourceMaterial: [{ buildEnv: { A: '1' }, commitSha: SHA, composeServiceName: 'web' }],
  })
  assertEquals(a, b)
})

test('a changed variable, commit, build input or hostname changes the digest', async () => {
  const base = await deployInputsDigest(inputs())
  const changed = [
    inputs({ secretVariables: [{ key: 'TOKEN', valueEnvelope: 'tpsecret.v1.other' }] }),
    inputs({
      sourceMaterial: [
        { composeServiceName: 'web', commitSha: 'b'.repeat(40), buildEnv: { A: '1' } },
      ],
    }),
    inputs({
      sourceMaterial: [{ composeServiceName: 'web', commitSha: SHA, buildEnv: { A: '2' } }],
    }),
    inputs({ hostings: [{ hostname: 'other.test', targetPort: 80 }] }),
  ]
  for (const entry of changed) {
    assertNotEquals(await deployInputsDigest(entry), base)
  }
})

test('a re-sealed credential does not change the digest', async () => {
  const withCredential = (credential: string) =>
    inputs({
      sourceMaterial: [
        { composeServiceName: 'web', commitSha: SHA, credential, buildEnv: { A: '1' } },
      ],
    })
  assertEquals(
    await deployInputsDigest(withCredential('tpdaemon.v1.first')),
    await deployInputsDigest(withCredential('tpdaemon.v1.second'))
  )
})

test('a value sealed afresh on every send is never taken as unchanged', async () => {
  const sealed = inputs({
    hostings: [{ hostname: 'example.test', secretEnv: { K: 'tpdaemon.v1.x' } }],
  })
  assertNotEquals(await deployInputsDigest(sealed), await deployInputsDigest(sealed))
})

test('a source whose commit is only a branch name is never taken as unchanged', async () => {
  const branchOnly = inputs({ sourceMaterial: [{ composeServiceName: 'web', commitSha: 'main' }] })
  assertNotEquals(await deployInputsDigest(branchOnly), await deployInputsDigest(branchOnly))
})

test('a changed linked-database login value (delivered as a secret variable) changes the digest', async () => {
  const login = (valueEnvelope: string) =>
    inputs({
      secretVariables: [{ key: 'DB_PASSWORD', composeServiceName: 'web', valueEnvelope }],
    })
  assertNotEquals(
    await deployInputsDigest(login('tpsecret.v1.before')),
    await deployInputsDigest(login('tpsecret.v1.after'))
  )
})
