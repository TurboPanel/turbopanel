/**
 * PostgreSQL privilege data, 15 through 18.
 *
 * Every entry is checked against captured engine output by
 * `catalogue.fixtures.test.ts` (see `fixtures/README.md`). Adding a major
 * version means: capture its fixture, add it to `POSTGRES_SERIES`, and add or
 * bound (`since` / `removedIn`) any entry that appeared or went away.
 */

import type {
  EnginePrivilegeData,
  PrivilegeAttributeEntry,
  PrivilegeDefaultObject,
  PrivilegeEntry,
  PrivilegeLevel,
  PrivilegeLevelInfo,
  PrivilegeMembershipOption,
  PrivilegeRoleEntry,
} from './types.ts'

export const POSTGRES_SERIES = ['15', '16', '17', '18'] as const

const LEVELS: readonly PrivilegeLevelInfo[] = [
  {
    id: 'database',
    label: 'Database',
    explanation: 'Who may connect to a database, create schemas in it, or use temporary tables.',
  },
  {
    id: 'schema',
    label: 'Schema',
    explanation: 'A schema is a folder of tables inside a database. Use it to reach or add tables.',
  },
  {
    id: 'table',
    label: 'Tables and views',
    explanation: 'Tables, views, materialized views and foreign tables.',
  },
  {
    id: 'column',
    label: 'Columns',
    explanation: 'Limit read or write access to chosen columns of one table.',
  },
  {
    id: 'sequence',
    label: 'Sequences',
    explanation: 'Counters that hand out ids, such as the one behind an auto-numbered column.',
  },
  {
    id: 'routine',
    label: 'Functions and procedures',
    explanation: 'Stored functions and procedures that can be called.',
  },
  {
    id: 'type',
    label: 'Types and domains',
    explanation: 'Custom data types and domains.',
  },
]

type Row = {
  keyword: string
  letter: string
  label: string
  explanation: string
  since?: string
  allowed?: PrivilegeEntry['allowed']
  reason?: string
}

function entries(level: PrivilegeLevel, rows: readonly Row[]): PrivilegeEntry[] {
  return rows.map((row) => ({
    id: `${level}:${row.keyword}`,
    level,
    keyword: row.keyword,
    label: row.label,
    explanation: row.explanation,
    ...(row.since === undefined ? {} : { since: row.since }),
    allowed: row.allowed ?? 'yes',
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    aclLetter: row.letter,
    grid: true,
  }))
}

const DATABASE = entries('database', [
  {
    keyword: 'CONNECT',
    letter: 'c',
    label: 'Connect',
    explanation: 'Open a connection to this database.',
  },
  {
    keyword: 'CREATE',
    letter: 'C',
    label: 'Create schemas',
    explanation: 'Create new schemas in this database.',
  },
  {
    keyword: 'TEMPORARY',
    letter: 'T',
    label: 'Temporary tables',
    explanation: 'Create temporary tables that vanish when the session ends.',
  },
])

const SCHEMA = entries('schema', [
  {
    keyword: 'USAGE',
    letter: 'U',
    label: 'Use the schema',
    explanation: 'Look up objects inside the schema. Needed before any table in it can be used.',
  },
  {
    keyword: 'CREATE',
    letter: 'C',
    label: 'Create objects',
    explanation: 'Create tables, views, functions and other objects in the schema.',
  },
])

const TABLE = entries('table', [
  {
    keyword: 'SELECT',
    letter: 'r',
    label: 'Read rows',
    explanation: 'Read rows from the table or view.',
  },
  { keyword: 'INSERT', letter: 'a', label: 'Add rows', explanation: 'Add new rows.' },
  { keyword: 'UPDATE', letter: 'w', label: 'Change rows', explanation: 'Change existing rows.' },
  { keyword: 'DELETE', letter: 'd', label: 'Delete rows', explanation: 'Delete rows.' },
  {
    keyword: 'TRUNCATE',
    letter: 'D',
    label: 'Empty the table',
    explanation: 'Remove every row at once.',
  },
  {
    keyword: 'REFERENCES',
    letter: 'x',
    label: 'Point foreign keys here',
    explanation: 'Create a foreign key that points at this table.',
  },
  {
    keyword: 'TRIGGER',
    letter: 't',
    label: 'Create triggers',
    explanation: 'Create triggers on the table.',
  },
  {
    keyword: 'MAINTAIN',
    letter: 'm',
    label: 'Run maintenance',
    explanation: 'Run vacuum, analyze, cluster, reindex and refresh a materialized view.',
    since: '17',
  },
])

