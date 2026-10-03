import { assertEquals } from '@std/assert'
import { parseComposePortEntry, publishedPortsOfCompose } from './compose-ports.ts'

const test = Deno.test.bind(Deno)

test('short syntax: published port, protocol, ranges and bind address', () => {
  assertEquals(parseComposePortEntry('8080:80').port, { proto: 'tcp', ports: '8080' })
  assertEquals(parseComposePortEntry('5353:53/udp').port, { proto: 'udp', ports: '5353' })
  assertEquals(parseComposePortEntry('8000-8010:8000-8010').port, {
    proto: 'tcp',
    ports: '8000-8010',
  })
  assertEquals(parseComposePortEntry('203.0.113.5:8080:80').port, {
    proto: 'tcp',
    ports: '8080',
    hostIp: '203.0.113.5',
  })
})

test('a loopback binding opens nothing', () => {
  for (const entry of ['127.0.0.1:8080:80', '[::1]:8080:80', 'localhost:8080:80']) {
    assertEquals(parseComposePortEntry(entry).port, undefined, entry)
  }
})

test('entries with no fixed host port produce a note and no rule', () => {
  for (const entry of ['80', 80, '${PORT}:80', ':80']) {
    const parsed = parseComposePortEntry(entry)
    assertEquals(parsed.port, undefined, String(entry))
    assertEquals(typeof parsed.note, 'string', String(entry))
  }
})

test('long syntax reads published, protocol and host_ip', () => {
  assertEquals(parseComposePortEntry({ target: 80, published: 8080, protocol: 'udp' }).port, {
    proto: 'udp',
    ports: '8080',
  })
  assertEquals(
    parseComposePortEntry({ target: 80, published: '9000', host_ip: '127.0.0.1' }).port,
    undefined
  )
  assertEquals(parseComposePortEntry({ target: 80 }).port, undefined)
})

test('a whole compose document is walked service by service', () => {
  const result = publishedPortsOfCompose({
    services: {
      web: { ports: ['8080:80', '127.0.0.1:9090:90'] },
      dns: { ports: ['5353:53/udp'] },
      worker: {},
    },
  })
  assertEquals(result.ports, [
    { proto: 'tcp', ports: '8080', service: 'web' },
    { proto: 'udp', ports: '5353', service: 'dns' },
  ])
  assertEquals(publishedPortsOfCompose(null), { ports: [], notes: [] })
})
