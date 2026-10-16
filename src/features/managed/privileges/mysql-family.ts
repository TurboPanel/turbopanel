/**
 * MySQL (8.4, 9.7) and MariaDB (11.8, 12.3) privilege data.
 *
 * The two engines share the account model (`user@host`) and most database,
 * table, column and routine privileges, but not the server-wide ones: MySQL has
 * underscored "dynamic" privileges (`SYSTEM_VARIABLES_ADMIN`), MariaDB has
 * space-separated administrative privileges (`BINLOG ADMIN`) and a few of its
 * own (`DELETE HISTORY`, `SHOW CREATE ROUTINE`). Every entry is checked
 * against captured engine output by `catalogue.fixtures.test.ts`.
 *
 * Privileges that the engines accept on `*.*` but that are database-level in
 * kind (`SELECT ON *.*`) are not repeated at the `global` level: the effective
 * permissions reader reports them as a global placement the panel refuses.
 */

import type {
  EnginePrivilegeData,
  PrivilegeAllowance,
  PrivilegeBlocked,
  PrivilegeEntry,
  PrivilegeLevel,
  PrivilegeLevelInfo,
} from './types.ts'

export const MYSQL_SERIES = ['8.4', '9.7'] as const
export const MARIADB_SERIES = ['11.8', '12.3'] as const

const LEVELS: readonly PrivilegeLevelInfo[] = [
  {
    id: 'global',
    label: 'Whole server',
    explanation: 'Applies to every database on the server. Site owners never get these.',
  },
  {
    id: 'database',
    label: 'Database',
    explanation: 'Applies to every table, view and routine in one database, including later ones.',
  },
  {
    id: 'table',
    label: 'Tables and views',
    explanation: 'Applies to one table or view.',
  },
  {
    id: 'column',
    label: 'Columns',
    explanation: 'Limit read or write access to chosen columns of one table.',
  },
  {
    id: 'routine',
    label: 'Functions and procedures',
    explanation: 'Applies to one stored function or procedure.',
  },
]

const ACCOUNTS =
  'It can create or change other accounts or act as them, so the panel never gives it to a site owner.'
const SERVER_WIDE =
  'It acts on the whole server, not one database, so the panel never gives it to a site owner.'
const HOST_FILES =
  'It reads or writes files on the database server itself, so the panel never gives it to a site owner.'
const REPLICATION =
  'It controls or reads replication between servers, which the panel manages itself.'
const PEEKS = 'It shows other people’s activity or data on the server.'

type Row = {
  keyword: string
  label: string
  explanation: string
  aliases?: readonly string[]
  since?: string
  removedIn?: string
  allowed?: PrivilegeAllowance
  reason?: string
  grid?: boolean
}

function entries(level: PrivilegeLevel, rows: readonly Row[]): PrivilegeEntry[] {
  return rows.map((row) => {
    const allowed = row.allowed ?? (level === 'global' ? 'no' : 'yes')
    return {
      id: `${level}:${row.keyword}`,
      level,
      keyword: row.keyword,
      ...(row.aliases === undefined ? {} : { aliases: row.aliases }),
      label: row.label,
      explanation: row.explanation,
      ...(row.since === undefined ? {} : { since: row.since }),
      ...(row.removedIn === undefined ? {} : { removedIn: row.removedIn }),
      allowed,
      ...(allowed === 'yes' ? {} : { reason: row.reason ?? SERVER_WIDE }),
      grid: row.grid ?? true,
    }
  })
}

const GRANT_OPTION: Row = {
  keyword: 'GRANT OPTION',
  label: 'Pass access on',
  explanation: 'Give the privileges the login holds here to other accounts.',
  allowed: 'needs-admin',
  reason: 'The panel could no longer tell who has access if a login passed it on.',
}