const COLUMN = entries('column', [
  {
    keyword: 'SELECT',
    letter: 'r',
    label: 'Read column',
    explanation: 'Read this column.',
  },
  { keyword: 'INSERT', letter: 'a', label: 'Add column value', explanation: 'Set this column when adding a row.' },
  { keyword: 'UPDATE', letter: 'w', label: 'Change column', explanation: 'Change this column.' },
  {
    keyword: 'REFERENCES',
    letter: 'x',
    label: 'Point foreign keys here',
    explanation: 'Create a foreign key that points at this column.',
  },
])

const SEQUENCE = entries('sequence', [
  {
    keyword: 'USAGE',
    letter: 'U',
    label: 'Use the counter',
    explanation: 'Take the next number from the sequence.',
  },
  {
    keyword: 'SELECT',
    letter: 'r',
    label: 'Read the counter',
    explanation: 'Read the sequence position without moving it.',
  },
  {
    keyword: 'UPDATE',
    letter: 'w',
    label: 'Reset the counter',
    explanation: 'Move or reset the sequence position.',
  },
])

const ROUTINE = entries('routine', [
  {
    keyword: 'EXECUTE',
    letter: 'X',
    label: 'Run',
    explanation: 'Call the function or procedure.',
  },
])

const TYPE = entries('type', [
  {
    keyword: 'USAGE',
    letter: 'U',
    label: 'Use the type',
    explanation: 'Use the type or domain when defining columns and functions.',
  },
])

const PRIVILEGES: readonly PrivilegeEntry[] = [
  ...DATABASE,
  ...SCHEMA,
  ...TABLE,
  ...COLUMN,
  ...SEQUENCE,
  ...ROUTINE,
  ...TYPE,
]

const CLUSTER_WIDE =
  'It reaches every database on the server, so the panel keeps it off site owners’ logins.'
const HOST_ACCESS =
  'It lets the holder read, write or run things on the server itself, so the panel never gives it out.'

function role(
  name: string,
  label: string,
  explanation: string,
  options: Partial<Omit<PrivilegeRoleEntry, 'name' | 'label' | 'explanation'>> = {}
): PrivilegeRoleEntry {
  return {
    name,
    label,
    explanation,
    grantable: true,
    allowed: 'needs-admin',
    reason: CLUSTER_WIDE,
    ...options,
  }
}

const ROLES: readonly PrivilegeRoleEntry[] = [
  role(
    'pg_checkpoint',
    'Run checkpoints',
    'Force a checkpoint, which flushes pending writes to disk.',
    { since: '15' }
  ),
  role(
    'pg_create_subscription',
    'Create subscriptions',
    'Create logical replication subscriptions.',
    { since: '16', allowed: 'no', reason: HOST_ACCESS }
  ),
  {
    name: 'pg_database_owner',
    label: 'Database owner',
    explanation: 'Held automatically by whoever owns the current database. It cannot be granted.',
    grantable: false,
    allowed: 'no',
    reason: 'Postgres assigns it itself.',
  },
  role(
    'pg_execute_server_program',
    'Run programs on the server',
    'Run programs on the database server as the database operating system user.',
    { allowed: 'no', reason: HOST_ACCESS }
  ),
  role('pg_maintain', 'Maintain every table', 'Vacuum, analyze, reindex and cluster any table.', {
    since: '17',
  }),
  role('pg_monitor', 'Monitor the server', 'Read server settings, statistics and monitoring views.'),
  role(
    'pg_read_all_data',
    'Read everything',
    'Read every table, view and sequence in every database on the server.'
  ),
  role('pg_read_all_settings', 'Read all settings', 'Read every server setting, including private ones.'),
  role('pg_read_all_stats', 'Read all statistics', 'Read every statistics view, including other people’s queries.'),
  role(
    'pg_read_server_files',
    'Read server files',
    'Read any file the database operating system user can read.',
    { allowed: 'no', reason: HOST_ACCESS }
  ),
  role(
    'pg_signal_autovacuum_worker',
    'Stop autovacuum workers',
    'Cancel or end the background clean-up workers.',
    { since: '18' }
  ),
  role('pg_signal_backend', 'Stop other sessions', 'Cancel or end other people’s sessions.'),
  role('pg_stat_scan_tables', 'Scan tables for statistics', 'Run monitoring functions that take locks on tables.'),
  role(
    'pg_use_reserved_connections',
    'Use reserved connections',
    'Use the connection slots kept for emergencies.',
    { since: '16' }
  ),
  role(
    'pg_write_all_data',
    'Write everything',
    'Add, change and delete rows in every table in every database on the server.'
  ),
  role(
    'pg_write_server_files',
    'Write server files',
    'Write any file the database operating system user can write.',
    { allowed: 'no', reason: HOST_ACCESS }
  ),
]

