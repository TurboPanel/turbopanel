/**
 * Shared fixture for the schema-description generator suites
 * (`schema-snapshot.test.ts`, `schema-comments.test.ts`,
 * `generate-data-dictionary.test.ts`): a throwaway `migrations/` directory
 * with a two-entry journal, a drizzle-shaped snapshot for the newest entry,
 * and migration SQL carrying `COMMENT ON` statements to replay.
 *
 * The snapshot mixes one real table (`server`, described in
 * `schema-descriptions.ts`) with one invented table (`zz_fixture`, described
 * nowhere) so the suites can prove both the described and the undescribed
 * paths without depending on the whole shipped schema.
 */
import { join } from "@std/path";

/** drizzle snapshot column as `meta/NNNN_snapshot.json` spells it. */
function column(
  name: string,
  type: string,
  extra: Partial<{ primaryKey: boolean; notNull: boolean; default: string }> =
    {},
) {
  return { name, type, primaryKey: false, notNull: false, ...extra };
}

export const FIXTURE_SERVER_COLUMNS = [
  column("id", "uuid", {
    primaryKey: true,
    notNull: true,
    default: "uuidv7()",
  }),
  column("created_at", "timestamp(3) with time zone", {
    notNull: true,
    default: "now()",
  }),
  column("organization_id", "uuid"),
  column("assigned_tier_id", "uuid"),
  column("machine_class", "text"),
  column("is_connected", "boolean", { notNull: true, default: "false" }),
] as const;

export function fixtureSnapshot() {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    prevId: "00000000-0000-0000-0000-000000000000",
    version: "7",
    dialect: "postgresql",
    tables: {
      "public.server": {
        name: "server",
        schema: "",
        columns: Object.fromEntries(
          FIXTURE_SERVER_COLUMNS.map((c) => [c.name, c]),
        ),
        indexes: {
          idx_server_connected: {
            name: "idx_server_connected",
            columns: [{ expression: "id", isExpression: false }],
            isUnique: false,
            where: '"server"."is_connected"',
            method: "btree",
          },
        },
        foreignKeys: {
          server_organization_id_organization_id_fk: {
            name: "server_organization_id_organization_id_fk",
            tableFrom: "server",
            tableTo: "organization",
            columnsFrom: ["organization_id"],
            columnsTo: ["id"],
            onDelete: "restrict",
            onUpdate: "no action",
          },
          server_assigned_tier_id_tier_id_fk: {
            name: "server_assigned_tier_id_tier_id_fk",
            tableFrom: "server",
            tableTo: "tier",
            columnsFrom: ["assigned_tier_id"],
            columnsTo: ["id"],
            onDelete: "set null",
            onUpdate: "no action",
          },
        },
        compositePrimaryKeys: {},
        uniqueConstraints: {},
        checkConstraints: {
          server_machine_class_check: {
            name: "server_machine_class_check",
            value: `"server"."machine_class" IN ('physical', 'virtual')`,
          },
        },
      },
      "public.zz_fixture": {
        name: "zz_fixture",
        schema: "",
        columns: {
          command_id: column("command_id", "uuid", { notNull: true }),
          seq: column("seq", "integer", { notNull: true }),
          note: column("note", "text"),
        },
        indexes: {},
        foreignKeys: {
          zz_fixture_command_id_fk: {
            name: "zz_fixture_command_id_fk",
            tableFrom: "zz_fixture",
            tableTo: "command",
            columnsFrom: ["command_id"],
            columnsTo: ["id"],
            // no onDelete on purpose: the reader must default it
            onUpdate: "no action",
          },
          // a composite foreign key is ignored by the per-column reader
          zz_fixture_pair_fk: {
            name: "zz_fixture_pair_fk",
            tableFrom: "zz_fixture",
            tableTo: "slot",
            columnsFrom: ["command_id", "seq"],
            columnsTo: ["a", "b"],
            onDelete: "cascade",
          },
        },
        compositePrimaryKeys: {
          zz_fixture_pk: {
            name: "zz_fixture_pk",
            columns: ["command_id", "seq"],
          },
        },
        uniqueConstraints: {
          uniq_zz_fixture_note: {
            name: "uniq_zz_fixture_note",
            nullsNotDistinct: false,
            columns: ["note"],
          },
        },
        checkConstraints: {},
      },
    },
    enums: {},
    schemas: {},
    sequences: {},
    roles: {},
    policies: {},
    views: {},
    _meta: { columns: {}, schemas: {}, tables: {} },
  };
}

/**
 * Two migrations: `0000_init` comments a column with an apostrophe and one
 * that `0001_amend` later rewrites, clears, and adds to, so "last statement
 * wins" and `IS NULL` both get exercised.
 */
export const FIXTURE_SQL_0000 = [
  `CREATE TABLE "server" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL);`,
  `--> statement-breakpoint`,
  `COMMENT ON COLUMN "server"."machine_class" IS 'first wording';`,
  `--> statement-breakpoint`,
  `COMMENT ON COLUMN "server"."is_connected" IS 'the daemon''s liveness flag';`,
  `--> statement-breakpoint`,
  `COMMENT ON TABLE "server" IS 'to be cleared';`,
  "",
].join("\n");

export const FIXTURE_SQL_0001 = [
  `comment on column "public"."server"."machine_class" is 'second wording';`,
  `--> statement-breakpoint`,
  `COMMENT ON TABLE "server" IS NULL;`,
  "",
].join("\n");

/** Writes the fixture migrations directory and returns its path. */
export async function writeFixtureMigrations(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-schema-fixture-" });
  await Deno.mkdir(join(dir, "meta"));
  await Deno.writeTextFile(
    join(dir, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1000,
          tag: "0000_init",
          breakpoints: true,
        },
        {
          idx: 1,
          version: "7",
          when: 2000,
          tag: "0001_amend",
          breakpoints: true,
        },
      ],
    }),
  );
  await Deno.writeTextFile(
    join(dir, "meta/0000_snapshot.json"),
    JSON.stringify({ ...fixtureSnapshot(), id: "stale", tables: {} }),
  );
  await Deno.writeTextFile(
    join(dir, "meta/0001_snapshot.json"),
    JSON.stringify(fixtureSnapshot()),
  );
  await Deno.writeTextFile(join(dir, "0000_init.sql"), FIXTURE_SQL_0000);
  await Deno.writeTextFile(join(dir, "0001_amend.sql"), FIXTURE_SQL_0001);
  return dir;
}
