import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { EnvironmentDeploySite } from '../../contracts/commands/schemas.ts'
import {
  previousPhpModesFromRecord,
  recordSitePhpModes,
  resolveSitePhpMode,
  withSitePhpModes,
} from './deploy-php-modes.ts'

const test = Deno.test.bind(Deno)

function site(
  composeServiceName: string,
  engine: EnvironmentDeploySite['engine'],
  php?: EnvironmentDeploySite['php']
): EnvironmentDeploySite {
  return { composeServiceName, engine, root: 'public', listenPort: 18080, ...(php ? { php } : {}) }
}

/** A db whose one `deployment` lookup answers with `options`. */
function deploymentDb(options: unknown): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(options === undefined ? [] : [{ options }]),
  }
  return chain as unknown as Db
}

test('previousPhpModesFromRecord: no record, a pre-mode record, and a recorded mode', () => {
  assertEquals(previousPhpModesFromRecord(null)('blog'), undefined)
  // A record without phpModes says nothing: unknown, not php-fpm.
  assertEquals(previousPhpModesFromRecord({ secretPlan: [] })('blog'), undefined)
  const recorded = previousPhpModesFromRecord({ phpModes: { blog: 'fastcgi' } })
  assertEquals(recorded('blog'), 'fastcgi')
  assertEquals(recorded('shop'), undefined)
})

test('recordSitePhpModes keeps only sites that were given a mode', () => {
  assertEquals(
    recordSitePhpModes([
      site('blog', 'nginx', { mode: 'fastcgi', version: '8.4' }),
      site('static', 'caddy'),
    ]),
    { blog: 'fastcgi' }
  )
  assertEquals(recordSitePhpModes(undefined), {})
})

test('resolveSitePhpMode leaves non-PHP and unasked Caddy sites alone', () => {
  const staticSite = site('static', 'nginx')
  assertEquals(resolveSitePhpMode(staticSite, undefined, {}, undefined), { site: staticSite })
  const caddyPhp = site('legacy', 'caddy', { version: '8.4' })
  assertEquals(resolveSitePhpMode(caddyPhp, undefined, {}, undefined), { site: caddyPhp })
  const refused = resolveSitePhpMode(caddyPhp, 'fastcgi', {}, undefined)
  assertEquals('error' in refused && refused.error.reason, 'engine_unsupported')
})

test('resolveSitePhpMode stamps the default, and warns when it keeps a narrowed mode', () => {
  assertEquals(
    resolveSitePhpMode(site('blog', 'nginx', { version: '8.4' }), undefined, {}, undefined),
    { site: site('blog', 'nginx', { version: '8.4', mode: 'fastcgi' }) }
  )
  // `php: { mode }` alone still makes it a PHP site.
  assertEquals(resolveSitePhpMode(site('blog', 'nginx'), 'fpm', {}, undefined), {
    site: site('blog', 'nginx', { mode: 'fpm' }),
  })
  const kept = resolveSitePhpMode(
    site('blog', 'nginx', { version: '8.4' }),
    undefined,
    { server: ['fastcgi'] },
    'fpm'
  )
  assertEquals('site' in kept && kept.site.php?.mode, 'fpm')
  assertEquals('warning' in kept && kept.warning?.code, 'php_mode_not_allowed')
})

test('withSitePhpModes resolves this server only and refuses a disallowed switch', async () => {
  const warnings: unknown[] = []
  const ctx = {
    daemonRunsModes: true,
    environmentId: 'env',
    serverId: 'srv',
    localServiceNames: new Set(['blog']),
    specs: [],
    orgOptions: { phpModes: ['fastcgi'] },
    serverOptions: null,
    warnings,
  }
  const sites = [
    site('blog', 'nginx', { version: '8.4' }),
    site('shop', 'nginx', { version: '8.4' }),
  ]
  const resolved = await withSitePhpModes(deploymentDb(undefined), ctx, sites)
  assertEquals(resolved, [site('blog', 'nginx', { version: '8.4', mode: 'fastcgi' }), sites[1]])

  const refused = await withSitePhpModes(
    deploymentDb({ phpModes: { blog: 'fastcgi' } }),
    {
      ...ctx,
      specs: [
        {
          composeServiceName: 'blog',
          engine: 'nginx',
          root: 'public',
          listenPort: 1,
          php: { mode: 'fpm' },
        },
      ],
    },
    sites
  )
  assertEquals('kind' in refused && refused.kind, 'php_mode_unavailable')

  const upstream = { kind: 'site_cron_unowned', composeServiceName: 'blog' }
  assertEquals(await withSitePhpModes(deploymentDb(undefined), ctx, upstream), upstream)
  assertEquals(warnings, [])
})

test('a daemon without php-site-modes-v1 is never stamped and refuses other modes', () => {
  const blog = site('blog', 'nginx', { version: '8.4' })
  // Nothing asked: left alone, so the old daemon's shared pool is untouched.
  assertEquals(resolveSitePhpMode(blog, undefined, {}, undefined, false), { site: blog })
  assertEquals(resolveSitePhpMode(blog, 'fpm', {}, undefined, false), { site: blog })
  const refused = resolveSitePhpMode(blog, 'fastcgi', {}, undefined, false)
  assertEquals('error' in refused && refused.error.reason, 'daemon_unsupported')
  assertEquals('error' in refused && refused.error.allowed, ['fpm'])
  // With the feature the default is stamped.
  const stamped = resolveSitePhpMode(blog, undefined, {}, undefined, true)
  assertEquals('site' in stamped && stamped.site.php?.mode, 'fastcgi')
})
