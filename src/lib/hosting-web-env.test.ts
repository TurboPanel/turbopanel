import { assertEquals } from '@std/assert'
import type { Db } from '../db.ts'
import { encryptSecret } from '../client/authn/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../client/authn/secrets.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import {
  attachWebMetadataToSites,
  formatHostingEnvFile,
  parseHostingEnvFile,
  resolveHostingDeployWeb,
  sanitizeHostingWebEnv,
} from './hosting-web-env.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

async function dataSecrets() {
  const config = parseTestSecretsConfig('deno')
  return await deriveEncryptionSecretsConfig(config, 'data-encryption')
}

/** Empty inheritance chain (hosting exists, no variables at any scope). */
function emptyHostingVarsDb(): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () =>
                    Promise.resolve([
                      {
                        organizationId: 'org',
                        workspaceId: 'ws',
                        projectId: 'proj',
                        environmentId: 'env',
                        serviceId: 'svc',
                      },
                    ]),
                }),
              }),
            }),
          }),
        }),
        where: () => thenableRows([]),
      }),
    }),
  } as unknown as Db
}

/** Hosting chain with a single hosting-scoped variable pack on the last load. */
function hostingVarsDb(hostingRows: unknown[]): Db {
  let varLoads = 0
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () =>
                    Promise.resolve([
                      {
                        organizationId: 'org',
                        workspaceId: 'ws',
                        projectId: 'proj',
                        environmentId: 'env',
                        serviceId: 'svc',
                      },
                    ]),
                }),
              }),
            }),
          }),
        }),
        where: () => {
          varLoads += 1
          // org, workspace, project, environment, service, hosting
          if (varLoads < 6) return thenableRows([])
          return thenableRows(hostingRows)
        },
      }),
    }),
  } as unknown as Db
}

test('sanitizeHostingWebEnv drops invalid keys and empty values', () => {
  assertEquals(sanitizeHostingWebEnv(undefined), undefined)
  assertEquals(
    sanitizeHostingWebEnv({
      APP_ENV: 'prod',
      'bad-key': 'x',
      EMPTY: '   ',
      TOO_LONG: 'x'.repeat(5000),
    }),
    { APP_ENV: 'prod' },
  )
})

test('sanitizeHostingWebEnv returns undefined when every entry is dropped', () => {
  assertEquals(
    sanitizeHostingWebEnv({
      'bad-key': 'x',
      EMPTY: '   ',
      TOO_LONG: 'x'.repeat(5000),
    }),
    undefined,
  )
})

test('sanitizeHostingWebEnv trims usable values', () => {
  assertEquals(sanitizeHostingWebEnv({ APP_ENV: '  prod  ' }), {
    APP_ENV: 'prod',
  })
})

test('sanitizeHostingWebEnv caps entries at 64 keys', () => {
  const raw: Record<string, string> = {}
  for (let i = 0; i < 80; i += 1) {
    raw[`KEY_${String(i).padStart(3, '0')}`] = 'v'
  }
  const sanitized = sanitizeHostingWebEnv(raw)
  assertEquals(Object.keys(sanitized ?? {}).length, 64)
})

test('formatHostingEnvFile escapes quotes backslashes and newlines', () => {
  const file = formatHostingEnvFile({
    MULTI: 'line1\nline2',
    PATHY: String.raw`C:\tmp\file`,
  })
  assertEquals(parseHostingEnvFile(file), {
    MULTI: 'line1\nline2',
    PATHY: String.raw`C:\tmp\file`,
  })
})

test('parseHostingEnvFile ignores comments blanks and bad lines', () => {
  assertEquals(
    parseHostingEnvFile('# comment\n\nBAD\nAPP=ok\nbad-key=nope\n'),
    { APP: 'ok' },
  )
})

test('attachWebMetadataToSites merges by compose service name', () => {
  const sites = [
    {
      composeServiceName: 'web',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18080,
    },
    {
      composeServiceName: 'static',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18081,
    },
  ]
  const out = attachWebMetadataToSites(sites, [
    {
      composeServiceName: 'web',
      web: { env: { APP_ENV: 'staging' } },
    },
    {
      composeServiceName: 'web',
      web: { env: { DEBUG: '1' } },
    },
    { composeServiceName: 'static' },
  ])
  // env is genuinely per hostname, so several hostings on one service merge.
  assertEquals(out[0]?.webEnv, { APP_ENV: 'staging', DEBUG: '1' })
  assertEquals(out[1]?.webEnv, undefined)
  // PHP is NOT merged here any more: a pool is 1:1 with the compose service, so
  // a per-hosting PHP setting was unrepresentable and silently last-wins merged.
  // It now comes from the service's own x-turbopanel.php.
  assertEquals(out[0]?.php, undefined)
})

test('formatHostingEnvFile sorts keys and escapes special characters', () => {
  const file = formatHostingEnvFile({
    ZEBRA: 'last',
    ALPHA: 'a"b\\c\nd',
  })
  assertEquals(file.indexOf('ALPHA=') < file.indexOf('ZEBRA='), true)
  assertEquals(parseHostingEnvFile(file), {
    ALPHA: 'a"b\\c\nd',
    ZEBRA: 'last',
  })
})

