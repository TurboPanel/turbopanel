import { assertEquals } from '@std/assert'
import {
  buildSecretPlanEntry,
  composeSecretSourceName,
  composeSecretTargetName,
  DEFAULT_DEPLOY_RUN_DIR,
  secretContainerPath,
  secretFileEnvKey,
  secretHostDirectory,
  secretHostPath,
  secretRelativePath,
} from './secret-files.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PROJECT_ID = '01989d42-9adb-7e65-bc2e-f38792c53691'
const ENVIRONMENT_ID = '01989d42-9adb-7e65-bc2e-f38792c53692'

test('composeSecretSourceName slugifies service and key', () => {
  assertEquals(composeSecretSourceName('web-app', 'DB_PASSWORD'), 'web_app_db_password')
  assertEquals(composeSecretSourceName('---', '!!!'), 'x_x')
})

test('composeSecretTargetName keeps safe keys, slugifies unsafe', () => {
  assertEquals(composeSecretTargetName('DB_PASSWORD'), 'DB_PASSWORD')
  assertEquals(composeSecretTargetName('db/password'), 'db_password')
  assertEquals(composeSecretTargetName(''), 'x')
})

test('secretRelativePath joins service slug and raw key', () => {
  assertEquals(secretRelativePath('web', 'TOKEN'), 'web--TOKEN')
  assertEquals(secretRelativePath('web-app', 'db/pass'), 'web_app--db/pass')
})

test('secretHostDirectory normalizes trailing slashes on runDir', () => {
  assertEquals(
    secretHostDirectory(PROJECT_ID, ENVIRONMENT_ID),
    `${DEFAULT_DEPLOY_RUN_DIR}/deployments/${PROJECT_ID}/${ENVIRONMENT_ID}/secrets`,
  )
  assertEquals(
    secretHostDirectory(PROJECT_ID, ENVIRONMENT_ID, '/run/turbopanel///'),
    `/run/turbopanel/deployments/${PROJECT_ID}/${ENVIRONMENT_ID}/secrets`,
  )
})

test('secretHostPath joins directory and relative basename', () => {
  const relative = secretRelativePath('api', 'API_KEY')
  assertEquals(
    secretHostPath(PROJECT_ID, ENVIRONMENT_ID, relative),
    `${DEFAULT_DEPLOY_RUN_DIR}/deployments/${PROJECT_ID}/${ENVIRONMENT_ID}/secrets/${relative}`,
  )
})

test('secretContainerPath and secretFileEnvKey follow compose conventions', () => {
  assertEquals(secretContainerPath('DB_PASSWORD'), '/run/secrets/DB_PASSWORD')
  assertEquals(secretFileEnvKey('DB_PASSWORD'), 'DB_PASSWORD_FILE')
  assertEquals(secretFileEnvKey('TOKEN_FILE'), 'TOKEN_FILE')
})

test('buildSecretPlanEntry wires source, target, paths, and flags', () => {
  const entry = buildSecretPlanEntry({
    key: 'DB_PASSWORD',
    composeServiceName: 'web-app',
    forBuild: true,
    forRuntime: false,
  })
  assertEquals(entry.key, 'DB_PASSWORD')
  assertEquals(entry.composeServiceName, 'web-app')
  assertEquals(entry.source, 'web_app_db_password')
  assertEquals(entry.target, 'DB_PASSWORD')
  assertEquals(entry.relativePath, 'web_app--DB_PASSWORD')
  assertEquals(entry.forBuild, true)
  assertEquals(entry.forRuntime, false)
  assertEquals(
    secretHostPath(PROJECT_ID, ENVIRONMENT_ID, entry.relativePath),
    `${secretHostDirectory(PROJECT_ID, ENVIRONMENT_ID)}/${entry.relativePath}`,
  )
  assertEquals(secretContainerPath(entry.target), `/run/secrets/${entry.target}`)
})

test('buildSecretPlanEntry honors explicit target override', () => {
  const entry = buildSecretPlanEntry({
    key: 'RAW/KEY',
    composeServiceName: 'api',
    forBuild: false,
    forRuntime: true,
    target: 'custom/name',
  })
  assertEquals(entry.target, 'custom_name')
  assertEquals(entry.source, composeSecretSourceName('api', 'RAW/KEY'))
})