/** Privileges that exist at database level and (mostly) at table level. */
const ALTER: Row = {
  keyword: 'ALTER',
  label: 'Change tables',
  explanation: 'Alter the structure of tables.',
}
const CREATE: Row = {
  keyword: 'CREATE',
  label: 'Create tables',
  explanation: 'Create databases and tables.',
}
const CREATE_VIEW: Row = {
  keyword: 'CREATE VIEW',
  label: 'Create views',
  explanation: 'Create views.',
}
const DELETE: Row = { keyword: 'DELETE', label: 'Delete rows', explanation: 'Delete rows.' }
const DROP: Row = {
  keyword: 'DROP',
  label: 'Drop tables',
  explanation: 'Drop tables and views, and empty a table with TRUNCATE.',
}
const INDEX: Row = {
  keyword: 'INDEX',
  label: 'Manage indexes',
  explanation: 'Create and drop indexes.',
}
const INSERT: Row = { keyword: 'INSERT', label: 'Add rows', explanation: 'Add new rows.' }
const REFERENCES: Row = {
  keyword: 'REFERENCES',
  label: 'Point foreign keys here',
  explanation: 'Create a foreign key that points at this table.',
}
const SELECT: Row = { keyword: 'SELECT', label: 'Read rows', explanation: 'Read rows.' }
const SHOW_VIEW: Row = {
  keyword: 'SHOW VIEW',
  label: 'See view definitions',
  explanation: 'Read how a view is defined.',
}
const TRIGGER: Row = {
  keyword: 'TRIGGER',
  label: 'Create triggers',
  explanation: 'Create and drop triggers.',
}
const UPDATE: Row = {
  keyword: 'UPDATE',
  label: 'Change rows',
  explanation: 'Change existing rows.',
}

const DATABASE_BASE: readonly Row[] = [
  ALTER,
  {
    keyword: 'ALTER ROUTINE',
    label: 'Change routines',
    explanation: 'Alter and drop stored functions and procedures.',
  },
  CREATE,
  {
    keyword: 'CREATE ROUTINE',
    label: 'Create routines',
    explanation: 'Create stored functions and procedures.',
  },
  {
    keyword: 'CREATE TEMPORARY TABLES',
    label: 'Temporary tables',
    explanation: 'Create temporary tables that vanish when the session ends.',
  },
  CREATE_VIEW,
  DELETE,
  DROP,
  {
    keyword: 'EVENT',
    label: 'Scheduled events',
    explanation: 'Create, change and drop scheduled events.',
  },
  {
    keyword: 'EXECUTE',
    label: 'Run routines',
    explanation: 'Call stored functions and procedures.',
  },
  INDEX,
  INSERT,
  {
    keyword: 'LOCK TABLES',
    label: 'Lock tables',
    explanation: 'Lock tables it can read, for consistent dumps.',
  },
  REFERENCES,
  SELECT,
  SHOW_VIEW,
  TRIGGER,
  UPDATE,
  GRANT_OPTION,
]

const TABLE_BASE: readonly Row[] = [
  ALTER,
  CREATE,
  CREATE_VIEW,
  DELETE,
  DROP,
  INDEX,
  INSERT,
  REFERENCES,
  SELECT,
  SHOW_VIEW,
  TRIGGER,
  UPDATE,
  GRANT_OPTION,
]

const COLUMN_BASE: readonly Row[] = [
  { ...SELECT, keyword: 'SELECT', label: 'Read column', explanation: 'Read this column.' },
  { ...INSERT, label: 'Add column value', explanation: 'Set this column when adding a row.' },
  { ...UPDATE, label: 'Change column', explanation: 'Change this column.' },
  { ...REFERENCES, explanation: 'Create a foreign key that points at this column.' },
]

const ROUTINE_BASE: readonly Row[] = [
  {
    keyword: 'ALTER ROUTINE',
    label: 'Change routine',
    explanation: 'Alter and drop this function or procedure.',
  },
  { keyword: 'EXECUTE', label: 'Run', explanation: 'Call the function or procedure.' },
  GRANT_OPTION,
]

const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys']

const BLOCKED: PrivilegeBlocked = {
  databases: SYSTEM_SCHEMAS,
  schemas: [],
  reservedPrefixes: ['tp_'],
}

