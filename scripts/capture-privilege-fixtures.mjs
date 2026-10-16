#!/usr/bin/env node
/**
 * Capture engine ground truth for the managed-database privilege catalogue.
 *
 * For one engine series this starts ONE throwaway container (`docker run --rm -d`,
 * no published ports, no network), waits until it is ready, runs read-only
 * catalogue probes plus scratch GRANT/REVOKE probes through `docker exec`, writes
 * a normalised JSON fixture and always removes the container (also on error,
 * SIGINT and SIGTERM). Unit tests compare the catalogue with these fixtures so CI
 * needs no engines.
 *
 * Secrets: the random container password is generated per run, handed to the
 * container through `--env-file /dev/stdin` (never argv, never a file), used
 * inside the container only, and never written to any fixture or log. Fixtures
 * hold only `serverVersion`, `image` and engine facts.
 *
 * Usage:
 *   node scripts/capture-privilege-fixtures.mjs --engine postgres --series 17
 *   node scripts/capture-privilege-fixtures.mjs --all
 *   node scripts/capture-privilege-fixtures.mjs --all \
 *     --ssh linuxuser@host --ssh-opt -i --ssh-opt ~/.ssh/key \
 *     --ssh-opt -o --ssh-opt IdentitiesOnly=yes --ssh-opt -o --ssh-opt BatchMode=yes \
 *     --lock-file /tmp/tp-cat-engine.lock --cleanup-images
 *
 * Options:
 *   --engine postgres|mysql|mariadb   engine to capture (needs --series)
 *   --series <n>                      series, e.g. 17, 8.4, 11.8 (any tag of the official image)
 *   --all                             capture every series in SERIES below, one after another
 *   --out <dir>                       fixture directory (default src/features/managed/privileges/fixtures)
 *   --ssh <user@host>                 run docker over ssh instead of locally
 *   --ssh-opt <arg>                   one extra ssh argument; repeat per argument
 *   --docker-cmd <cmd>                docker command (default "docker", "sudo -n docker" with --ssh)
 *   --lock-file <path>                hold flock on this file (on the docker host) during each capture
 *   --cleanup-images                  remove the image afterwards if this run pulled it
 *   --memory <size>                   container memory limit (default 1g)
 *   --help
 *
 * Re-capturing for a new engine version: add { engine, series, image } to SERIES
 * (image is the official Debian-based image ref used by managed/releases.ts), or
 * pass --engine/--series directly, then run the script. Commit the changed JSON.
 * Running twice yields byte-identical files.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERIES = [
  { engine: 'postgres', series: '15', image: 'docker.io/library/postgres:15' },
  { engine: 'postgres', series: '16', image: 'docker.io/library/postgres:16' },
  { engine: 'postgres', series: '17', image: 'docker.io/library/postgres:17' },
  { engine: 'postgres', series: '18', image: 'docker.io/library/postgres:18' },
  { engine: 'mysql', series: '8.4', image: 'docker.io/library/mysql:8.4' },
  { engine: 'mysql', series: '9.7', image: 'docker.io/library/mysql:9.7' },
  { engine: 'mariadb', series: '11.8', image: 'docker.io/library/mariadb:11.8' },
  { engine: 'mariadb', series: '12.3', image: 'docker.io/library/mariadb:12.3' },
]

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(here, '..', 'src/features/managed/privileges/fixtures')

// MySQL / MariaDB candidate privilege keywords for the GRANT acceptance probe.
const STATIC_KEYWORDS = [
  'ALL',
  'ALTER',
  'ALTER ROUTINE',
  'CREATE',
  'CREATE ROUTINE',
  'CREATE TABLESPACE',
  'CREATE TEMPORARY TABLES',
  'CREATE USER',
  'CREATE VIEW',
  'DELETE',
  'DELETE HISTORY',
  'DROP',
  'EVENT',
  'EXECUTE',
  'FILE',
  'GRANT OPTION',
  'INDEX',
  'INSERT',
  'LOCK TABLES',
  'PROCESS',
  'PROXY',
  'REFERENCES',
  'RELOAD',
  'REPLICATION CLIENT',
  'REPLICATION SLAVE',
  'REPLICATION MASTER ADMIN',
  'REPLICATION SLAVE ADMIN',
  'REPLICA MONITOR',
  'SELECT',
  'SET USER',
  'SHOW DATABASES',
  'SHOW VIEW',
  'SHUTDOWN',
  'SUPER',
  'TRIGGER',
  'UPDATE',
  'USAGE',
  'BINLOG ADMIN',
  'BINLOG MONITOR',
  'BINLOG REPLAY',
  'CONNECTION ADMIN',
  'FEDERATED ADMIN',
  'READ_ONLY ADMIN',
  'SHOW CREATE ROUTINE',
  'SLAVE MONITOR',
]
const DYNAMIC_KEYWORDS = [
  'APPLICATION_PASSWORD_ADMIN',
  'AUDIT_ABORT_EXEMPT',
  'AUDIT_ADMIN',
  'AUTHENTICATION_POLICY_ADMIN',
  'BACKUP_ADMIN',
  'BINLOG_ADMIN',
  'BINLOG_ENCRYPTION_ADMIN',
  'CLONE_ADMIN',
  'CONNECTION_ADMIN',
  'ENCRYPTION_KEY_ADMIN',
  'FIREWALL_EXEMPT',
  'FLUSH_OPTIMIZER_COSTS',
  'FLUSH_PRIVILEGES',
  'FLUSH_STATUS',
  'FLUSH_TABLES',
  'FLUSH_USER_RESOURCES',
  'GROUP_REPLICATION_ADMIN',
  'GROUP_REPLICATION_STREAM',
  'INNODB_REDO_LOG_ARCHIVE',
  'INNODB_REDO_LOG_ENABLE',
  'PASSWORDLESS_USER_ADMIN',
  'PERSIST_RO_VARIABLES_ADMIN',
  'REPLICATION_APPLIER',
  'REPLICATION_SLAVE_ADMIN',
  'RESOURCE_GROUP_ADMIN',
  'RESOURCE_GROUP_USER',
  'ROLE_ADMIN',
  'SENSITIVE_VARIABLES_OBSERVER',
  'SERVICE_CONNECTION_ADMIN',
  'SESSION_VARIABLES_ADMIN',
  'SET_ANY_DEFINER',
  'SET_USER_ID',
  'SHOW_ROUTINE',
  'SYSTEM_USER',
  'SYSTEM_VARIABLES_ADMIN',
  'TABLE_ENCRYPTION_ADMIN',
  'TELEMETRY_LOG_ADMIN',
  'TRANSACTION_GTID_TAG',
  'XA_RECOVER_ADMIN',
  'ALLOW_NONEXISTENT_DEFINER',
  'OPTIMIZE_LOCAL_TABLE',
]
const KEYWORDS = [...new Set([...STATIC_KEYWORDS, ...DYNAMIC_KEYWORDS])].sort()

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

function collect(cmd, args, input) {
  return new Promise((resolveP) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', (e) => resolveP({ code: 127, stdout, stderr: stderr + String(e) }))
    p.on('close', (code) => resolveP({ code: code ?? 1, stdout, stderr }))
    p.stdin.on('error', () => {})
    p.stdin.end(input ?? '')
  })
}

/** Stable JSON: object keys sorted recursively, arrays kept as given, 2-space, trailing newline. */
export function stableStringify(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, norm(v[k])])
      )
    }
    return v
  }
  return `${JSON.stringify(norm(value), null, 2)}\n`
}

