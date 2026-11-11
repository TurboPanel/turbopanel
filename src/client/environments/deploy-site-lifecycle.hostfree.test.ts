import { assertEquals } from '@std/assert'
import { mapPrepareErrorResponse } from './deploy-routes-helpers.ts'
import {
  renderSiteLifecycleForDeploy,
  siteLifecycleUnowned,
  siteLifecycleUnsupported,
  sitesCarryLifecycle,
} from './deploy-site-lifecycle.ts'
import { parseServiceCreateFields, parseServicePatchFields } from '../services/routes-helpers.ts'
import { phpFieldsForApp } from '../servers/server-services.ts'
import { parseServiceOptions } from '../../features/projects/service-options.ts'
import { validateSiteLifecycleOptions } from '../../features/projects/site-lifecycle-options.ts'
import { DAEMON_WIRE_FEATURES, SITE_PHP_LIFECYCLE_FEATURE } from '../../lib/version-wire.ts'
import { isBuildEnvNameAllowed, buildEnvSaveProblem } from '../../features/compose/build-env.ts'

const test = Deno.test.bind(Deno)

const server = { serverId: 's-1', name: 'omicron' }

test('the feature is advertised and is the last entry', () => {
  assertEquals(SITE_PHP_LIFECYCLE_FEATURE, 'site-php-lifecycle-v1')
  assertEquals(DAEMON_WIRE_FEATURES[DAEMON_WIRE_FEATURES.length - 1], SITE_PHP_LIFECYCLE_FEATURE)
})

test('service options keep commands and workers, and drop what does not read', () => {
  const parsed = parseServiceOptions({
    postDeployCommands: ['php artisan migrate --force', '  ', 7],
    postDeployTimeoutSeconds: 120,
    postDeployTiming: 'after-switch',
    workers: [
      { name: 'queue', command: 'php artisan queue:work', processes: 2, memoryMb: 256 },
      { name: 'queue', command: 'duplicate' },
      { name: 'Bad Name', command: 'x' },
      { name: 'off', command: 'php artisan other', enabled: false, processes: 99 },
    ],
  })
  assertEquals(parsed?.postDeployCommands, ['php artisan migrate --force'])
  assertEquals(parsed?.postDeployTimeoutSeconds, 120)
  assertEquals(parsed?.postDeployTiming, 'after-switch')
  assertEquals(parsed?.workers, [
    { name: 'queue', command: 'php artisan queue:work', processes: 2, memoryMb: 256 },
    { name: 'off', command: 'php artisan other', enabled: false },
  ])
  assertEquals(parseServiceOptions({})?.workers, undefined)
})

test('saving refuses a bad command, worker or limit with a plain sentence', () => {
  assertEquals(validateSiteLifecycleOptions({}), null)
  assertEquals(validateSiteLifecycleOptions({ instances: 2 }), null)
  const bad = (options: Record<string, unknown>) => validateSiteLifecycleOptions(options) !== null
  assertEquals(bad({ postDeployCommands: ['php artisan migrate | tee x'] }), true)
  assertEquals(bad({ postDeployCommands: ['relative/path'] }), true)
  assertEquals(bad({ postDeployCommands: Array.from({ length: 11 }, () => '/bin/true') }), true)
  assertEquals(bad({ postDeployCommands: 'php artisan migrate' }), true)
  assertEquals(bad({ postDeployTimeoutSeconds: 10 }), true)
  assertEquals(bad({ postDeployTiming: 'never' }), true)
  assertEquals(bad({ workers: [{ name: 'Queue', command: '/bin/true' }] }), true)
  assertEquals(
    bad({
      workers: [
        { name: 'queue', command: '/bin/true' },
        { name: 'queue', command: '/bin/true' },
      ],
    }),
    true
  )
  assertEquals(bad({ workers: [{ name: 'queue', command: '/bin/true', processes: 9 }] }), true)
  assertEquals(bad({ workers: [{ name: 'queue', command: '/bin/true', memoryMb: 63 }] }), true)
  assertEquals(bad({ workers: [{ name: 'queue', command: '/bin/true', enabled: 'yes' }] }), true)
  assertEquals(
    bad({
      postDeployCommands: ['php artisan migrate --force'],
      postDeployTimeoutSeconds: 900,
      workers: [{ name: 'queue', command: 'php artisan queue:work', processes: 2, memoryMb: 128 }],
    }),
    false
  )
})

