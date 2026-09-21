/**
 * `turbopanel-instance migrate` — apply the shipped migrations without a
 * source checkout (instance-runtime-packaging, Road to 0.1.x).
 *
 * The same two gates `pnpm migrate` runs from a checkout, in one process:
 *
 *   1. scripts/check-postgres-compat.mjs — refuse a server without
 *      `uuidv7()` (PostgreSQL 18+), since the schema defaults primary keys to
 *      it and the first migration would fail half-way with a worse message.
 *   2. src/db/schema-state.ts — refuse a database migrated by files this
 *      build does not ship (a newer release, or the pre-freeze baseline):
 *      drizzle would apply our files on top of that history and fail
 *      mid-DDL. Read under the lock below.
 *   3. scripts/migrate-locked.mjs — a blocking `pg_advisory_lock` taken on
 *      the *same connection* the programmatic drizzle migrator runs on, so a
 *      second concurrent caller waits its turn instead of racing mid-DDL.
 *      The lock key and the bookkeeping table (`public.migration`, the one
 *      drizzle-kit and this repo's baseline use — not drizzle's default
 *      `drizzle.__drizzle_migrations`) are the same constants as that script;
 *      migrate.test.ts pins the four against it (and schema-state.test.ts
 *      pins the state messages against scripts/schema-state.mjs).
 *
 * The migration files come from `migrations/` next to `src/` in a checkout,
 * and from the copy `deno task compile` embeds (`--include migrations`) in
 * the compiled binary — `import.meta.url`-relative either way, never the
 * working directory, and readable by the embedded-file VFS regardless of the
 * binary's `--allow-read` pins.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolvePostgresConnection } from "../db/url.ts";
import {
  compareSchemaState,
  describeSchemaState,
  MIGRATIONS_FOLDER,
  readShippedMigrationHashes,
} from "../db/schema-state.ts";

export { MIGRATIONS_FOLDER };

/** Stable two-int4 advisory-lock key ('TBPC', 'MIGR') — scripts/migrate-locked.mjs. */
export const MIGRATION_LOCK_KEY_1 = 0x54425043;
export const MIGRATION_LOCK_KEY_2 = 0x4d494752;
/** drizzle.config.mjs's bookkeeping table — scripts/migrate-locked.mjs. */
export const MIGRATIONS_TABLE = "migration";
export const MIGRATIONS_SCHEMA = "public";
/** scripts/check-postgres-compat.mjs. */
export const MINIMUM_POSTGRES_MAJOR = 18;

export type MigrateIo = {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

export class MigrateError extends Error {}

type SqlClient = ReturnType<typeof postgres>;

function openClient(url: string, connectTimeoutSeconds: number): SqlClient {
  const options = {
    max: 1,
    prepare: false,
    connect_timeout: connectTimeoutSeconds,
    onnotice: () => {},
  };
  const connection = resolvePostgresConnection(url);
  return typeof connection === "string"
    ? postgres(connection, options)
    : postgres({ ...connection, ...options });
}

/** Gate 1 — the same refusal as scripts/check-postgres-compat.mjs. */
export async function assertPostgresCompatible(
  sql: SqlClient,
  warn: (line: string) => void,
): Promise<void> {
  let serverVersion: { version: string; version_num: number };
  try {
    const [row] = await sql<{ version: string; version_num: number }[]>`
      select current_setting('server_version') as version,
             current_setting('server_version_num')::int as version_num`;
    serverVersion = row;
  } catch (error) {
    throw new MigrateError(
      `cannot reach the target PostgreSQL server (${
        error instanceof Error ? error.message : String(error)
      }) — check TURBOPANEL_DATABASE_URL before running migrations`,
    );
  }
  let uuidv7Available = true;
  try {
    await sql`select uuidv7()`;
  } catch {
    uuidv7Available = false;
  }
  if (!uuidv7Available) {
    throw new MigrateError(
      `the connected server is PostgreSQL ${serverVersion.version} and has no uuidv7() — ` +
        `turbopanel migrations require PostgreSQL ${MINIMUM_POSTGRES_MAJOR} or newer ` +
        "(the schema defaults primary keys to the built-in uuidv7()). " +
        "Upgrade the server; the orchestration pin is postgres:18 " +
        "(turbopaneld/orchestration/roles/postgres/defaults/main.yml).",
    );
  }
  if (serverVersion.version_num < MINIMUM_POSTGRES_MAJOR * 10000) {
    warn(
      `warning — PostgreSQL ${serverVersion.version} is below the documented minimum ` +
        `${MINIMUM_POSTGRES_MAJOR}, but uuidv7() is available; proceeding`,
    );
  } else {
    warn(`PostgreSQL ${serverVersion.version} with uuidv7() — ok`);
  }
}

/**
 * Gate 2: refuse a database whose history this build does not ship
 * (src/db/schema-state.ts — `ahead` / `diverged`). drizzle keys replay
 * on the journal `when`, so it would otherwise apply our files on top of a
 * foreign history and fail mid-DDL. Read under the lock so a concurrent
 * migrate cannot change the answer between the check and the apply.
 */
export async function assertSchemaMigratable(
  sql: SqlClient,
  log: (line: string) => void,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const [present] = await sql<
    { present: boolean }[]
  >`select to_regclass('public.migration') is not null as present`;
  const applied = present?.present
    ? (await sql<{ hash: string }[]>`select hash from public.migration order by created_at, id`)
      .map((row) => row.hash)
    : [];
  const state = compareSchemaState(applied, await readShippedMigrationHashes(migrationsFolder));
  if (state.status === "ahead" || state.status === "diverged") {
    throw new MigrateError(describeSchemaState(state));
  }
  log(describeSchemaState(state));
}

/** Gate 3 + the migrator — the same shape as scripts/migrate-locked.mjs. */
export async function runLockedMigration(
  sql: SqlClient,
  log: (line: string) => void,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const db = drizzle(sql);
  log("waiting for the migration advisory lock…");
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY_1}, ${MIGRATION_LOCK_KEY_2})`;
  try {
    await assertSchemaMigratable(sql, log, migrationsFolder);
    log("lock acquired, applying migrations…");
    await migrate(db, {
      migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
      migrationsSchema: MIGRATIONS_SCHEMA,
    });
    log("migrations applied successfully");
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY_1}, ${MIGRATION_LOCK_KEY_2})`;
  }
}

/** Entry for the `migrate` subcommand. Returns the process exit code. */
export async function runMigrateCommand(io: MigrateIo = {}): Promise<number> {
  const env = io.env ?? Deno.env.toObject();
  const log = io.log ?? ((line: string) => console.log(`migrate: ${line}`));
  const error = io.error ??
    ((line: string) => console.error(`migrate: ${line}`));

  const url = env.TURBOPANEL_DATABASE_URL?.trim();
  if (!url) {
    error("TURBOPANEL_DATABASE_URL is required");
    return 1;
  }
  let sql: SqlClient;
  try {
    sql = openClient(url, 15);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  try {
    await assertPostgresCompatible(sql, log);
    await runLockedMigration(sql, log);
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
