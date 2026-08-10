/**
 * Pure helpers shared by the MySQL and MariaDB managed engine specs.
 *
 * Keep SQL-dialect and image-specific config out of this module — only
 * identifier rules, CNF snippet validation, and resource sizing live here.
 */

const ACCOUNT_MAX_LENGTH = 32
const SCHEMA_MAX_LENGTH = 64
const MYSQL_IDENTIFIER_RE = /^[A-Za-z_]\w*$/

/** MySQL treats `-` and `_` interchangeably in option names. */
function normalizeCnfKey(key: string): string {
  return key.toLowerCase().replaceAll('-', '_')
}

const INCLUDE_DIRECTIVE_RE = /^\s*!include(?:dir)?\b/i
/** Section header (`[mysqld]`) or blank/comment. */
const CNF_SECTION_RE = /^\s*\[[^\]]+\]\s*$/
/** `key = value` setting line. */
const CNF_SETTING_LINE_RE = /^\s*[A-Za-z_][\w-]*\s*=.+$/
const CNF_SETTING_KEY_RE = /^\s*([A-Za-z_][\w-]*)\s*=/

/**
 * Platform-owned my.cnf keys (network/port, TLS, paths, GTID/replication).
 * Operator snippets must not override these.
 */
export const RESERVED_CNF_KEYS = new Set(
  [
    'port',
    'bind-address',
    'ssl_ca',
    'ssl_cert',
    'ssl_key',
    'ssl-ca',
    'ssl-cert',
    'ssl-key',
    'require_secure_transport',
    'datadir',
    'socket',
    'server_id',
    'log_bin',
    'gtid_mode',
    'enforce_gtid_consistency',
    'binlog_format',
    'read_only',
    'super_read_only',
    'relay_log',
    'binlog_expire_logs_seconds',
    // MariaDB GTID vocabulary (also reserved so operators cannot disable).
    'log_slave_updates',
    'log_replica_updates',
    'gtid_strict_mode',
    'gtid_domain_id',
    'skip_name_resolve',
    'authentication_policy',
    'default_authentication_plugin',
  ].map(normalizeCnfKey),
)

export function isValidMysqlIdentifier(
  value: string,
  maxLength = SCHEMA_MAX_LENGTH,
): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    MYSQL_IDENTIFIER_RE.test(value)
  )
}

export function isValidMysqlAccountName(value: string): boolean {
  return isValidMysqlIdentifier(value, ACCOUNT_MAX_LENGTH)
}

/**
 * Reject `!include` / `!includedir` and any {@link RESERVED_CNF_KEYS} key so
 * operator snippets cannot override platform port/TLS/replication invariants.
 * Keys are matched after normalising `-`/`_` (MySQL treats them as equal).
 */
export function isValidMysqlCnfSnippet(snippet: string): boolean {
  const lines = snippet.split('\n')
  for (const line of lines) {
    if (INCLUDE_DIRECTIVE_RE.test(line)) return false
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue
    }
    if (CNF_SECTION_RE.test(line)) continue
    if (!CNF_SETTING_LINE_RE.test(line)) return false
    const match = CNF_SETTING_KEY_RE.exec(line)
    if (match === null || RESERVED_CNF_KEYS.has(normalizeCnfKey(match[1]!))) {
      return false
    }
  }
  return true
}

/**
 * Derive InnoDB buffer pool size (~50% of memoryBytes) the way Postgres
 * derives shared_buffers from the container memory limit.
 */
export function innodbBufferPoolSizeBytes(memoryBytes: number): number {
  const half = Math.floor(memoryBytes / 2)
  // Floor at 128 MiB so a tiny limit never yields a sub-page pool.
  return Math.max(128 * 1024 * 1024, half)
}

export function formatInnoDbBufferPoolSize(memoryBytes: number): string {
  const bytes = innodbBufferPoolSizeBytes(memoryBytes)
  return `${Math.floor(bytes / (1024 * 1024))}M`
}

export const MYSQL_ACCOUNT_MAX_LENGTH = ACCOUNT_MAX_LENGTH
export const MYSQL_SCHEMA_MAX_LENGTH = SCHEMA_MAX_LENGTH
export const MYSQL_IDENTIFIER_PATTERN = MYSQL_IDENTIFIER_RE
