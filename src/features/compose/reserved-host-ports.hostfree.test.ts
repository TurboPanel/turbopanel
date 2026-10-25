import { assertEquals } from '@std/assert'
import {
  describeReservedHostPorts,
  publishedHostRange,
  reservedHostPortFindings,
} from './reserved-host-ports.ts'

const test = Deno.test.bind(Deno)

test('publishedHostRange reads the host side of short and long port entries', () => {
  assertEquals(publishedHostRange('127.0.0.1:18480:80'), [18480, 18480])
  assertEquals(publishedHostRange('8080:80/tcp'), [8080, 8080])
  assertEquals(publishedHostRange('[::1]:8080:80'), [8080, 8080])
  assertEquals(publishedHostRange('9000-9010:9000-9010'), [9000, 9010])
  assertEquals(publishedHostRange({ target: 80, published: 8081 }), [8081, 8081])
  assertEquals(publishedHostRange({ target: 80, published: '8082' }), [8082, 8082])
})

test('publishedHostRange ignores entries that publish no fixed host port', () => {
  assertEquals(publishedHostRange('80'), undefined)
  assertEquals(publishedHostRange(80), undefined)
  assertEquals(publishedHostRange('${PORT}:80'), undefined)
  assertEquals(publishedHostRange({ target: 80 }), undefined)
  assertEquals(publishedHostRange(null), undefined)
})

test('a published reserved host port is reported with its service', () => {
  const found = reservedHostPortFindings({
    web: { image: 'nginx', ports: ['127.0.0.1:18480:80'] },
    db: { image: 'postgres', ports: ['5433:5432'] },
    edge: { image: 'x', ports: [{ target: 80, published: 443 }] },
    range: { image: 'x', ports: ['18000-18100:18000-18100'] },
    plain: { image: 'x' },
  })
  assertEquals(found, [
    { service: 'web', port: 18480 },
    { service: 'edge', port: 443 },
    { service: 'range', port: 18000 },
  ])
})

test('the reserved list reads as short ranges', () => {
  assertEquals(describeReservedHostPorts().startsWith('80, 443, 2019'), true)
  assertEquals(describeReservedHostPorts().includes('18080-18999'), true)
})