function makeTarget(opts) {
  const dockerCmd = opts.dockerCmd ?? (opts.ssh ? 'sudo -n docker' : 'docker')
  const pre = dockerCmd.split(/\s+/)
  const t = {
    docker(args, input) {
      if (!opts.ssh) return collect(pre[0], [...pre.slice(1), ...args], input)
      const remote = `${dockerCmd} ${args.map(shq).join(' ')}`
      return collect('ssh', [...opts.sshOpts, opts.ssh, remote], input)
    },
    spawnShell(shellCmd) {
      return opts.ssh
        ? spawn('ssh', [...opts.sshOpts, opts.ssh, shellCmd], {
            stdio: ['pipe', 'pipe', 'inherit'],
          })
        : spawn('sh', ['-c', shellCmd], { stdio: ['pipe', 'pipe', 'inherit'] })
    },
  }
  return t
}

/** Hold flock on the docker host until release() is called. */
async function acquireLock(target, file) {
  const p = target.spawnShell(`flock ${shq(file)} sh -c 'echo LOCKED; cat >/dev/null'`)
  p.stdin.on('error', () => {})
  await new Promise((res, rej) => {
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      if (buf.includes('LOCKED')) res()
    })
    p.on('close', () => rej(new Error('could not acquire lock')))
  })
  return () =>
    new Promise((res) => {
      p.on('close', () => res())
      p.stdin.end()
    })
}

