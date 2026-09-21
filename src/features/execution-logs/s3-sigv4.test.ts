import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { signS3Request, sigV4Encode, sigV4Timestamps } from './s3-sigv4.ts'

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}

const AT = new Date('2026-08-21T13:45:00.000Z')

describe('sigV4Timestamps', () => {
  it('formats the basic and date-only stamps', () => {
    assertEquals(sigV4Timestamps(AT), { amzDate: '20260821T134500Z', dateStamp: '20260821' })
  })
})

describe('sigV4Encode', () => {
  it('escapes the characters encodeURIComponent leaves alone', () => {
    assertEquals(sigV4Encode("a!'()*b"), 'a%21%27%28%29%2Ab')
    assertEquals(sigV4Encode('a b'), 'a%20b')
    assertEquals(sigV4Encode('a/b'), 'a%2Fb')
  })
})

describe('signS3Request', () => {
  it('produces a deterministic Authorization header for a fixed request', async () => {
    const url = new URL('https://s3.example.test/bucket/execution-logs/index/cmd-1.json')
    const first = await signS3Request(CREDENTIALS, { method: 'GET', url }, AT)
    const second = await signS3Request(CREDENTIALS, { method: 'GET', url }, AT)
    assertEquals(first.Authorization, second.Authorization)
    assert(
      first.Authorization.startsWith(
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260821/us-east-1/s3/aws4_request, '
      )
    )
    assert(first.Authorization.includes('SignedHeaders=host;x-amz-content-sha256;x-amz-date,'))
  })

  it('hashes the payload rather than sending UNSIGNED-PAYLOAD', async () => {
    const url = new URL('https://s3.example.test/bucket/key')
    const empty = await signS3Request(CREDENTIALS, { method: 'PUT', url }, AT)
    const withBody = await signS3Request(
      CREDENTIALS,
      { method: 'PUT', url, body: new TextEncoder().encode('payload') },
      AT
    )
    // SHA-256 of the empty string — the documented value for an empty payload.
    assertEquals(
      empty['x-amz-content-sha256'],
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    assert(withBody['x-amz-content-sha256'] !== empty['x-amz-content-sha256'])
    assert(withBody.Authorization !== empty.Authorization)
  })

  it('signs extra headers and lists them in SignedHeaders', async () => {
    const url = new URL('https://s3.example.test/bucket/key')
    const signed = await signS3Request(
      CREDENTIALS,
      { method: 'PUT', url, headers: { 'Content-Type': 'application/gzip' } },
      AT
    )
    assertEquals(signed['content-type'], 'application/gzip')
    assert(signed.Authorization.includes('SignedHeaders=content-type;host;'))
  })

  it('canonicalizes query parameters in sorted order', async () => {
    const first = new URL('https://s3.example.test/bucket?list-type=2&prefix=a')
    const second = new URL('https://s3.example.test/bucket?prefix=a&list-type=2')
    const a = await signS3Request(CREDENTIALS, { method: 'GET', url: first }, AT)
    const b = await signS3Request(CREDENTIALS, { method: 'GET', url: second }, AT)
    assertEquals(a.Authorization, b.Authorization)
  })
})