/** Static privileges that exist only at the global level, shared by both engines. */
const GLOBAL_STATIC_SHARED: readonly Row[] = [
  {
    keyword: 'CREATE TABLESPACE',
    label: 'Manage tablespaces',
    explanation: 'Create, change and drop tablespaces and storage files.',
  },
  {
    keyword: 'PROXY',
    label: 'Act as another account',
    explanation: 'Log in as another account through a proxy mapping.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'CREATE USER',
    label: 'Manage accounts',
    explanation: 'Create, change, rename and drop accounts.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'FILE',
    label: 'Read and write server files',
    explanation: 'Read and write files on the database server.',
    reason: HOST_FILES,
  },
  {
    keyword: 'PROCESS',
    label: 'See all sessions',
    explanation: 'See every session and its running query.',
    reason: PEEKS,
  },
  {
    keyword: 'RELOAD',
    label: 'Flush server state',
    explanation: 'Run FLUSH to reload privileges, logs and caches.',
  },
  {
    keyword: 'REPLICATION SLAVE',
    label: 'Act as a replica',
    explanation: 'Read the change log so another server can copy this one.',
    reason: REPLICATION,
  },
  {
    keyword: 'SHOW DATABASES',
    label: 'List all databases',
    explanation: 'See the names of every database on the server.',
    reason: PEEKS,
  },
  { keyword: 'SHUTDOWN', label: 'Shut the server down', explanation: 'Stop the database server.' },
  {
    keyword: 'SUPER',
    label: 'Superuser',
    explanation: 'A catch-all for server-wide administration.',
  },
  {
    keyword: 'USAGE',
    label: 'No access',
    explanation: 'Means the account has no privileges at this level.',
    allowed: 'yes',
    grid: false,
  },
]

