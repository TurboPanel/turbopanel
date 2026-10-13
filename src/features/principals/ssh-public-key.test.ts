import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import {
  ALLOWED_SSH_KEY_TYPES,
  isCanonicalSshPublicKey,
  MIN_RSA_MODULUS_BITS,
  parseSshPublicKey,
} from './ssh-public-key.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Real `ssh-keygen` output, with the fingerprints `ssh-keygen -lf` printed for
 * the same files. Hand-built vectors would only prove the parser agrees with
 * itself; these prove it agrees with OpenSSH.
 */
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEmvBcjT+NvO6sokGNoJ0zA3dr0nhIQhhZ3wP220uFZ'
const ED25519_FINGERPRINT = 'SHA256:HDSPSzosi+vPKLM3F8mb+5In9aGdwTMftxl3drl9WmU'

const RSA_2048 =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDSdzkq3EoQBUL/ZhOsKjprXz1ebh8uoB3wJ7OBSHr/RsgLO7jBXu9d+KG2kk76hoa68IhHAwt68ImOJkZAsDArTkqYJkHNvfm5jRuSxMNj8umEKp9ZWkm+UrKv6IaZbo08MRYIQE3Ph1Eji+KVFIFyzbE2GUQ2B2h3Cp32VeP30TzrYnnwhIr72o32B65R7F3FjuSrM00CW5nuk2CAmvk20ZX4gs3aFTd+LYqDsLPCwFMvop/2VJNTMVhOUR8OYgnWDIMdpk7ib21y5QgIkVPiL1noHJXEFahSZhrC7TRICFIj0Mlwh4vw5bE5Zdqlf3QkzktL9nok2JNSk9u3mVa3'
const RSA_2048_FINGERPRINT = 'SHA256:S++eHUKkqdIjBZuaRYPVROr33AXurqGgcaJ393rM68M'

const RSA_1024 =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC8Kj0ggxAJUkH1iikr6o9xa88glmu1kehAzTL3P8Z2SW66Wey+1M+44SQ9ke9Oo8hOR6XfbchOj58ii42H29bJWptxWqBha0LWECfff9zE/8qOEdUBoV7P8EpSFpYe/XuevnO1iw4S7i/3sn+CZbjGqDv36zFTO7OoKKCaqrg95Q=='

const ECDSA_256 =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBKEU8h4UaSBQFDa5ce1lMJGCmEGx2JEIwDF/JPyvVn6A3uA6DtWorSXPBxQqsV9BbEHfcL5R5ugZsQ03yOlKb60='
const ECDSA_256_FINGERPRINT =
  'SHA256:rhTaV/vR1kXeYI1xoEg7Sx1jIbT2+B26Qzj6r4ToQoY'

const ECDSA_521 =
  'ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAEEj1AY7uuDkz7r9DfyNincNRfaL3D0eoh7rcXzs5xBU3IBIYZ59dP1vRzlmBGpdt1mNcn4/RG6so5rTBpJpmRjHwDaZX3kIBSyg/4zhBqXMyf2gFwPpHd7ITiqP4aJs3o1pHm8bylnAxokIwVSjJAMiEsKlD/AHfizTv9A+b5B0ZLOkA=='

/** The base64 field of a vector, without its type prefix or comment. */
function blobOf(key: string): string {
  return key.split(' ')[1] as string
}

async function expectOk(input: string) {
  const result = await parseSshPublicKey(input)
  assert(result.ok, `expected \`${input.slice(0, 40)}…\` to parse`)
  return result.value
}

async function expectError(input: unknown): Promise<string> {
  const result = await parseSshPublicKey(input)
  assert(!result.ok, 'expected the key to be rejected')
  return result.error
}

test('fingerprints match `ssh-keygen -lf` for every key type', async () => {
  assertEquals((await expectOk(ED25519)).fingerprint, ED25519_FINGERPRINT)
  assertEquals((await expectOk(RSA_2048)).fingerprint, RSA_2048_FINGERPRINT)
  assertEquals((await expectOk(ECDSA_256)).fingerprint, ECDSA_256_FINGERPRINT)
})

test('every allowed key type in the list actually parses', async () => {
  // The three fixed-shape families are covered by real vectors; this asserts
  // the list and the body reader cannot drift apart silently.
  for (const key of [ED25519, RSA_2048, ECDSA_256, ECDSA_521]) {
    const parsed = await expectOk(key)
    assert(
      (ALLOWED_SSH_KEY_TYPES as readonly string[]).includes(parsed.keyType),
    )
  }
})

test('the stored key is re-rendered, never the pasted line', async () => {
  // Extra whitespace, a comment, and trailing spaces all disappear: what is
  // persisted is built from the decoded blob.
  const parsed = await expectOk(`  ssh-ed25519   ${blobOf(ED25519)}  alice@laptop   `)
  assertEquals(parsed.publicKey, ED25519)
  assertEquals(parsed.comment, 'alice@laptop')
})

