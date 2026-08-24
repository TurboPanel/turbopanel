import { assertEquals } from '@std/assert'
import {
  branchFromGitRef,
  isGithubCommitSha,
  parseGithubSignatureHeader,
  verifyGithubWebhookSignature,
} from './github-webhook.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const encoder = new TextEncoder()

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    { name: 'HMAC' },
    key,
    encoder.encode(body) as BufferSource,
  )
  const hex = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

test('parseGithubSignatureHeader accepts only the sha256 hex form', () => {
  assertEquals(parseGithubSignatureHeader(`sha256=${'a'.repeat(64)}`)?.length, 32)
  assertEquals(parseGithubSignatureHeader(`sha256=${'A'.repeat(64)}`)?.length, 32)
  assertEquals(parseGithubSignatureHeader(`sha1=${'a'.repeat(40)}`), null)
  assertEquals(parseGithubSignatureHeader(`sha256=${'a'.repeat(63)}`), null)
  assertEquals(parseGithubSignatureHeader(`sha256=${'z'.repeat(64)}`), null)
  assertEquals(parseGithubSignatureHeader(undefined), null)
  assertEquals(parseGithubSignatureHeader(null), null)
})

test('verifyGithubWebhookSignature accepts a correct signature over raw bytes', async () => {
  const body = '{"zebra":1,"alpha":2}'
  const header = await sign('shh', body)
  assertEquals(
    await verifyGithubWebhookSignature('shh', encoder.encode(body), header),
    true,
  )
})

test('verifyGithubWebhookSignature rejects a re-serialized body', async () => {
  // The exact bytes are the contract: parsing and re-encoding reorders keys and
  // must not still verify.
  const body = '{"zebra":1,"alpha":2}'
  const header = await sign('shh', body)
  const reserialized = JSON.stringify({ alpha: 2, zebra: 1 })
  assertEquals(
    await verifyGithubWebhookSignature('shh', encoder.encode(reserialized), header),
    false,
  )
})

test('verifyGithubWebhookSignature rejects wrong secret, bad header, no secret', async () => {
  const body = '{"ok":true}'
  const header = await sign('shh', body)
  const raw = encoder.encode(body)

  assertEquals(await verifyGithubWebhookSignature('other', raw, header), false)
  assertEquals(await verifyGithubWebhookSignature('shh', raw, 'sha256=nope'), false)
  assertEquals(await verifyGithubWebhookSignature('shh', raw, undefined), false)
  // No configured secret must never pass — an unconfigured App rejects.
  assertEquals(await verifyGithubWebhookSignature(null, raw, header), false)
  assertEquals(await verifyGithubWebhookSignature('', raw, header), false)
})

test('branchFromGitRef reads branch refs only', () => {
  assertEquals(branchFromGitRef('refs/heads/main'), 'main')
  assertEquals(branchFromGitRef('refs/heads/feature/a-b'), 'feature/a-b')
  assertEquals(branchFromGitRef('refs/tags/v1'), null)
  assertEquals(branchFromGitRef('refs/heads/'), null)
  assertEquals(branchFromGitRef(undefined), null)
})

test('isGithubCommitSha rejects the branch-delete null sha', () => {
  assertEquals(isGithubCommitSha('a'.repeat(40)), true)
  assertEquals(isGithubCommitSha('0'.repeat(40)), false)
  assertEquals(isGithubCommitSha('abc'), false)
  assertEquals(isGithubCommitSha(42), false)
})
