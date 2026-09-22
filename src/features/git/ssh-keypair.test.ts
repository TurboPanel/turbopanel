import { assertEquals, assertStringIncludes } from '@std/assert'
import { generateSshDeployKeypair } from './ssh-keypair.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function base64Decode(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0
  return bytes
}

/** Read one SSH wire `string` at `offset`; returns the bytes and the next offset. */
function readSshString(
  bytes: Uint8Array,
  offset: number,
): { value: Uint8Array; next: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const length = view.getUint32(offset, false)
  return {
    value: bytes.slice(offset + 4, offset + 4 + length),
    next: offset + 4 + length,
  }
}

test('the private half is an unencrypted OPENSSH container', async () => {
  const pair = await generateSshDeployKeypair('deploy key')
  assertStringIncludes(pair.privateKeyOpenssh, '-----BEGIN OPENSSH PRIVATE KEY-----')
  assertStringIncludes(pair.privateKeyOpenssh, '-----END OPENSSH PRIVATE KEY-----')

  const body = pair.privateKeyOpenssh
    .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
    .replace('-----END OPENSSH PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  const blob = base64Decode(body)

  const magic = new TextDecoder().decode(blob.slice(0, 15))
  assertEquals(magic, 'openssh-key-v1\0')

  // `none` cipher and `none` KDF: a passphrase would have to travel to the host
  // to be useful, which is strictly worse than the sealed envelope it lives in.
  let offset = 15
  const cipher = readSshString(blob, offset)
  assertEquals(new TextDecoder().decode(cipher.value), 'none')
  offset = cipher.next
  const kdf = readSshString(blob, offset)
  assertEquals(new TextDecoder().decode(kdf.value), 'none')
})

test('the public half is the one-line authorized-keys form', async () => {
  const pair = await generateSshDeployKeypair('deploy key')
  const [type, encoded, comment] = pair.publicKeyOpenssh.split(' ')
  assertEquals(type, 'ssh-ed25519')
  assertEquals(comment, 'deploy-key')

  // The blob restates its own type and carries a 32-byte Ed25519 public key.
  const blob = base64Decode(encoded!)
  const declaredType = readSshString(blob, 0)
  assertEquals(new TextDecoder().decode(declaredType.value), 'ssh-ed25519')
  const publicKey = readSshString(blob, declaredType.next)
  assertEquals(publicKey.value.length, 32)
})

test('the embedded public key matches the public half handed back', async () => {
  const pair = await generateSshDeployKeypair('deploy key')
  const privateBlob = base64Decode(
    pair.privateKeyOpenssh
      .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
      .replace('-----END OPENSSH PRIVATE KEY-----', '')
      .replace(/\s+/g, ''),
  )
  // magic + ciphername + kdfname + kdfoptions + key count, then the public blob.
  let offset = 15
  offset = readSshString(privateBlob, offset).next
  offset = readSshString(privateBlob, offset).next
  offset = readSshString(privateBlob, offset).next
  offset += 4
  const embedded = readSshString(privateBlob, offset)

  const encoded = pair.publicKeyOpenssh.split(' ')[1]!
  assertEquals(
    [...embedded.value].join(','),
    [...base64Decode(encoded)].join(','),
  )
})

test('the fingerprint is the SHA256 form ssh-keygen prints', async () => {
  const pair = await generateSshDeployKeypair('deploy key')
  assertEquals(pair.fingerprint.startsWith('SHA256:'), true)
  // Unpadded base64 of a 32-byte digest.
  assertEquals(pair.fingerprint.slice('SHA256:'.length).length, 43)
})

test('a blank comment falls back rather than emitting a bare key line', async () => {
  // The comment is a field in the wire format and in the authorized-keys line;
  // an empty one would produce a trailing space and an unlabelled deploy key.
  const pair = await generateSshDeployKeypair('   ')
  assertEquals(pair.publicKeyOpenssh.split(' ')[2], 'turbopanel')
})

test('every keypair is distinct', async () => {
  const first = await generateSshDeployKeypair('deploy key')
  const second = await generateSshDeployKeypair('deploy key')
  assertEquals(first.fingerprint === second.fingerprint, false)
})