test('parseHostingEnvFile accepts unquoted values', () => {
  assertEquals(parseHostingEnvFile('PLAIN=hello'), { PLAIN: 'hello' })
})

test('sanitizeHostingWebEnv ignores non-string values in raw map', () => {
  const raw = { APP_ENV: 'prod', BAD: 123 as unknown as string }
  assertEquals(sanitizeHostingWebEnv(raw), { APP_ENV: 'prod' })
})

test('attachWebMetadataToSites skips empty web payloads', () => {
  const sites = [
    {
      composeServiceName: 'web',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18080,
    },
  ]
  const out = attachWebMetadataToSites(sites, [
    { composeServiceName: 'web', web: { env: {}, php: {} } },
  ])
  assertEquals(out[0], sites[0])
})

test('attachWebMetadataToSites leaves php alone', () => {
  const sites = [
    {
      composeServiceName: 'web',
      engine: 'apache' as const,
      root: 'public',
      listenPort: 18080,
    },
  ]
  // A hosting row carrying php contributes nothing: the site keeps whatever
  // its compose service declared (here, nothing).
  const out = attachWebMetadataToSites(sites, [
    { composeServiceName: 'web', web: { php: { version: '8.3' } } },
  ])
  assertEquals(out[0]?.php, undefined)
  assertEquals(out[0]?.webEnv, undefined)
  assertEquals(out[0], sites[0])
})

test('attachWebMetadataToSites attaches env-only metadata', () => {
  const sites = [
    {
      composeServiceName: 'web',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18080,
    },
  ]
  const out = attachWebMetadataToSites(sites, [
    { composeServiceName: 'web', web: { env: { APP_ENV: 'prod' } } },
  ])
  assertEquals(out[0]?.webEnv, { APP_ENV: 'prod' })
  assertEquals(out[0]?.php, undefined)
})

test('attachWebMetadataToSites skips hostings without web and unmatched sites', () => {
  const sites = [
    {
      composeServiceName: 'web',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18080,
    },
    {
      composeServiceName: 'other',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18081,
    },
  ]
  const out = attachWebMetadataToSites(sites, [
    { composeServiceName: 'web' },
    {
      composeServiceName: 'unrelated',
      web: { env: { IGNORED: '1' } },
    },
  ])
  assertEquals(out[0], sites[0])
  assertEquals(out[1], sites[1])
})

test('resolveHostingDeployWeb returns undefined for non-object options', async () => {
  const secrets = await dataSecrets()
  assertEquals(
    await resolveHostingDeployWeb(emptyHostingVarsDb(), secrets, 'h1', 'nope'),
    undefined,
  )
})

test('resolveHostingDeployWeb returns undefined when options have no web payload', async () => {
  const secrets = await dataSecrets()
  assertEquals(
    await resolveHostingDeployWeb(emptyHostingVarsDb(), secrets, 'h1', {}),
    undefined,
  )
  assertEquals(
    await resolveHostingDeployWeb(emptyHostingVarsDb(), secrets, 'h1', null),
    undefined,
  )
})

test('resolveHostingDeployWeb ignores hosting php entirely', async () => {
  const secrets = await dataSecrets()
  // `hosting.options.web.php` is dead: PHP config moved to the compose
  // service's x-turbopanel.php, which is the entity an FPM pool belongs to.
  // A stale value left on an old hosting row must not reach the wire.
  assertEquals(
    await resolveHostingDeployWeb(emptyHostingVarsDb(), secrets, 'h1', {
      web: { php: { version: '8.3', memoryLimit: '256M' } },
    }),
    undefined,
  )
  assertEquals(
    await resolveHostingDeployWeb(emptyHostingVarsDb(), secrets, 'h1', {
      web: { env: { APP_ENV: 'prod' }, php: { version: '8.4' } },
    }),
    { env: { APP_ENV: 'prod' } },
  )
})

test('resolveHostingDeployWeb merges runtime variables; static env wins collisions', async () => {
  const secrets = await dataSecrets()
  const sealed = await encryptSecret(secrets, 'from-secret')
  const db = hostingVarsDb([
    {
      key: 'RUNTIME_PLAIN',
      value: 'runtime',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    },
    {
      key: 'SECRET_KEY',
      value: sealed,
      isSecret: true,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    },
    {
      key: 'BUILD_ONLY',
      value: 'nope',
      isSecret: false,
      isLiteral: false,
      forBuild: true,
      forRuntime: false,
    },
    {
      key: 'bad-key',
      value: 'nope',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    },
    {
      key: 'EMPTY_RUNTIME',
      value: '   ',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    },
    {
      key: 'COLLIDE',
      value: 'from-var',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    },
  ])
  const web = await resolveHostingDeployWeb(db, secrets, 'h1', {
    web: {
      env: { COLLIDE: 'from-static', STATIC_ONLY: 'yes' },
    },
  })
  assertEquals(web, {
    env: {
      RUNTIME_PLAIN: 'runtime',
      SECRET_KEY: 'from-secret',
      COLLIDE: 'from-static',
      STATIC_ONLY: 'yes',
    },
  })
})
