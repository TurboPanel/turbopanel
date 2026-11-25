/** `network-shares.ts`: which top-level volumes are SMB shares. */

import { assertEquals } from '@std/assert'
import {
  findNetworkShareVolumes,
  hasNetworkShareType,
  isNetworkShareDriverOpts,
  networkSharesCanonical,
  networkSharesFingerprint,
} from './network-shares.ts'

const test = Deno.test.bind(Deno)

test('cifs and smb3 volumes are shares, case and spacing aside', () => {
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs', device: '//h/s' }), true)
  assertEquals(isNetworkShareDriverOpts({ type: ' SMB3 ', device: '//h/s', o: 'ro' }), true)
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs', device: '//{$NAS}/s' }), true)
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs', device: '{$NAS_SHARE}' }), true)
})

test('other types, binds and host-path devices are not shares', () => {
  assertEquals(isNetworkShareDriverOpts({ type: 'nfs', device: ':/x' }), false)
  assertEquals(isNetworkShareDriverOpts({ type: 'tmpfs' }), false)
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs', device: '//h/s', o: 'ro,bind' }), false)
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs', device: '/etc' }), false)
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs', device: 5 }), false)
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs' }), false)
  assertEquals(isNetworkShareDriverOpts({ type: 'cifs', device: 'h:/s' }), false)
  assertEquals(isNetworkShareDriverOpts('cifs'), false)
  assertEquals(isNetworkShareDriverOpts(undefined), false)
})

test('hasNetworkShareType looks at the type alone', () => {
  assertEquals(hasNetworkShareType({ type: 'cifs', o: 'bind' }), true)
  assertEquals(hasNetworkShareType({ type: 'none' }), false)
  assertEquals(hasNetworkShareType({}), false)
})

test('findNetworkShareVolumes names every share volume, including odd ones', () => {
  const doc = {
    volumes: {
      media: { driver_opts: { type: 'cifs', device: '//h/s' } },
      sneaky: { driver_opts: { type: 'cifs', device: '/etc', o: 'bind' } },
      plain: {},
      data: { driver_opts: { type: 'tmpfs' } },
      empty: null,
    },
  }
  assertEquals(findNetworkShareVolumes(doc), ['media', 'sneaky'])
  assertEquals(findNetworkShareVolumes({ services: {} }), [])
  assertEquals(findNetworkShareVolumes(null), [])
})

test('the fingerprint is null without shares and stable across key order', async () => {
  assertEquals(await networkSharesFingerprint({ volumes: { a: {} } }), null)
  assertEquals(networkSharesCanonical({}), '')
  const a = { volumes: { m: { driver_opts: { type: 'cifs', device: '//h/s', o: 'ro' } } } }
  const b = { volumes: { m: { driver_opts: { o: 'ro', device: '//h/s', type: 'cifs' } } } }
  assertEquals(await networkSharesFingerprint(a), await networkSharesFingerprint(b))
  assertEquals(typeof (await networkSharesFingerprint(a)), 'string')
})

test('the fingerprint changes when a share is re-pointed and ignores non-shares', async () => {
  const base = { volumes: { m: { driver_opts: { type: 'cifs', device: '//h/s' } } } }
  const moved = { volumes: { m: { driver_opts: { type: 'cifs', device: '//h/other' } } } }
  const withPlain = {
    volumes: { m: { driver_opts: { type: 'cifs', device: '//h/s' } }, d: { driver: 'local' } },
  }
  assertEquals(
    (await networkSharesFingerprint(base)) === (await networkSharesFingerprint(moved)),
    false
  )
  assertEquals(await networkSharesFingerprint(base), await networkSharesFingerprint(withPlain))
})
