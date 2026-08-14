import { assertEquals } from 'jsr:@std/assert'
import {
  MYSQL_ACCOUNT_MAX_LENGTH,
  MYSQL_SCHEMA_MAX_LENGTH,
  RESERVED_CNF_KEYS,
  formatInnoDbBufferPoolSize,
  innodbBufferPoolSizeBytes,
  isValidMysqlAccountName,
  isValidMysqlCnfSnippet,
  isValidMysqlIdentifier,
} from './mysql-family.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isValidMysqlIdentifier enforces charset and length', () => {
  assertEquals(isValidMysqlIdentifier('app_db'), true)
  assertEquals(isValidMysqlIdentifier('A1'), true)
  assertEquals(isValidMysqlIdentifier('_root'), true)
  assertEquals(isValidMysqlIdentifier(''), false)
  assertEquals(isValidMysqlIdentifier('1bad'), false)
  assertEquals(isValidMysqlIdentifier('has-dash'), false)
  assertEquals(isValidMysqlIdentifier('a'.repeat(MYSQL_SCHEMA_MAX_LENGTH)), true)
  assertEquals(isValidMysqlIdentifier('a'.repeat(MYSQL_SCHEMA_MAX_LENGTH + 1)), false)
})

test('isValidMysqlAccountName uses the 32-char account ceiling', () => {
  assertEquals(isValidMysqlAccountName('app_user'), true)
  assertEquals(isValidMysqlAccountName('a'.repeat(MYSQL_ACCOUNT_MAX_LENGTH)), true)
  assertEquals(isValidMysqlAccountName('a'.repeat(MYSQL_ACCOUNT_MAX_LENGTH + 1)), false)
})

test('isValidMysqlCnfSnippet allows comments, sections, and safe keys', () => {
  assertEquals(
    isValidMysqlCnfSnippet(`
# comment
; another
[mysqld]
max_connections = 200
innodb-buffer-pool-instances = 2
`),
    true,
  )
})

test('isValidMysqlCnfSnippet rejects includes and reserved keys', () => {
  assertEquals(isValidMysqlCnfSnippet('!include /etc/mysql/extra.cnf'), false)
  assertEquals(isValidMysqlCnfSnippet('!includedir /etc/mysql/conf.d'), false)
  assertEquals(isValidMysqlCnfSnippet('port = 3307'), false)
  assertEquals(isValidMysqlCnfSnippet('bind-address = 0.0.0.0'), false)
  assertEquals(isValidMysqlCnfSnippet('ssl_ca = /tmp/ca.pem'), false)
  assertEquals(isValidMysqlCnfSnippet('gtid-mode = OFF'), false)
  assertEquals(isValidMysqlCnfSnippet('not a setting line'), false)
  assertEquals(RESERVED_CNF_KEYS.has('bind_address'), true)
  assertEquals(RESERVED_CNF_KEYS.has('gtid_mode'), true)
})

test('innodbBufferPoolSizeBytes floors at 128MiB and tracks half of memory', () => {
  const mib = 1024 * 1024
  assertEquals(innodbBufferPoolSizeBytes(64 * mib), 128 * mib)
  assertEquals(innodbBufferPoolSizeBytes(256 * mib), 128 * mib)
  assertEquals(innodbBufferPoolSizeBytes(512 * mib), 256 * mib)
  assertEquals(formatInnoDbBufferPoolSize(512 * mib), '256M')
  assertEquals(formatInnoDbBufferPoolSize(64 * mib), '128M')
})
