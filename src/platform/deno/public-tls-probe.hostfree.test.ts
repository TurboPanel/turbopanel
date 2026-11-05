import { assertEquals } from '@std/assert'
import { issueLeafCertificate, mintOrganizationCa } from '../../lib/tls/self-signed.ts'
import { createPublicTlsProbe } from './public-tls-probe.ts'

const test = Deno.test.bind(Deno)

function closable() {
  const state = {
    closed: 0,
    close() {
      state.closed += 1
    },
    handshake: () => Promise.resolve(),
  }
  return state
}

test('a finished handshake is public, dials loopback 8443 with the name as SNI, and closes both connections', async () => {
  const tcp = closable()
  const tls = closable()
  const dialed: unknown[] = []
  const probe = createPublicTlsProbe({
    connect: (options) => {
      dialed.push(options)
      return Promise.resolve(tcp)
    },
    startTls: (_conn, options) => {
      dialed.push(options)
      return Promise.resolve(tls)
    },
  })
  assertEquals(await probe('panel.example.com'), 'public')
  assertEquals(dialed, [
    { hostname: '127.0.0.1', port: 8443, transport: 'tcp' },
    { hostname: 'panel.example.com' },
  ])
  assertEquals([tcp.closed, tls.closed], [1, 1])
})

test('a refused certificate is private; any other handshake failure is unavailable', async () => {
  const failing = (message: string) =>
    createPublicTlsProbe({
      connect: () => Promise.resolve(closable()),
      startTls: () =>
        Promise.resolve({
          ...closable(),
          handshake: () => Promise.reject(new Deno.errors.InvalidData(message)),
        }),
    })
  assertEquals(await failing('invalid peer certificate: UnknownIssuer')('a.example.com'), 'private')
  assertEquals(await failing('connection reset')('a.example.com'), 'unavailable')
})

test('no listener is unavailable', async () => {
  const probe = createPublicTlsProbe({
    connect: () => Promise.reject(new Deno.errors.ConnectionRefused('Connection refused')),
  })
  assertEquals(await probe('a.example.com'), 'unavailable')
})

test('a stalled connect is unavailable after the timeout, and a late connection is closed', async () => {
  const late = closable()
  let release: (() => void) | undefined
  const probe = createPublicTlsProbe({
    timeoutMs: 10,
    connect: () =>
      new Promise((resolve) => {
        release = () => resolve(late)
      }),
  })
  assertEquals(await probe('a.example.com'), 'unavailable')
  release?.()
  // Let the late connect settle and be closed.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assertEquals(late.closed, 1)
})

test('a real handshake with a certificate no public root signed reads as private', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'public-tls-probe' })
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, [
    'private.example.com',
  ])
  const ac = new AbortController()
  const server = Deno.serve(
    {
      port: 0,
      hostname: '127.0.0.1',
      cert: leaf.certificatePem,
      key: leaf.privateKeyPem,
      signal: ac.signal,
      onListen() {},
    },
    () => new Response('ok')
  )
  try {
    const probe = createPublicTlsProbe({ listenerPort: server.addr.port })
    assertEquals(await probe('private.example.com'), 'private')
  } finally {
    ac.abort()
    await server.finished
  }
})