test('options render to the wire: argv, bytes, defaults left out, disabled workers skipped', () => {
  const options = parseServiceOptions({
    postDeployCommands: ['php artisan migrate --force'],
    postDeployTiming: 'after-switch',
    workers: [
      { name: 'queue', command: 'php artisan queue:work', processes: 2, memoryMb: 256 },
      { name: 'off', command: 'php artisan other', enabled: false },
    ],
  })
  const wire = renderSiteLifecycleForDeploy(options, 'release')
  assertEquals(wire.postDeploy, {
    commands: [['/usr/local/bin/php', 'artisan', 'migrate', '--force']],
    timing: 'after-switch',
  })
  assertEquals(wire.workers, [
    {
      name: 'queue',
      command: ['/usr/local/bin/php', 'artisan', 'queue:work'],
      processes: 2,
      memoryMaxBytes: 256 * 1024 * 1024,
    },
  ])
  assertEquals(renderSiteLifecycleForDeploy({}, 'release'), {})
  assertEquals(renderSiteLifecycleForDeploy(undefined, undefined), {})
  // A managed directory has no release for commands, but can run a worker.
  const managed = renderSiteLifecycleForDeploy(options, 'managed-directory')
  assertEquals(managed.postDeploy, undefined)
  assertEquals(managed.workers?.length, 1)
})

test('an old daemon is refused with a sentence naming the server, only when needed', () => {
  const withWorkers = { workers: [{ name: 'queue', command: ['/bin/true'] }] }
  const withCommands = { postDeploy: { commands: [['/bin/true']] } }
  assertEquals(sitesCarryLifecycle([{}, withCommands]), true)
  assertEquals(sitesCarryLifecycle([{}, { workers: [] }]), false)
  assertEquals(siteLifecycleUnsupported([{}], [], server), undefined)
  assertEquals(
    siteLifecycleUnsupported([withWorkers], [SITE_PHP_LIFECYCLE_FEATURE], server),
    undefined
  )
  const refused = siteLifecycleUnsupported([withCommands], ['deploy-config-files-v1'], server)
  assertEquals(
    refused?.message,
    'The daemon on omicron is too old to run post-deploy commands and background workers. Update the server, then deploy again.'
  )
  assertEquals(refused && mapPrepareErrorResponse(refused).status, 409)
})

test('an unowned site with commands or workers is a 422 naming the service', () => {
  const response = mapPrepareErrorResponse({
    kind: 'site_lifecycle_unowned',
    composeServiceName: 'blog',
  })
  assertEquals(response.status, 422)
  assertEquals((response.body as { error: string }).error, 'site_lifecycle_unowned')
  assertEquals((response.body as { message: string }).message.includes('"blog"'), true)
})

test('the PHP package manager names are reserved for builds, and COMPOSER_AUTH says why', () => {
  for (const name of ['COMPOSER_HOME', 'COMPOSER_CACHE_DIR', 'COMPOSER_AUTH', 'TURBOPANEL_PHP']) {
    assertEquals(isBuildEnvNameAllowed(name), false)
  }
  assertEquals(isBuildEnvNameAllowed('COMPOSER_MEMORY_LIMIT'), true)
  assertEquals(
    buildEnvSaveProblem('COMPOSER_AUTH', true),
    'Private PHP packages are not supported yet, so COMPOSER_AUTH cannot be set for a build.'
  )
  assertEquals(buildEnvSaveProblem('COMPOSER_AUTH', false), null)
  assertEquals(buildEnvSaveProblem('NEXT_PUBLIC_X', true), null)
})

test('commands or workers with no principal are unowned; nothing to run never is', () => {
  const wire = renderSiteLifecycleForDeploy(
    parseServiceOptions({ workers: [{ name: 'queue', command: 'php artisan queue:work' }] }),
    'release'
  )
  assertEquals(siteLifecycleUnowned(wire, false), true)
  assertEquals(siteLifecycleUnowned(wire, true), false)
  assertEquals(siteLifecycleUnowned({}, false), false)
})

test('the service write answers 400 with the sentence for a bad worker', () => {
  const bad = parseServiceCreateFields({
    options: { workers: [{ name: 'Queue', command: '/bin/true' }] },
  })
  assertEquals(bad.ok, false)
  assertEquals(!bad.ok && bad.status, 400)
  assertEquals(!bad.ok && bad.error.includes('worker name'), true)
  const patch = parseServicePatchFields({ options: { postDeployCommands: ['a | b'] } })
  assertEquals(!patch.ok && patch.status, 400)
  const fine = parseServiceCreateFields({
    options: { postDeployCommands: ['php artisan migrate --force'] },
  })
  assertEquals(fine.ok, true)
})

test('a service picks up its PHP version and pending restart from the site list', () => {
  const environmentId = '11111111-1111-4111-8111-111111111111'
  const sites = [
    {
      environmentId,
      composeServiceName: 'web',
      series: '8.4',
      version: '8.4.27',
      outdated: true as const,
    },
  ]
  assertEquals(phpFieldsForApp(sites, environmentId, 'web'), {
    phpVersion: '8.4.27',
    phpRestartPending: true,
  })
  assertEquals(phpFieldsForApp(sites, environmentId, 'other'), {})
})
