import { assertEquals } from '@std/assert'
import type { EnvironmentDeploySite } from '../../contracts/commands/schemas.ts'
import { DEFAULT_SITE_PHP_SERIES } from '../../contracts/runtime-registry.ts'
import { mergeDeployPrincipalRuntimes } from './merge-deploy-principal-runtimes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mergeDeployPrincipalRuntimes adds node@24 for a native app owner', () => {
  const principalId = '11111111-1111-4111-8111-111111111111'
  const { principalMaterial, deployEntitlements } = mergeDeployPrincipalRuntimes({
    principalMaterial: [
      {
        principalId,
        username: 'app_test',
        accessGroups: [],
        sshKeys: [],
      },
    ],
    nativeAppServices: [
      {
        composeServiceName: 'web',
        listenPort: 18_868,
        framework: 'next' as const,
      },
    ],
    sourceMaterial: [
      {
        composeServiceName: 'web',
        sourceId: '33333333-3333-4333-8333-333333333333',
        releaseId: '44444444-4444-4444-8444-444444444444',
        commitSha: 'abc123',
        provider: 'github' as const,
        cloneUrl: 'https://github.com/example/nextjs.git',
        ref: 'trunk',
        principal: {
          principalId,
          username: 'app_test',
        },
        build: { kind: 'native' as const },
      },
    ],
  })

  assertEquals(principalMaterial, [
    {
      principalId,
      username: 'app_test',
      accessGroups: [],
      sshKeys: [],
      runtimes: [{ runtime: 'node', series: '24' }],
    },
  ])
  assertEquals(deployEntitlements, [
    {
      principalId,
      runtime: 'node',
      series: '24',
    },
  ])
})

test('mergeDeployPrincipalRuntimes is idempotent when node entitlement already present', () => {
  const principalId = '11111111-1111-4111-8111-111111111111'
  const { deployEntitlements } = mergeDeployPrincipalRuntimes({
    principalMaterial: [
      {
        principalId,
        username: 'app_test',
        accessGroups: [],
        sshKeys: [],
        runtimes: [{ runtime: 'node', series: '24' }],
      },
    ],
    nativeAppServices: [
      {
        composeServiceName: 'web',
        listenPort: 18_868,
        framework: 'next' as const,
        nodeVersion: '24.17.0',
      },
    ],
    sourceMaterial: [
      {
        composeServiceName: 'web',
        sourceId: '33333333-3333-4333-8333-333333333333',
        releaseId: '44444444-4444-4444-8444-444444444444',
        commitSha: 'abc123',
        provider: 'github' as const,
        cloneUrl: 'https://github.com/example/nextjs.git',
        ref: 'trunk',
        principal: { principalId, username: 'app_test' },
        build: { kind: 'native' as const },
      },
    ],
  })

  assertEquals(deployEntitlements, [])
})

const sitePrincipalId = '22222222-2222-4222-8222-222222222222'

function sitePrincipalMaterial() {
  return [
    {
      principalId: sitePrincipalId,
      username: 'site_test',
      accessGroups: [],
      sshKeys: [],
    },
  ]
}

function phpSite(
  php: EnvironmentDeploySite['php'],
  engine: EnvironmentDeploySite['engine'] = 'nginx'
): EnvironmentDeploySite {
  return {
    composeServiceName: 'blog',
    engine,
    root: 'public',
    listenPort: 18_900,
    php,
    principal: { principalId: sitePrincipalId, username: 'site_test' },
  }
}

function mergeSites(sites: EnvironmentDeploySite[]) {
  return mergeDeployPrincipalRuntimes({
    principalMaterial: sitePrincipalMaterial(),
    nativeAppServices: [],
    sourceMaterial: [],
    sites,
  })
}

test('mergeDeployPrincipalRuntimes grants the php series a per-site fastcgi runtime implies', () => {
  const { principalMaterial, deployEntitlements } = mergeSites([
    phpSite({ version: '8.3', mode: 'fastcgi' }),
  ])

  assertEquals(principalMaterial[0]?.runtimes, [{ runtime: 'php', series: '8.3' }])
  assertEquals(deployEntitlements, [
    {
      principalId: sitePrincipalId,
      runtime: 'php',
      series: '8.3',
    },
  ])
})

test('mergeDeployPrincipalRuntimes uses the default php series for an fpm site without a version', () => {
  const { deployEntitlements } = mergeSites([
    phpSite({ mode: 'fpm', settings: { memory_limit: '256M' } }, 'apache'),
  ])

  assertEquals(deployEntitlements, [
    {
      principalId: sitePrincipalId,
      runtime: 'php',
      series: DEFAULT_SITE_PHP_SERIES,
    },
  ])
})

test('mergeDeployPrincipalRuntimes implies no php grant without a per-site mode', () => {
  const { principalMaterial, deployEntitlements } = mergeSites([phpSite({ version: '8.4' })])

  assertEquals(principalMaterial, sitePrincipalMaterial())
  assertEquals(deployEntitlements, [])
})

test('mergeDeployPrincipalRuntimes implies no php grant for lsphp modes', () => {
  const { deployEntitlements } = mergeSites([
    phpSite({ version: '8.4', mode: 'lsphp-detached' }, 'openlitespeed'),
    phpSite({ version: '8.4', mode: 'lsphp-attached' }, 'openlitespeed'),
  ])

  assertEquals(deployEntitlements, [])
})

test('mergeDeployPrincipalRuntimes does not re-persist a php grant the principal holds', () => {
  const { principalMaterial, deployEntitlements } = mergeDeployPrincipalRuntimes({
    principalMaterial: [
      {
        ...sitePrincipalMaterial()[0],
        runtimes: [{ runtime: 'php', series: '8.4' }],
      },
    ],
    nativeAppServices: [],
    sourceMaterial: [],
    sites: [phpSite({ version: '8.4', mode: 'fastcgi' })],
  })

  assertEquals(principalMaterial[0]?.runtimes, [{ runtime: 'php', series: '8.4' }])
  assertEquals(deployEntitlements, [])
})

test('mergeDeployPrincipalRuntimes grants a Deno app owner deno@2 and not node', () => {
  const principalId = '11111111-1111-4111-8111-111111111111'
  const { principalMaterial, deployEntitlements } = mergeDeployPrincipalRuntimes({
    principalMaterial: [{ principalId, username: 'app_test', accessGroups: [], sshKeys: [] }],
    nativeAppServices: [
      {
        composeServiceName: 'web',
        listenPort: 18_868,
        framework: 'auto' as const,
        runtime: 'deno' as const,
        denoVersion: '2.9.7',
      },
    ],
    sourceMaterial: [
      {
        composeServiceName: 'web',
        sourceId: '33333333-3333-4333-8333-333333333333',
        releaseId: '44444444-4444-4444-8444-444444444444',
        commitSha: 'abc123',
        provider: 'github' as const,
        cloneUrl: 'https://git.example.com/example/deno-app.git',
        ref: 'trunk',
        principal: { principalId, username: 'app_test' },
        build: { kind: 'native' as const },
      },
    ],
  })
  assertEquals(principalMaterial[0]?.runtimes, [{ runtime: 'deno', series: '2' }])
  assertEquals(deployEntitlements, [{ principalId, runtime: 'deno', series: '2' }])
})
