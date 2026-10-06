/**
 * Host-free coverage for the effective exposure of a server's shared ProxySQL.
 *
 * The pure union is what `decideIngressBindScopes` publishes from, and what the
 * connection surface reports as reachable — the two must never disagree, so
 * both directions are pinned here.
 */

import { assertEquals } from '@std/assert'
import { resolveManagedBindAddress } from './access-address.ts'
import { managedExposureChanged } from './exposure-change.ts'
import type { Db } from '../../db/connection.ts'
import { decideIngressBindScopes } from './ingress-desired-pure.ts'
import {
  hostExposureScopes,
  requestedExposureScope,
  resolveManagedEffectiveExposure,
} from './host-exposure.ts'
import { DEFAULT_MANAGED_SETTINGS, type ManagedSettings } from './settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Exposure = ManagedSettings['exposure']

const off: Exposure = { enabled: false }
const onPublic: Exposure = { enabled: true, scope: 'public' }
const onDatacenter: Exposure = { enabled: true, scope: 'datacenter' }
const onFabric: Exposure = { enabled: true, scope: 'turbofabric' }
/** Legacy rows enabled exposure without naming a scope — that means the default, `local`. */
const onDefaulted: Exposure = { enabled: true }

test('requestedExposureScope maps the toggle to a scope or nothing', () => {
  assertEquals(requestedExposureScope(off), undefined)
  assertEquals(requestedExposureScope(onDefaulted), 'local')
  assertEquals(requestedExposureScope(onDatacenter), 'datacenter')
})

test('a host with zero enabled clusters publishes nothing', () => {
  assertEquals(hostExposureScopes([]), [])
  assertEquals(hostExposureScopes([off]), [])
  assertEquals(hostExposureScopes([off, off, off]), [])
  // …and the bind decision agrees: no addresses at all, not all-interfaces.
  assertEquals(decideIngressBindScopes([off, off, off].map(requestedExposureScope)), {
    kind: 'omit',
  })
})

test('a mixed host publishes the union of the enabled clusters', () => {
  assertEquals(hostExposureScopes([off, onDatacenter, off]), ['datacenter'])
  assertEquals(hostExposureScopes([off, onDatacenter, onFabric]), ['turbofabric', 'datacenter'])
  // `public` already covers every narrower address; publishing both would be a
  // duplicate compose binding.
  assertEquals(hostExposureScopes([onDatacenter, onPublic, off]), ['public'])

  // The bind decision is driven by the same union, so a mixed host publishes
  // for its enabled clusters and drags the disabled ones along.
  assertEquals(decideIngressBindScopes([off, onDatacenter, off].map(requestedExposureScope)), {
    kind: 'resolve',
    scopes: ['datacenter'],
  })
  assertEquals(decideIngressBindScopes([off, onPublic].map(requestedExposureScope)), {
    kind: 'public_all_interfaces',
    addresses: ['0.0.0.0'],
  })
})

/** Minimal stub: the two SELECTs `loadHostExposureScopes` makes, in order. */
function stubDb(
  rows: readonly { engine: string; exposure: Exposure }[],
  organizationId: string | null = 'org-1'
): Db {
  let call = 0
  return {
    select() {
      const step = call++
      const query = {
        innerJoin() {
          return query
        },
        leftJoin() {
          return query
        },
        limit() {
          return Promise.resolve(step === 1 ? [{ organizationId }] : [])
        },
        where() {
          if (step === 0) {
            // replica rows on this server — one member per cluster
            return Promise.resolve(rows.map((_, index) => ({ managedId: `mg-${index}` })))
          }
          if (step === 1) return query
          // bound consumer lookup (step 2) then the managed rows (step 3)
          if (step === 2) return Promise.resolve([])
          return Promise.resolve(
            rows.map((row, index) => ({
              id: `mg-${index}`,
              engine: row.engine,
              options: {
                settings: { exposure: row.exposure },
                databases: [],
                backups: [],
              },
            }))
          )
        },
      }
      return {
        from() {
          return query
        },
      }
    },
  } as unknown as Db
}

test('an unexposed cluster alone on a host reports no publish', async () => {
  const effective = await resolveManagedEffectiveExposure(
    stubDb([{ engine: 'postgres', exposure: off }]),
    { serverId: 'srv-1', exposure: off }
  )
  assertEquals(effective, {
    requested: false,
    published: false,
    scopes: [],
    viaCoResidentCluster: false,
  })
})