const ATTRIBUTES: readonly PrivilegeAttributeEntry[] = [
  {
    name: 'SUPERUSER',
    column: 'rolsuper',
    label: 'Superuser',
    explanation: 'Bypasses every permission check on the server.',
    allowed: 'no',
    reason: 'It would give the holder the whole server.',
  },
  {
    name: 'CREATEDB',
    column: 'rolcreatedb',
    label: 'Create databases',
    explanation: 'Create new databases on the server.',
    allowed: 'no',
    reason: 'Databases are created through the panel so they stay inventoried and backed up.',
  },
  {
    name: 'CREATEROLE',
    column: 'rolcreaterole',
    label: 'Create logins',
    explanation: 'Create, change and drop other logins.',
    allowed: 'no',
    reason: 'Logins are created through the panel.',
  },
  {
    name: 'REPLICATION',
    column: 'rolreplication',
    label: 'Replication',
    explanation: 'Stream the whole server’s data to another server.',
    allowed: 'no',
    reason: 'It reads every database on the server.',
  },
  {
    name: 'BYPASSRLS',
    column: 'rolbypassrls',
    label: 'Skip row-level security',
    explanation: 'Ignore row-level security policies on every table.',
    allowed: 'no',
    reason: 'It defeats the policies the database owner set.',
  },
  {
    name: 'LOGIN',
    column: 'rolcanlogin',
    label: 'Can log in',
    explanation: 'Open connections. The panel turns this on for every login it manages.',
    allowed: 'yes',
  },
  {
    name: 'INHERIT',
    column: 'rolinherit',
    label: 'Inherit role privileges',
    explanation: 'Use the privileges of roles it is a member of without switching.',
    allowed: 'yes',
  },
  {
    name: 'CONNECTION LIMIT',
    column: 'rolconnlimit',
    label: 'Connection limit',
    explanation: 'The most connections this login may hold at once.',
    allowed: 'yes',
  },
]

const MEMBERSHIP_OPTIONS: readonly PrivilegeMembershipOption[] = [
  {
    id: 'inherit',
    keyword: 'INHERIT',
    label: 'Use its privileges automatically',
    explanation: 'Privileges of the role apply without running SET ROLE.',
    since: '16',
    allowed: 'yes',
  },
  {
    id: 'set',
    keyword: 'SET',
    label: 'May switch to it',
    explanation: 'The login can run SET ROLE to act as the role.',
    since: '16',
    allowed: 'yes',
  },
  {
    id: 'admin',
    keyword: 'ADMIN',
    label: 'May pass it on',
    explanation: 'The login can add and remove members of the role.',
    allowed: 'needs-admin',
  },
]

const DEFAULT_OBJECTS: readonly PrivilegeDefaultObject[] = [
  { id: 'tables', keyword: 'TABLES', letter: 'r', level: 'table', label: 'New tables and views' },
  { id: 'sequences', keyword: 'SEQUENCES', letter: 'S', level: 'sequence', label: 'New sequences' },
  {
    id: 'routines',
    keyword: 'FUNCTIONS',
    letter: 'f',
    level: 'routine',
    label: 'New functions and procedures',
  },
  { id: 'types', keyword: 'TYPES', letter: 'T', level: 'type', label: 'New types' },
  { id: 'schemas', keyword: 'SCHEMAS', letter: 'n', level: 'schema', label: 'New schemas' },
]

export const POSTGRES_PRIVILEGE_DATA: EnginePrivilegeData = {
  engine: 'postgres',
  series: POSTGRES_SERIES,
  levels: LEVELS,
  privileges: PRIVILEGES,
  roles: ROLES,
  attributes: ATTRIBUTES,
  membershipOptions: MEMBERSHIP_OPTIONS,
  defaultPrivilegeObjects: DEFAULT_OBJECTS,
  blocked: {
    databases: ['postgres', 'template0', 'template1'],
    schemas: ['information_schema', 'pg_catalog', 'pg_toast'],
    reservedPrefixes: ['pg_', 'tp_'],
  },
}