// ---------------------------------------------------------------- container

const live = new Set()
let currentTarget = null

async function removeContainer(target, name) {
  await target.docker(['rm', '-f', name])
  live.delete(name)
}

async function cleanupAll() {
  if (!currentTarget) return
  for (const n of [...live]) await removeContainer(currentTarget, n)
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanupAll().finally(() => process.exit(130))
  })
}

function scrub(text, secret) {
  return secret ? String(text).split(secret).join('***') : String(text)
}

// ---------------------------------------------------------------- SQL clients

function pgClient(target, name) {
  return async function psql(sql, db = 'postgres') {
    const r = await target.docker(
      [
        'exec',
        '-i',
        name,
        'psql',
        '-X',
        '-q',
        '-U',
        'postgres',
        '-d',
        db,
        '-At',
        '-F',
        '\t',
        '-f',
        '-',
      ],
      sql
    )
    const rows = r.stdout
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\t'))
    return { rows, stderr: r.stderr, code: r.code }
  }
}

function myClient(target, name, passVar) {
  const script = `c=$(command -v mariadb || command -v mysql); MYSQL_PWD="$${passVar}" exec "$c" -uroot -N -B -f`
  return async function mysql(sql) {
    const r = await target.docker(['exec', '-i', name, 'sh', '-c', script], sql)
    const rows = r.stdout
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\t'))
    const errors = []
    for (const l of r.stderr.split('\n')) {
      const m = /^ERROR (\d+) \(\w+\)(?: at line (\d+))?:/.exec(l)
      if (m) errors.push({ code: Number(m[1]), line: m[2] ? Number(m[2]) : null })
    }
    return { rows, errors, stderr: r.stderr, code: r.code }
  }
}

// ---------------------------------------------------------------- postgres

const PG_KINDS = ['c', 'r', 's', 'd', 'n', 'f', 'T', 'l', 'F', 'S', 'L', 't', 'p']

