import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { resolveTcpUdpIngressServices } from './tcp-udp-ingress.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ENV_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function createSelectDb(rows: unknown[]): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db
}

test('resolveTcpUdpIngressServices dedupes and sorts tcp/udp services with ports', async () => {
  const db = createSelectDb([
    {
      serviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      composeServiceName: 'postgres',
      hostingOptions: { protocol: 'tcp', ports: [{ published: 5432, target: 5432 }] },
    },
    {
      serviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      composeServiceName: 'postgres',
      hostingOptions: { protocol: 'tcp', ports: [{ published: 5432, target: 5432 }] },
    },
    {
      serviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      composeServiceName: 'game',
      hostingOptions: { protocol: 'udp', ports: [{ published: 7777, target: 7777 }] },
    },
    {
      serviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      composeServiceName: 'web',
      hostingOptions: { protocol: 'http', ports: [{ published: 80, target: 8080 }] },
    },
    {
      serviceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      composeServiceName: 'empty-tcp',
      hostingOptions: { protocol: 'tcp', ports: [] },
    },
  ])

  const result = await resolveTcpUdpIngressServices(db, ENV_ID)
  assertEquals(result, [
    {
      serviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      composeServiceName: 'game',
    },
    {
      serviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      composeServiceName: 'postgres',
    },
  ])
})

test('resolveTcpUdpIngressServices returns an empty list when nothing qualifies', async () => {
  const db = createSelectDb([
    {
      serviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      composeServiceName: 'web',
      hostingOptions: { protocol: 'http' },
    },
  ])

  assertEquals(await resolveTcpUdpIngressServices(db, ENV_ID), [])
})