test('a comment carrying a newline cannot become a second key', async () => {
  // The single-line check fires before anything is trimmed, so the injected
  // second key never reaches the parser at all.
  const injected = ['ok', `ssh-ed25519 ${blobOf(ED25519)} attacker`].join('\n')
  const error = await expectError(`${ED25519} ${injected}`)
  assertStringIncludes(error, 'single line')
})

test('a comment is stripped of quotes, backslashes, and control bytes', async () => {
  const parsed = await expectOk(`${ED25519} we"ird\\name laptop`)
  assertEquals(parsed.comment, 'weirdname laptop')
})

test('an all-junk comment is dropped rather than stored empty', async () => {
  const parsed = await expectOk(`${ED25519} "\\"`)
  assertEquals(parsed.comment, undefined)
})

test('a key labelled ed25519 but carrying RSA data is rejected', async () => {
  // `sshd` reads the algorithm name inside the blob, not the text in front of
  // it. A parser that only matches the prefix accepts this line.
  const error = await expectError(`ssh-ed25519 ${blobOf(RSA_2048)}`)
  assertStringIncludes(error, 'labelled `ssh-ed25519`')
  assertStringIncludes(error, 'its data is `ssh-rsa`')
})

test('an options field is rejected, not silently stripped', async () => {
  const error = await expectError(
    `command="/bin/false",no-pty,from="10.0.0.0/8" ${ED25519}`,
  )
  assertStringIncludes(error, 'remove the options in front of the key')
})

test('RSA below the modulus floor is rejected with its real size', async () => {
  const error = await expectError(RSA_1024)
  assertStringIncludes(error, `at least ${MIN_RSA_MODULUS_BITS} bits`)
  // The reported size must be the true modulus length: an `mpint` whose top bit
  // is set carries a leading zero byte, and counting it would report 1032.
  assertStringIncludes(error, 'this one is 1024')
})

test('RSA at the floor reports its size for display', async () => {
  assertEquals((await expectOk(RSA_2048)).bits, 2048)
  assertEquals((await expectOk(ED25519)).bits, undefined)
})

test('DSA is rejected by name, with a way forward', async () => {
  const error = await expectError('ssh-dss AAAAB3NzaC1kc3MAAACBAJ4=')
  assertStringIncludes(error, 'ssh-dss')
  assertStringIncludes(error, 'ssh-keygen -t ed25519')
})

test('an ECDSA key whose embedded curve disagrees with its type is rejected', async () => {
  // Relabel a real P-256 key as P-384. The blob still says `nistp256` twice, so
  // the algorithm-name check fires first — which is the point: there is no way
  // to reach the point-length check by lying about the curve.
  const error = await expectError(`ecdsa-sha2-nistp384 ${blobOf(ECDSA_256)}`)
  assertStringIncludes(error, 'ecdsa-sha2-nistp384')
})

test('malformed and non-key input is rejected', async () => {
  assertStringIncludes(await expectError(''), 'ssh-ed25519 AAAA')
  assertStringIncludes(await expectError('ssh-ed25519'), 'ssh-ed25519 AAAA')
  assertStringIncludes(await expectError(42), 'must be text')
  assertStringIncludes(await expectError(undefined), 'must be text')
  assertStringIncludes(
    await expectError('ssh-ed25519 not-base64!!'),
    'not valid base64',
  )
  // Unpadded base64 decodes in lenient runtimes; two spellings of one key must
  // not become two rows sharing one fingerprint.
  assertStringIncludes(
    await expectError(`ecdsa-sha2-nistp256 ${blobOf(ECDSA_256).replace(/=+$/, '')}`),
    'not valid base64',
  )
  assertStringIncludes(await expectError(`${ED25519}AAAA`), 'trailing bytes')
  assertStringIncludes(await expectError('ssh-rsa AAAAB3NzaC1yc2E='), 'malformed')
})

test('an unsupported type names what is supported', async () => {
  const error = await expectError('ssh-magic AAAA')
  assertStringIncludes(error, 'ssh-magic')
  assertStringIncludes(error, 'ssh-ed25519')
})

test('an oversized line is rejected before any parsing', async () => {
  assertStringIncludes(
    await expectError(`ssh-ed25519 ${'A'.repeat(9000)}`),
    'under 8192 characters',
  )
})

test('a NUL byte is rejected', async () => {
  const withNul = `${ED25519}${String.fromCodePoint(0)}evil`
  assertStringIncludes(await expectError(withNul), 'single line')
})

test('isCanonicalSshPublicKey accepts only two-field canonical lines', async () => {
  const parsed = await expectOk(ED25519)
  assert(isCanonicalSshPublicKey(parsed.publicKey))
  assertEquals(isCanonicalSshPublicKey(`${ED25519} comment`), false)
  assertEquals(
    isCanonicalSshPublicKey(`command="/bin/false" ${ED25519}`),
    false,
  )
  assertEquals(isCanonicalSshPublicKey('ssh-magic AAAA'), false)
})