const PG_ACL_CASES = [
  {
    k: 'r',
    pre: 'CREATE TABLE tp_t(c int)',
    grant: 'GRANT ALL ON TABLE tp_t TO tp_role',
    read: "SELECT relacl::text FROM pg_class WHERE oid = 'tp_t'::regclass",
  },
  {
    k: 's',
    pre: 'CREATE SEQUENCE tp_seq',
    grant: 'GRANT ALL ON SEQUENCE tp_seq TO tp_role',
    read: "SELECT relacl::text FROM pg_class WHERE oid = 'tp_seq'::regclass",
  },
  {
    k: 'd',
    grant: 'GRANT ALL ON DATABASE tp_scratch_db TO tp_role',
    read: "SELECT datacl::text FROM pg_database WHERE datname = 'tp_scratch_db'",
  },
  {
    k: 'n',
    pre: 'CREATE SCHEMA tp_sch',
    grant: 'GRANT ALL ON SCHEMA tp_sch TO tp_role',
    read: "SELECT nspacl::text FROM pg_namespace WHERE nspname = 'tp_sch'",
  },
  {
    k: 'f',
    pre: "CREATE FUNCTION tp_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'",
    grant: 'GRANT ALL ON FUNCTION tp_fn() TO tp_role',
    read: "SELECT proacl::text FROM pg_proc WHERE oid = 'tp_fn()'::regprocedure",
  },
  {
    k: 'T',
    pre: 'CREATE DOMAIN tp_dom AS int',
    grant: 'GRANT ALL ON DOMAIN tp_dom TO tp_role',
    read: "SELECT typacl::text FROM pg_type WHERE oid = 'tp_dom'::regtype",
  },
  {
    k: 'l',
    grant: 'GRANT ALL ON LANGUAGE plpgsql TO tp_role',
    read: "SELECT lanacl::text FROM pg_language WHERE lanname = 'plpgsql'",
  },
  {
    k: 'F',
    pre: 'CREATE FOREIGN DATA WRAPPER tp_fdw',
    grant: 'GRANT ALL ON FOREIGN DATA WRAPPER tp_fdw TO tp_role',
    read: "SELECT fdwacl::text FROM pg_foreign_data_wrapper WHERE fdwname = 'tp_fdw'",
  },
  {
    k: 'S',
    pre: 'CREATE SERVER tp_srv FOREIGN DATA WRAPPER tp_fdw',
    grant: 'GRANT ALL ON FOREIGN SERVER tp_srv TO tp_role',
    read: "SELECT srvacl::text FROM pg_foreign_server WHERE srvname = 'tp_srv'",
  },
  {
    k: 'L',
    pre: 'SELECT lo_create(424242) IS NOT NULL',
    grant: 'GRANT ALL ON LARGE OBJECT 424242 TO tp_role',
    read: 'SELECT lomacl::text FROM pg_largeobject_metadata WHERE oid = 424242',
  },
  {
    k: 't',
    grant: 'GRANT ALL ON TABLESPACE pg_default TO tp_role',
    read: "SELECT spcacl::text FROM pg_tablespace WHERE spcname = 'pg_default'",
  },
  {
    k: 'p',
    grant: 'GRANT ALL ON PARAMETER work_mem TO tp_role',
    read: "SELECT paracl::text FROM pg_parameter_acl WHERE parname = 'work_mem'",
  },
]

const PG_COLUMN_KEYWORDS = [
  'ALL',
  'ALTER SYSTEM',
  'CONNECT',
  'CREATE',
  'DELETE',
  'EXECUTE',
  'INSERT',
  'MAINTAIN',
  'REFERENCES',
  'SELECT',
  'SET',
  'TEMPORARY',
  'TRIGGER',
  'TRUNCATE',
  'UPDATE',
  'USAGE',
]

const PG_DEFAULT_ACL_TARGETS = [
  'DATABASES',
  'FUNCTIONS',
  'LARGE OBJECTS',
  'PARAMETERS',
  'ROUTINES',
  'SCHEMAS',
  'SEQUENCES',
  'TABLES',
  'TYPES',
]