const MYSQL_GLOBAL: readonly Row[] = [
  ...GLOBAL_STATIC_SHARED,
  { keyword: 'CREATE ROLE', label: 'Create roles', explanation: 'Create roles.', reason: ACCOUNTS },
  { keyword: 'DROP ROLE', label: 'Drop roles', explanation: 'Drop roles.', reason: ACCOUNTS },
  {
    keyword: 'REPLICATION CLIENT',
    label: 'See replication state',
    explanation: 'See the status of the server’s change log and replicas.',
    reason: REPLICATION,
  },
  {
    keyword: 'ALLOW_NONEXISTENT_DEFINER',
    label: 'Orphan-definer objects',
    explanation: 'Create stored objects owned by an account that does not exist.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'APPLICATION_PASSWORD_ADMIN',
    label: 'Manage extra passwords',
    explanation: 'Manage the second password on accounts.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'AUDIT_ABORT_EXEMPT',
    label: 'Audit exemption',
    explanation: 'Skip being blocked by the audit log filter.',
  },
  {
    keyword: 'AUDIT_ADMIN',
    label: 'Manage the audit log',
    explanation: 'Change audit log settings.',
  },
  {
    keyword: 'AUTHENTICATION_POLICY_ADMIN',
    label: 'Manage sign-in policy',
    explanation: 'Change how accounts sign in.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'BACKUP_ADMIN',
    label: 'Run server backups',
    explanation: 'Take server-level backup locks.',
  },
  {
    keyword: 'BINLOG_ADMIN',
    label: 'Manage the change log',
    explanation: 'Purge and change the binary log.',
    reason: REPLICATION,
  },
  {
    keyword: 'BINLOG_ENCRYPTION_ADMIN',
    label: 'Manage change log encryption',
    explanation: 'Change encryption of the binary log.',
    reason: REPLICATION,
  },
  {
    keyword: 'CLONE_ADMIN',
    label: 'Clone the server',
    explanation: 'Copy the whole server’s data to or from another server.',
  },
  {
    keyword: 'CONNECTION_ADMIN',
    label: 'Manage connections',
    explanation: 'End other people’s sessions and ignore connection limits.',
    reason: PEEKS,
  },
  {
    keyword: 'ENCRYPTION_KEY_ADMIN',
    label: 'Manage encryption keys',
    explanation: 'Rotate the keys that encrypt data.',
  },
  {
    keyword: 'FIREWALL_EXEMPT',
    label: 'Firewall exemption',
    explanation: 'Skip the query firewall.',
  },
  {
    keyword: 'FLUSH_OPTIMIZER_COSTS',
    label: 'Flush optimizer costs',
    explanation: 'Reload query-planner cost settings.',
  },
  {
    keyword: 'FLUSH_PRIVILEGES',
    label: 'Flush privileges',
    explanation: 'Reload the privilege tables.',
    reason: ACCOUNTS,
  },
  { keyword: 'FLUSH_STATUS', label: 'Flush status', explanation: 'Reset server status counters.' },
  { keyword: 'FLUSH_TABLES', label: 'Flush tables', explanation: 'Close and reopen every table.' },
  {
    keyword: 'FLUSH_USER_RESOURCES',
    label: 'Flush user limits',
    explanation: 'Reset per-account resource counters.',
  },
  {
    keyword: 'GROUP_REPLICATION_ADMIN',
    label: 'Manage group replication',
    explanation: 'Start and stop group replication.',
    reason: REPLICATION,
  },
  {
    keyword: 'GROUP_REPLICATION_STREAM',
    label: 'Group replication stream',
    explanation: 'Use the group replication channel.',
    reason: REPLICATION,
  },
  {
    keyword: 'INNODB_REDO_LOG_ARCHIVE',
    label: 'Archive the redo log',
    explanation: 'Copy the storage engine’s redo log.',
  },
  {
    keyword: 'INNODB_REDO_LOG_ENABLE',
    label: 'Switch the redo log',
    explanation: 'Turn the storage engine’s redo log on or off.',
  },
  {
    keyword: 'OPTIMIZE_LOCAL_TABLE',
    label: 'Optimize without logging',
    explanation: 'Run OPTIMIZE LOCAL TABLE.',
  },
  {
    keyword: 'PASSWORDLESS_USER_ADMIN',
    label: 'Manage passwordless accounts',
    explanation: 'Manage accounts that have no password.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'PERSIST_RO_VARIABLES_ADMIN',
    label: 'Persist read-only settings',
    explanation: 'Write read-only settings to the server’s config.',
  },
  {
    keyword: 'REPLICATION_APPLIER',
    label: 'Apply replicated changes',
    explanation: 'Act as the account that applies a replica’s changes.',
    reason: REPLICATION,
  },
  {
    keyword: 'REPLICATION_SLAVE_ADMIN',
    label: 'Manage replication',
    explanation: 'Start, stop and configure replication.',
    reason: REPLICATION,
  },
  {
    keyword: 'RESOURCE_GROUP_ADMIN',
    label: 'Manage resource groups',
    explanation: 'Create and change resource groups.',
  },
  {
    keyword: 'RESOURCE_GROUP_USER',
    label: 'Use resource groups',
    explanation: 'Assign threads to resource groups.',
  },
  {
    keyword: 'ROLE_ADMIN',
    label: 'Manage roles',
    explanation: 'Grant and revoke roles, and use WITH ADMIN OPTION.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'SENSITIVE_VARIABLES_OBSERVER',
    label: 'See sensitive settings',
    explanation: 'See settings that hold secrets.',
    reason: PEEKS,
  },
  {
    keyword: 'SERVICE_CONNECTION_ADMIN',
    label: 'Use service connections',
    explanation: 'Connect on the reserved service port.',
  },
  {
    keyword: 'SESSION_VARIABLES_ADMIN',
    label: 'Set restricted session settings',
    explanation: 'Change session settings that are otherwise restricted.',
  },
  {
    keyword: 'SET_ANY_DEFINER',
    label: 'Act as any account',
    explanation: 'Create stored objects owned by any account.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'SHOW_ROUTINE',
    label: 'See all routine definitions',
    explanation: 'Read the code of every stored routine on the server.',
    reason: PEEKS,
  },
  {
    keyword: 'SYSTEM_USER',
    label: 'System account',
    explanation: 'Marks an account as a system account that ordinary accounts cannot change.',
    reason: ACCOUNTS,
  },
  {
    keyword: 'SYSTEM_VARIABLES_ADMIN',
    label: 'Change server settings',
    explanation: 'Change global server settings.',
  },
  {
    keyword: 'TABLE_ENCRYPTION_ADMIN',
    label: 'Manage table encryption',
    explanation: 'Override default table encryption.',
  },
  {
    keyword: 'TELEMETRY_LOG_ADMIN',
    label: 'Manage telemetry log',
    explanation: 'Change the telemetry log.',
  },
  {
    keyword: 'TRANSACTION_GTID_TAG',
    label: 'Tag transactions',
    explanation: 'Set a tag on replicated transaction ids.',
    reason: REPLICATION,
  },
  {
    keyword: 'CREATE_SPATIAL_REFERENCE_SYSTEM',
    label: 'Manage spatial systems',
    explanation: 'Create and change spatial reference systems.',
    since: '9.7',
  },
  {
    keyword: 'MANAGE_DATA_MASKING_POLICY',
    label: 'Manage data masking',
    explanation: 'Create and change data masking policies.',
    since: '9.7',
  },
  {
    keyword: 'XA_RECOVER_ADMIN',
    label: 'Recover prepared transactions',
    explanation: 'See and end other sessions’ prepared transactions.',
    reason: PEEKS,
  },
]

