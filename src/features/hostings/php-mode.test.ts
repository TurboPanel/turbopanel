import { assertEquals } from '@std/assert'
import {
  allowedPhpModes,
  decideSitePhpMode,
  defaultPhpMode,
  listPhpModeAffectedSites,
  parsePhpModes,
  parsePhpModesInput,
} from './php-mode.ts'

const test = Deno.test.bind(Deno)

test('parsePhpModes dedupes into canonical order and drops unknown entries', () => {
  assertEquals(parsePhpModes(['fpm', 'fastcgi', 'fpm', 'cgi']), ['fastcgi', 'fpm'])
  assertEquals(parsePhpModes([]), [])
  assertEquals(parsePhpModes(undefined), undefined)
  assertEquals(parsePhpModes('fpm'), undefined)
})

test('parsePhpModesInput refuses unknown modes and takes null as offer-everything', () => {
  assertEquals(parsePhpModesInput(null), { ok: true, value: null })
  assertEquals(parsePhpModesInput(['lsphp-detached', 'fpm']), {
    ok: true,
    value: ['fpm', 'lsphp-detached'],
  })
  assertEquals(parsePhpModesInput(['fpm', 'cgi']), { ok: false })
  assertEquals(parsePhpModesInput('fpm'), { ok: false })
  assertEquals(parsePhpModesInput(undefined), { ok: false })
})

test('allowedPhpModes intersects organization, server and engine', () => {
  assertEquals(allowedPhpModes({}, 'nginx'), ['fastcgi', 'fpm'])
  assertEquals(allowedPhpModes({}, 'apache'), ['fastcgi', 'fpm'])
  assertEquals(allowedPhpModes({}, 'openlitespeed'), [
    'fastcgi',
    'fpm',
    'lsphp-detached',
    'lsphp-attached',
  ])
  assertEquals(allowedPhpModes({}, 'caddy'), [])
  assertEquals(
    allowedPhpModes(
      { organization: ['fpm', 'lsphp-detached'], server: ['lsphp-detached'] },
      'openlitespeed'
    ),
    ['lsphp-detached']
  )
})

test('defaultPhpMode is FastCGI, then php-fpm, then detached lsphp, never attached', () => {
  assertEquals(defaultPhpMode(['fastcgi', 'fpm']), 'fastcgi')
  assertEquals(defaultPhpMode(['fpm', 'lsphp-detached']), 'fpm')
  assertEquals(defaultPhpMode(['lsphp-detached', 'lsphp-attached']), 'lsphp-detached')
  assertEquals(defaultPhpMode(['lsphp-attached']), undefined)
})

test('decideSitePhpMode: a new site gets the default the policy allows', () => {
  assertEquals(decideSitePhpMode({ engine: 'nginx', policy: {} }), {
    ok: true,
    mode: 'fastcgi',
    kept: false,
  })
  assertEquals(decideSitePhpMode({ engine: 'nginx', policy: { server: ['fpm'] } }), {
    ok: true,
    mode: 'fpm',
    kept: false,
  })
  assertEquals(decideSitePhpMode({ engine: 'nginx', policy: { organization: [] } }), {
    ok: false,
    reason: 'none_allowed',
    allowed: [],
  })
})

test('decideSitePhpMode: narrowing keeps a running site on its mode', () => {
  const policy = { organization: ['fastcgi' as const] }
  assertEquals(decideSitePhpMode({ engine: 'nginx', policy, previous: 'fpm' }), {
    ok: true,
    mode: 'fpm',
    kept: true,
  })
  assertEquals(decideSitePhpMode({ engine: 'nginx', policy, authored: 'fpm', previous: 'fpm' }), {
    ok: true,
    mode: 'fpm',
    kept: true,
  })
  // Switching to a mode the policy does not offer is refused.
  assertEquals(
    decideSitePhpMode({ engine: 'nginx', policy, authored: 'fpm', previous: 'fastcgi' }),
    { ok: false, reason: 'not_allowed', mode: 'fpm', allowed: ['fastcgi'] }
  )
})

test('decideSitePhpMode: the engine has the last word', () => {
  assertEquals(decideSitePhpMode({ engine: 'apache', policy: {}, authored: 'lsphp-detached' }), {
    ok: false,
    reason: 'engine_unsupported',
    mode: 'lsphp-detached',
    allowed: ['fastcgi', 'fpm'],
  })
  // A previous mode the new engine cannot run is forgotten, not kept.
  assertEquals(decideSitePhpMode({ engine: 'nginx', policy: {}, previous: 'lsphp-attached' }), {
    ok: true,
    mode: 'fastcgi',
    kept: false,
  })
})

test('listPhpModeAffectedSites names only recorded sites the policy no longer offers', () => {
  const affected = listPhpModeAffectedSites([
    {
      environmentId: 'env-1',
      serverId: 'srv-1',
      deploymentOptions: { phpModes: { blog: 'fpm', shop: 'fastcgi', junk: 'cgi' } },
      policy: { organization: ['fastcgi'] },
    },
    { environmentId: 'env-2', serverId: 'srv-1', deploymentOptions: null, policy: {} },
  ])
  assertEquals(affected, [
    { environmentId: 'env-1', serverId: 'srv-1', composeServiceName: 'blog', mode: 'fpm' },
  ])
})