test('an unexposed cluster next to an exposed one is reported as reachable', async () => {
  // The shared listener has no per-cluster ACL: the port really is open in
  // front of this cluster, so the connection surface must not claim otherwise.
  const effective = await resolveManagedEffectiveExposure(
    stubDb([
      { engine: 'postgres', exposure: off },
      { engine: 'mysql', exposure: onPublic },
    ]),
    { serverId: 'srv-1', exposure: off }
  )
  assertEquals(effective, {
    requested: false,
    published: true,
    scopes: ['public'],
    viaCoResidentCluster: true,
  })
})

test('an exposed cluster is published on its own request, not a neighbour’s', async () => {
  const effective = await resolveManagedEffectiveExposure(
    stubDb([
      { engine: 'postgres', exposure: onDatacenter },
      { engine: 'mysql', exposure: off },
    ]),
    { serverId: 'srv-1', exposure: onDatacenter }
  )
  assertEquals(effective, {
    requested: true,
    published: true,
    scopes: ['datacenter'],
    viaCoResidentCluster: false,
  })
})

test('a server with no clusters at all publishes nothing', async () => {
  const effective = await resolveManagedEffectiveExposure(stubDb([]), {
    serverId: 'srv-1',
    exposure: onPublic,
  })
  assertEquals(effective, {
    requested: true,
    published: false,
    scopes: [],
    viaCoResidentCluster: false,
  })
})

// Matrix cells M02 (engine ports not exposed) and P11 (reachability matches the
// chosen scope): the host address the shared listener publishes on, per setting.
const DATACENTER_ADDRESS = '10.20.0.5'
const FABRIC_ADDRESS = '10.99.0.5'
const bindLoaders = {
  loadDatacenterAddress: () => Promise.resolve(DATACENTER_ADDRESS),
  loadFabricAddress: () => Promise.resolve(FABRIC_ADDRESS),
}

async function publishedAddresses(settings: readonly Exposure[]): Promise<string[]> {
  const decision = decideIngressBindScopes(settings.map(requestedExposureScope))
  if (decision.kind === 'omit') return []
  if (decision.kind === 'public_all_interfaces') return [...decision.addresses]
  return await Promise.all(
    decision.scopes.map(async (scope) => {
      const address = await resolveManagedBindAddress(
        {} as Db,
        { serverId: 'srv-1', scope },
        bindLoaders
      )
      if (typeof address !== 'string') throw new TypeError('expected an address')
      return address
    })
  )
}

test('the listener address follows the exposure setting, and only public means every interface', async () => {
  // A cluster created with no exposure argument is loopback only.
  assertEquals(await publishedAddresses([DEFAULT_MANAGED_SETTINGS.exposure]), ['127.0.0.1'])
  assertEquals(await publishedAddresses([off]), [])
  assertEquals(await publishedAddresses([onDefaulted]), ['127.0.0.1'])
  assertEquals(await publishedAddresses([{ enabled: true, scope: 'local' }]), ['127.0.0.1'])
  assertEquals(await publishedAddresses([onDatacenter]), [DATACENTER_ADDRESS])
  assertEquals(await publishedAddresses([onFabric]), [FABRIC_ADDRESS])
  assertEquals(await publishedAddresses([onPublic]), ['0.0.0.0'])
  // Two clusters on one host publish for both; one public cluster covers all.
  assertEquals(await publishedAddresses([onDatacenter, onFabric]), [
    FABRIC_ADDRESS,
    DATACENTER_ADDRESS,
  ])
  assertEquals(await publishedAddresses([off, onFabric, onPublic]), ['0.0.0.0'])
})

test('changing the exposure setting counts as a change only when the listener would differ', () => {
  assertEquals(managedExposureChanged(off, off), false)
  assertEquals(managedExposureChanged(onDefaulted, { enabled: true, scope: 'local' }), false)
  // A remembered scope on a disabled cluster publishes nothing, so it is no change.
  assertEquals(managedExposureChanged(off, { enabled: false, scope: 'public' }), false)
  assertEquals(managedExposureChanged(onPublic, off), true)
  assertEquals(managedExposureChanged(off, onDefaulted), true)
  assertEquals(managedExposureChanged(onDefaulted, onDatacenter), true)
  assertEquals(managedExposureChanged(onDatacenter, onFabric), true)
})
