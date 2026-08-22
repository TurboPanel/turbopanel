import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { executionLogStoreConformanceCases } from './execution-log-store.conformance.ts'
import { S3ExecutionLogStore, parseS3ListKeys, type S3ExecutionLogConfig } from './s3-store.ts'

const CONFIG: S3ExecutionLogConfig = {
  endpoint: 'https://s3.example.test',
  bucket: 'transcripts',
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
}

/**
 * In-memory S3 endpoint: enough of GET / PUT / DELETE / ListObjectsV2 for the
 * conformance suite, so the driver's HTTP shape is exercised without a bucket.
 */
function installFakeS3(): { restore(): void; requests: Request[] } {
  const objects = new Map<string, Uint8Array>()
  const requests: Request[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init)
    requests.push(request)
    const url = new URL(request.url)
    const prefixPath = `/${CONFIG.bucket}`

    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
      const body = keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')
      return Promise.resolve(
        new Response(`<ListBucketResult>${body}</ListBucketResult>`, { status: 200 })
      )
    }

    const key = decodeURIComponent(url.pathname.slice(prefixPath.length + 1))
    if (request.method === 'GET') {
      const value = objects.get(key)
      if (!value) return Promise.resolve(new Response('missing', { status: 404 }))
      return Promise.resolve(new Response(value.slice() as unknown as BodyInit, { status: 200 }))
    }
    if (request.method === 'PUT') {
      return request.arrayBuffer().then((buffer) => {
        objects.set(key, new Uint8Array(buffer))
        return new Response(null, { status: 200 })
      })
    }
    if (request.method === 'DELETE') {
      objects.delete(key)
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return Promise.resolve(new Response('unsupported', { status: 400 }))
  }

  return {
    restore() {
      globalThis.fetch = originalFetch
    },
    requests,
  }
}

describe('S3ExecutionLogStore', () => {
  for (const testCase of executionLogStoreConformanceCases) {
    it(testCase.name, async () => {
      const fake = installFakeS3()
      try {
        await testCase.run(new S3ExecutionLogStore(CONFIG))
      } finally {
        fake.restore()
      }
    })
  }

  it('signs every request with SigV4 against the configured region', async () => {
    const fake = installFakeS3()
    try {
      const store = new S3ExecutionLogStore(CONFIG)
      await store.appendChunk('cmd-1', { seq: 0, bytes: new TextEncoder().encode('a') })

      assert(fake.requests.length > 0)
      for (const request of fake.requests) {
        const authorization = request.headers.get('authorization') ?? ''
        assert(authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/'))
        assert(authorization.includes('/us-east-1/s3/aws4_request'))
        assert(request.headers.get('x-amz-content-sha256'))
        assert(request.headers.get('x-amz-date'))
      }
    } finally {
      fake.restore()
    }
  })

  it('addresses objects path-style by default', async () => {
    const fake = installFakeS3()
    try {
      await new S3ExecutionLogStore(CONFIG).appendChunk('cmd-2', {
        seq: 0,
        bytes: new TextEncoder().encode('a'),
      })
      const put = fake.requests.find((request) => request.method === 'PUT')
      assert(put)
      assert(new URL(put.url).pathname.startsWith('/transcripts/execution-logs/'))
    } finally {
      fake.restore()
    }
  })
})

describe('parseS3ListKeys', () => {
  it('extracts keys and the continuation token', () => {
    const parsed = parseS3ListKeys(
      '<ListBucketResult><Contents><Key>a/b</Key></Contents>' +
        '<Contents><Key>a&amp;c</Key></Contents>' +
        '<NextContinuationToken>tok</NextContinuationToken></ListBucketResult>'
    )
    assertEquals(parsed.keys, ['a/b', 'a&c'])
    assertEquals(parsed.nextContinuationToken, 'tok')
  })

  it('reports no continuation token when the listing is complete', () => {
    const parsed = parseS3ListKeys('<ListBucketResult></ListBucketResult>')
    assertEquals(parsed.keys, [])
    assertEquals(parsed.nextContinuationToken, null)
  })
})
