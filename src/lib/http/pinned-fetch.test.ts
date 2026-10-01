import { assertEquals, assertRejects } from '@std/assert'
import { type PinnedConn, pinnedFetch } from './pinned-fetch.ts'

const test = Deno.test.bind(Deno)

function conn(reply: Uint8Array | string, sent: string[] = []): PinnedConn {
  const bytes = typeof reply === 'string' ? new TextEncoder().encode(reply) : reply
  return {
    readable: new ReadableStream({
      start(controller) {
        // Split in awkward places to exercise the buffering.
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.slice(i, i + 7))
        }
        controller.close()
      },
    }),
    writable: new WritableStream({
      write: (chunk) => void sent.push(new TextDecoder().decode(chunk)),
    }),
    close() {},
  }
}

const fetchVia = (reply: Uint8Array | string, request: Request, sent: string[] = []) =>
  pinnedFetch(request, {
    addresses: ['203.0.113.9'],
    connect: () => Promise.resolve(conn(reply, sent)),
  })

test('sends the Host header, owns its framing headers, and carries the body', async () => {
  const sent: string[] = []
  const request = new Request('https://git.example.com:8443/a/b?x=1', {
    method: 'POST',
    body: 'hello',
    headers: {
      authorization: 'Bearer t',
      host: 'evil.test',
      'content-length': '1',
      connection: 'upgrade',
    },
  })
  await (await fetchVia('HTTP/1.1 204 No Content\r\n\r\n', request, sent)).text()
  const text = sent.join('')
  assertEquals(text.startsWith('POST /a/b?x=1 HTTP/1.1\r\nHost: git.example.com:8443\r\n'), true)
  assertEquals(text.includes('evil.test'), false)
  assertEquals(text.includes('authorization: Bearer t'), true)
  assertEquals(text.includes('Content-Length: 5'), true)
  assertEquals(text.endsWith('\r\n\r\nhello'), true)
})

test('reads a content-length body, a chunked body and an until-close body', async () => {
  const get = () => new Request('https://git.example.com/')
  const a = await fetchVia('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello', get())
  assertEquals(await a.text(), 'hello')
  const b = await fetchVia(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nTrailer: x\r\n\r\n',
    get()
  )
  assertEquals(await b.text(), 'hello world')
  const c = await fetchVia('HTTP/1.1 200 OK\r\n\r\nuntil close', get())
  assertEquals(await c.text(), 'until close')
})

test('exposes status and headers, and returns a redirect untouched', async () => {
  const r = await fetchVia(
    'HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n',
    new Request('https://git.example.com/')
  )
  assertEquals(r.status, 302)
  assertEquals(r.headers.get('location'), '/next')
})

test('decodes a gzip body', async () => {
  const gz = await new Response(
    new Blob(['zipped']).stream().pipeThrough(new CompressionStream('gzip'))
  ).bytes()
  const head = new TextEncoder().encode(
    `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\n\r\n`
  )
  const reply = new Uint8Array(head.length + gz.length)
  reply.set(head)
  reply.set(gz, head.length)
  assertEquals(
    await (await fetchVia(reply, new Request('https://git.example.com/'))).text(),
    'zipped'
  )
})

test('rejects truncated and malformed responses', async () => {
  const req = () => new Request('https://git.example.com/')
  const short = await fetchVia('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc', req())
  await assertRejects(() => short.text())
  await assertRejects(() => fetchVia('garbage\r\n\r\n', req()))
  await assertRejects(() => fetchVia('', req()))
  await assertRejects(() => fetchVia('HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n', req()))
})

test('tries the next validated address when one will not connect', async () => {
  const tried: string[] = []
  const response = await pinnedFetch(new Request('https://git.example.com/'), {
    addresses: ['203.0.113.1', '203.0.113.2'],
    connect: ({ address }) => {
      tried.push(address)
      return address === '203.0.113.1'
        ? Promise.reject(new Error('refused'))
        : Promise.resolve(conn('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
    },
  })
  assertEquals(response.status, 200)
  assertEquals(tried, ['203.0.113.1', '203.0.113.2'])
})

test('refuses plain http', async () => {
  await assertRejects(() => fetchVia('', new Request('http://git.example.com/')))
})