const tf = (v) => v === 't'
const aclLetters = (text) => {
  const m = /(?:^|[{,"])tp_role=([A-Za-z*]*)\//.exec(text ?? '')
  return m ? m[1] : null
}

async function capturePostgres(target, name) {
  const psql = pgClient(target, name)
  const out = {}
  const ver = await psql('SHOW server_version; SHOW server_version_num;')
  out.serverVersion = /^[\d.]+/.exec(ver.rows[0][0])[0]
  out.serverVersionNum = Number(ver.rows[1][0])

  await psql('CREATE DATABASE tp_scratch_db')
  const db = 'tp_scratch_db'
  await psql(
    `CREATE ROLE tp_role NOLOGIN; CREATE ROLE tp_r1 NOLOGIN; CREATE ROLE tp_r2 NOLOGIN;
CREATE FUNCTION tp_try(s text) RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN EXECUTE s; RETURN true; EXCEPTION WHEN OTHERS THEN RETURN false; END $f$;`,
    db
  )

  // acldefault privilege types per object kind
  const sel = PG_KINDS.map(
    (k) =>
      `SELECT '${k}', coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '') FROM aclexplode(acldefault('${k}', 10));`
  ).join('\n')
  const acl = await psql(sel, db)
  out.aclPrivilegeTypes = {}
  for (const k of PG_KINDS) {
    const row = acl.rows.find((r) => r[0] === k)
    if (row) out.aclPrivilegeTypes[k] = row[1] === '' ? [] : row[1].split(',').sort()
  }

  // real GRANT ALL, record the ACL letters
  out.aclLetters = {}
  for (const c of PG_ACL_CASES) {
    const script = [c.pre, c.grant, c.read]
      .filter(Boolean)
      .map((s) => `${s};`)
      .join('\n')
    const r = await psql(script, db)
    const last = r.rows.length ? r.rows[r.rows.length - 1][0] : null
    out.aclLetters[c.k] = c.k === 'c' ? null : aclLetters(last)
  }

  // column level
  await psql('CREATE TABLE IF NOT EXISTS tp_ct(c int)', db)
  const colSql = PG_COLUMN_KEYWORDS.map(
    (kw) => `SELECT '${kw}', tp_try('GRANT ${kw} (c) ON tp_ct TO tp_r1');`
  ).join('\n')
  const col = await psql(colSql, db)
  const accepted = {}
  for (const [kw, v] of col.rows) accepted[kw] = tf(v)
  const colAcl = await psql(
    "GRANT SELECT (c), INSERT (c), UPDATE (c), REFERENCES (c) ON tp_ct TO tp_role;\nSELECT attacl::text FROM pg_attribute WHERE attrelid = 'tp_ct'::regclass AND attname = 'c';",
    db
  )
  out.columnGrants = {
    accepted,
    letters: aclLetters(colAcl.rows.length ? colAcl.rows[colAcl.rows.length - 1][0] : null),
    refused: Object.keys(accepted)
      .filter((k) => !accepted[k])
      .sort(),
  }
  out.aclPrivilegeTypes.c = null

  // default privileges
  const adp = PG_DEFAULT_ACL_TARGETS.map(
    (t) => `SELECT '${t}', tp_try('ALTER DEFAULT PRIVILEGES GRANT ALL ON ${t} TO tp_role');`
  ).join('\n')
  const adpRes = await psql(adp, db)
  const adpLetters = await psql('SELECT DISTINCT defaclobjtype FROM pg_default_acl ORDER BY 1', db)
  out.defaultAclAccepted = Object.fromEntries(adpRes.rows.map(([t, v]) => [t, tf(v)]))
  out.defaultAclObjTypes = adpLetters.rows.map((r) => r[0]).sort()

  // catalogue shape
  const roles = await psql(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'pg\\_%' ORDER BY 1",
    db
  )
  out.predefinedRoles = roles.rows.map((r) => r[0]).sort()
  const am = await psql(
    "SELECT attname FROM pg_attribute WHERE attrelid = 'pg_auth_members'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY 1",
    db
  )
  out.authMembersColumns = am.rows.map((r) => r[0]).sort()
  const ra = await psql(
    "SELECT attname FROM pg_attribute WHERE attrelid = 'pg_roles'::regclass AND attnum > 0 AND NOT attisdropped AND atttypid IN ('bool'::regtype, 'int4'::regtype) ORDER BY 1",
    db
  )
  out.roleAttributeColumns = ra.rows.map((r) => r[0]).sort()

  // feature probes
  const feat = await psql(
    `SELECT 'pg_get_acl', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'pg_get_acl');
SELECT 'has_parameter_privilege', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_parameter_privilege');
SELECT 'maintain', tp_try('GRANT MAINTAIN ON TABLE tp_t TO tp_r1');
SELECT 'membership', tp_try('GRANT tp_r1 TO tp_r2 WITH INHERIT FALSE, SET TRUE');
SELECT 'parameter', tp_try('GRANT SET ON PARAMETER work_mem TO tp_r1');`,
    db
  )
  const f = Object.fromEntries(feat.rows.map(([k, v]) => [k, tf(v)]))
  out.functions = { has_parameter_privilege: f.has_parameter_privilege, pg_get_acl: f.pg_get_acl }
  out.maintainGrantable = f.maintain
  out.membershipOptions = f.membership
  out.grantableOnParameter = f.parameter
  return out
}

// ---------------------------------------------------------------- mysql / mariadb

const splitTop = (s) => {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

/** Parse SHOW GRANTS output into privilege names only (never keeps raw statements or hashes). */
export function parseGrants(lines) {
  const statements = []
  const roles = []
  for (const line of lines) {
    const m = /^GRANT (.+?) ON (.+?) TO /s.exec(line)
    if (m) {
      statements.push({ on: m[2].replace(/`/g, ''), privileges: splitTop(m[1]) })
      continue
    }
    const r = /^GRANT (.+?) TO /s.exec(line)
    if (r) roles.push(...splitTop(r[1]).map((x) => x.replace(/`/g, '')))
  }
  return { statements, roles }
}

const isDynamic = (p) => /^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(p) && p !== 'READ_ONLY ADMIN'
const setMembers = (columnType) =>
  [...columnType.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))

async function captureMysqlFamily(target, name, engine, passVar) {
  const my = myClient(target, name, passVar)
  const out = {}
  const isMaria = engine === 'mariadb'
  const sql = async (s) => (await my(s)).rows

  out.serverVersion = /^\d+\.\d+\.\d+/.exec((await sql('SELECT VERSION()'))[0][0])[0]

  out.showPrivileges = (await sql('SHOW PRIVILEGES'))
    .map(([Privilege, Context, Comment]) => ({ Comment, Context, Privilege }))
    .sort((a, b) => a.Privilege.localeCompare(b.Privilege) || a.Context.localeCompare(b.Context))

  const rg = parseGrants((await sql('SHOW GRANTS FOR root@localhost')).map((r) => r[0]))
  const global = rg.statements.filter((s) => s.on === '*.*').flatMap((s) => s.privileges)
  out.rootGrants = {
    dynamic: [...new Set(global.filter(isDynamic))].sort(),
    otherLevels: rg.statements
      .filter((s) => s.on !== '*.*')
      .map((s) => ({ on: s.on, privileges: [...s.privileges].sort() }))
      .sort((a, b) => a.on.localeCompare(b.on)),
    roles: [...new Set(rg.roles)].sort(),
    static: [...new Set(global.filter((p) => !isDynamic(p)))].sort(),
  }

  out.globalGrantsDistinct = isMaria
    ? null
    : (await sql('SELECT DISTINCT PRIV FROM mysql.global_grants ORDER BY 1'))
        .map((r) => r[0])
        .sort()

  const tables = [
    'user',
    'db',
    'tables_priv',
    'columns_priv',
    'procs_priv',
    'global_grants',
    'proxies_priv',
    'global_priv',
    'role_edges',
    'default_roles',
    'roles_mapping',
  ]
  const cols = await sql(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME IN (${tables.map((t) => `'${t}'`).join(',')}) ORDER BY 1, 2`
  )
  out.grantTableColumns = {}
  for (const [t, c] of cols) (out.grantTableColumns[t] ??= []).push(c)
  for (const t of Object.keys(out.grantTableColumns)) out.grantTableColumns[t].sort()

  if (isMaria) {
    const keys = await sql(
      "SELECT JSON_KEYS(Priv) FROM mysql.global_priv WHERE User = 'root' AND Host = 'localhost'"
    )
    out.globalPrivRootKeys = keys.length ? JSON.parse(keys[0][0]).sort() : []
    const acc = await sql(
      "SELECT JSON_VALUE(Priv, '$.access') FROM mysql.global_priv WHERE User = 'root' AND Host = 'localhost'"
    )
    out.globalPrivRootAccess = acc.length ? acc[0][0] : null
  }

  const en = await sql(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'mysql' AND
 (TABLE_NAME, COLUMN_NAME) IN (('tables_priv','Table_priv'), ('columns_priv','Column_priv'), ('procs_priv','Proc_priv')) ORDER BY 1`
  )
  out.enumValues = {}
  for (const [t, c, type] of en) out.enumValues[`${t}.${c}`] = setMembers(type).sort()

  // scratch account + objects
  const setup = await my(
    `DROP USER IF EXISTS 'tp_scratch'@'localhost';
CREATE USER 'tp_scratch'@'localhost';
DROP DATABASE IF EXISTS tp_db;
CREATE DATABASE tp_db;
CREATE TABLE tp_db.tp_t (c INT);
CREATE PROCEDURE tp_db.tp_p() SELECT 1;`
  )
  if (setup.errors.length) throw new Error(`scratch setup failed: ${JSON.stringify(setup.errors)}`)

  const U = "'tp_scratch'@'localhost'"
  const levels = {
    column: (kw) => `GRANT ${kw} (c) ON tp_db.tp_t TO ${U}`,
    global: (kw) => `GRANT ${kw} ON *.* TO ${U}`,
    procedure: (kw) => `GRANT ${kw} ON PROCEDURE tp_db.tp_p TO ${U}`,
    schema: (kw) => `GRANT ${kw} ON tp_db.* TO ${U}`,
    table: (kw) => `GRANT ${kw} ON tp_db.tp_t TO ${U}`,
  }
  const stmts = []
  for (const kw of KEYWORDS)
    for (const [lvl, mk] of Object.entries(levels)) stmts.push({ kw, lvl, sql: mk(kw) })
  const probe = await my(stmts.map((s) => `${s.sql};`).join('\n'))
  const failed = new Set(probe.errors.map((e) => e.line))
  if (probe.errors.some((e) => e.line == null)) throw new Error('probe error without line number')
  out.grantStatementProbe = {}
  stmts.forEach((s, i) => {
    ;(out.grantStatementProbe[s.kw] ??= {})[s.lvl] = !failed.has(i + 1)
  })

  // information_schema views
  const grantee = "'''root''@''localhost'''"
  out.informationSchemaPrivilegeTypes = {
    schemaPrivilegesRoot: (
      await sql(
        `SELECT DISTINCT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${grantee} ORDER BY 1`
      )
    )
      .map((r) => r[0])
      .sort(),
    userPrivilegesRoot: (
      await sql(
        `SELECT DISTINCT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${grantee} ORDER BY 1`
      )
    )
      .map((r) => r[0])
      .sort(),
  }

  // what ALL expands to at each level (only privilege names are kept)
  out.allGrants = {}
  const allLevels = {
    global: '*.*',
    procedure: 'PROCEDURE tp_db.tp_p',
    schema: 'tp_db.*',
    table: 'tp_db.tp_t',
  }
  for (const [lvl, on] of Object.entries(allLevels)) {
    const r = await my(
      `DROP USER IF EXISTS ${U};\nCREATE USER ${U};\nGRANT ALL ON ${on} TO ${U};\nSHOW GRANTS FOR ${U};`
    )
    const g = parseGrants(r.rows.map((x) => x[0]))
    const want =
      lvl === 'global'
        ? '*.*'
        : lvl === 'schema'
          ? 'tp_db.*'
          : lvl === 'table'
            ? 'tp_db.tp_t'
            : 'PROCEDURE tp_db.tp_p'
    const privs = g.statements.filter((s) => s.on === want).flatMap((s) => s.privileges)
    out.allGrants[lvl] = [...new Set(privs)].sort()
  }
  await my(`DROP USER IF EXISTS ${U}; DROP DATABASE IF EXISTS tp_db;`)
  return out
}

// ---------------------------------------------------------------- orchestration

async function waitReady(target, name, engine, passVar, secret) {
  const deadline = Date.now() + 180_000
  let okCount = 0
  while (Date.now() < deadline) {
    let r
    if (engine === 'postgres') {
      r = await target.docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'])
    } else {
      const script = `c=$(command -v mariadb-admin || command -v mysqladmin); MYSQL_PWD="$${passVar}" exec "$c" -h127.0.0.1 -uroot ping`
      r = await target.docker(['exec', name, 'sh', '-c', script])
    }
    okCount = r.code === 0 ? okCount + 1 : 0
    if (okCount >= 2) return
    if (r.stderr.includes('is not running')) {
      const logs = await target.docker(['logs', '--tail', '20', name])
      throw new Error(`container exited: ${scrub(logs.stdout + logs.stderr, secret)}`)
    }
    await sleep(2000)
  }
  throw new Error('timed out waiting for readiness')
}

async function captureOne(target, opts, entry) {
  const { engine, series, image } = entry
  const secret = randomBytes(18).toString('hex')
  const passVar = {
    postgres: 'POSTGRES_PASSWORD',
    mysql: 'MYSQL_ROOT_PASSWORD',
    mariadb: 'MARIADB_ROOT_PASSWORD',
  }[engine]
  const name = `tp-privcap-${randomBytes(4).toString('hex')}`
  currentTarget = target

  const had = (await target.docker(['image', 'inspect', image])).code === 0
  const release = opts.lockFile ? await acquireLock(target, opts.lockFile) : null
  console.error(`[${engine} ${series}] starting ${name} from ${image}${had ? '' : ' (will pull)'}`)
  try {
    live.add(name)
    const run = await target.docker(
      [
        'run',
        '--rm',
        '-d',
        '--name',
        name,
        '--network',
        'none',
        '--memory',
        opts.memory,
        '--env-file',
        '/dev/stdin',
        image,
      ],
      `${passVar}=${secret}\n`
    )
    if (run.code !== 0) throw new Error(`docker run failed: ${scrub(run.stderr, secret)}`)
    await waitReady(target, name, engine, passVar, secret)
    const data =
      engine === 'postgres'
        ? await capturePostgres(target, name)
        : await captureMysqlFamily(target, name, engine, passVar)
    const fixture = { engine, image, series, ...data }
    const text = stableStringify(fixture)
    if (text.includes(secret)) throw new Error('refusing to write: secret leaked into fixture')
    mkdirSync(opts.out, { recursive: true })
    const file = join(opts.out, `${engine}-${series}.json`)
    writeFileSync(file, text)
    console.error(`[${engine} ${series}] serverVersion ${data.serverVersion} -> ${file}`)
  } finally {
    await removeContainer(target, name)
    if (opts.cleanupImages && !had) await target.docker(['image', 'rm', image])
    if (release) await release()
  }
}

function parseArgs(argv) {
  const o = { sshOpts: [], memory: '1g', out: DEFAULT_OUT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--engine') o.engine = next()
    else if (a === '--series') o.series = next()
    else if (a === '--all') o.all = true
    else if (a === '--out') o.out = resolve(next())
    else if (a === '--ssh') o.ssh = next()
    else if (a === '--ssh-opt') o.sshOpts.push(next())
    else if (a === '--docker-cmd') o.dockerCmd = next()
    else if (a === '--lock-file') o.lockFile = next()
    else if (a === '--memory') o.memory = next()
    else if (a === '--cleanup-images') o.cleanupImages = true
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`unknown argument ${a}`)
  }
  return o
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help || (!o.all && !o.engine)) {
    console.log(
      'Usage: capture-privilege-fixtures.mjs (--all | --engine postgres|mysql|mariadb --series N) [--out dir] [--ssh user@host] [--ssh-opt arg]... [--docker-cmd cmd] [--lock-file path] [--cleanup-images] [--memory 1g]\nSee the header of this file for details.'
    )
    return
  }
  const target = makeTarget(o)
  let list
  if (o.all) list = SERIES
  else {
    if (!o.series) throw new Error('--series is required with --engine')
    const known = SERIES.find((s) => s.engine === o.engine && s.series === o.series)
    list = [
      known ?? {
        engine: o.engine,
        series: o.series,
        image: `docker.io/library/${o.engine}:${o.series}`,
      },
    ]
  }
  for (const e of list) await captureOne(target, o, e) // strictly sequential
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (e) => {
    console.error(`error: ${e.message}`)
    await cleanupAll()
    process.exit(1)
  })
}