const MARIADB_GLOBAL: readonly Row[] = [
  ...GLOBAL_STATIC_SHARED,
  {
    keyword: 'BINLOG ADMIN',
    label: 'Manage the change log',
    explanation: 'Purge and change the binary log.',
    reason: REPLICATION,
  },
  {
    keyword: 'BINLOG MONITOR',
    aliases: ['REPLICATION CLIENT'],
    label: 'See the change log',
    explanation: 'See the binary log and replication status.',
    reason: REPLICATION,
  },
  {
    keyword: 'BINLOG REPLAY',
    label: 'Replay the change log',
    explanation: 'Replay binary log events.',
    reason: REPLICATION,
  },
  {
    keyword: 'CONNECTION ADMIN',
    label: 'Manage connections',
    explanation: 'End other people’s sessions and ignore connection limits.',
    reason: PEEKS,
  },
  {
    keyword: 'FEDERATED ADMIN',
    label: 'Manage remote servers',
    explanation: 'Create, change and drop remote server links.',
  },
  {
    keyword: 'READ_ONLY ADMIN',
    label: 'Write on a read-only server',
    explanation: 'Write even when the server is read-only.',
  },
  {
    keyword: 'REPLICATION MASTER ADMIN',
    label: 'Manage the source server',
    explanation: 'Manage replicas from the source side.',
    reason: REPLICATION,
  },
  {
    keyword: 'REPLICA MONITOR',
    aliases: ['SLAVE MONITOR'],
    label: 'See replica state',
    explanation: 'See the status of a replica.',
    reason: REPLICATION,
  },
  {
    keyword: 'REPLICATION SLAVE ADMIN',
    label: 'Manage replication',
    explanation: 'Start, stop and configure replication.',
    reason: REPLICATION,
  },
  {
    keyword: 'SET USER',
    label: 'Act as any account',
    explanation: 'Create stored objects owned by any account.',
    reason: ACCOUNTS,
  },
]

const MARIADB_DB_EXTRA: readonly Row[] = [
  {
    keyword: 'DELETE HISTORY',
    label: 'Delete history',
    explanation: 'Delete old row versions from system-versioned tables.',
  },
  {
    keyword: 'SHOW CREATE ROUTINE',
    label: 'See routine definitions',
    explanation: 'Read the code of stored routines in the database.',
  },
]

function splice(base: readonly Row[], extra: readonly Row[]): readonly Row[] {
  const grant = base.filter((row) => row.keyword === 'GRANT OPTION')
  return [...base.filter((row) => row.keyword !== 'GRANT OPTION'), ...extra, ...grant]
}

const MYSQL_PRIVILEGES: readonly PrivilegeEntry[] = [
  ...entries('global', MYSQL_GLOBAL),
  ...entries('database', DATABASE_BASE),
  ...entries('table', TABLE_BASE),
  ...entries('column', COLUMN_BASE),
  ...entries('routine', ROUTINE_BASE),
]

const MARIADB_ROUTINE: readonly Row[] = splice(ROUTINE_BASE, [MARIADB_DB_EXTRA[1]!])

const MARIADB_PRIVILEGES: readonly PrivilegeEntry[] = [
  ...entries('global', MARIADB_GLOBAL),
  ...entries('database', splice(DATABASE_BASE, MARIADB_DB_EXTRA)),
  ...entries('table', splice(TABLE_BASE, [MARIADB_DB_EXTRA[0]!])),
  ...entries('column', COLUMN_BASE),
  ...entries('routine', MARIADB_ROUTINE),
]

const NO_POSTGRES_ONLY = {
  roles: [],
  attributes: [],
  membershipOptions: [],
  defaultPrivilegeObjects: [],
} as const

export const MYSQL_PRIVILEGE_DATA: EnginePrivilegeData = {
  engine: 'mysql',
  series: MYSQL_SERIES,
  levels: LEVELS,
  privileges: MYSQL_PRIVILEGES,
  blocked: BLOCKED,
  ...NO_POSTGRES_ONLY,
}

export const MARIADB_PRIVILEGE_DATA: EnginePrivilegeData = {
  engine: 'mariadb',
  series: MARIADB_SERIES,
  levels: LEVELS,
  privileges: MARIADB_PRIVILEGES,
  blocked: BLOCKED,
  ...NO_POSTGRES_ONLY,
}
