/** Pre-migrate backup gate: run, warn or refuse, and never print the database URL. */
import { assertEquals, assertThrows } from "@std/assert";
import {
  planMigrateBackup,
  redactSecrets,
  runMigrateBackup,
} from "./migrate-backup.mjs";

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno);

const DB = new URL("postgresql://db.example:5432/panel");
DB.username = "migrator";
DB.password = "s3cr@t";
const URL_WITH_PASSWORD = DB.href;

test("a set command is run, in any environment", () => {
  for (const CLOUDFLARE_ENV of ["live", "staging", ""]) {
    const plan = planMigrateBackup({
      CLOUDFLARE_ENV,
      TURBOPANEL_MIGRATE_BACKUP_COMMAND: " backup.sh ",
    });
    assertEquals(plan, { action: "run", command: "backup.sh" });
  }
});

test("without a command, testing, staging and local warn and go on", () => {
  for (const CLOUDFLARE_ENV of ["testing", "staging", undefined]) {
    assertEquals(planMigrateBackup({ CLOUDFLARE_ENV }).action, "warn");
  }
});

test("without a command, live is refused unless acknowledged", () => {
  assertEquals(planMigrateBackup({ CLOUDFLARE_ENV: "live" }).action, "refuse");
  assertEquals(
    planMigrateBackup({
      CLOUDFLARE_ENV: "live",
      TURBOPANEL_MIGRATE_BACKUP_ACK: "yes",
    }).action,
    "refuse",
  );
  assertEquals(
    planMigrateBackup({
      CLOUDFLARE_ENV: "live",
      TURBOPANEL_MIGRATE_BACKUP_ACK: "1",
    }).action,
    "warn",
  );
});

test("a refused plan throws and a warning is logged", () => {
  assertThrows(
    () => runMigrateBackup({ CLOUDFLARE_ENV: "live" }, () => {}),
    Error,
    "refusing",
  );
  const lines: string[] = [];
  runMigrateBackup({ CLOUDFLARE_ENV: "staging" }, (l: string) => lines.push(l));
  assertEquals(lines.length, 1);
  assertEquals(lines[0].includes("WARNING"), true);
});

test("a failing backup command stops the migration", () => {
  const env = {
    CLOUDFLARE_ENV: "live",
    TURBOPANEL_MIGRATE_BACKUP_COMMAND: "dump",
    TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD,
  };
  assertThrows(
    () =>
      runMigrateBackup(
        env,
        () => {},
        () => ({ status: 2, stdout: "", stderr: "boom" }),
      ),
    Error,
    "not migrating",
  );
});

test("a good backup passes the environment on and prints no secrets", () => {
  const env = {
    CLOUDFLARE_ENV: "live",
    TURBOPANEL_MIGRATE_BACKUP_COMMAND: "dump",
    TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD,
  };
  const lines: string[] = [];
  let seen: Record<string, string | undefined> = {};
  runMigrateBackup(
    env,
    (l: string) => lines.push(l),
    (_cmd: string, e: Record<string, string | undefined>) => {
      seen = e;
      return {
        status: 0,
        stdout: `connecting ${URL_WITH_PASSWORD} pw s3cr@t`,
        stderr: "",
      };
    },
  );
  assertEquals(seen.TURBOPANEL_DATABASE_URL, URL_WITH_PASSWORD);
  const printed = lines.join("\n");
  assertEquals(printed.includes("s3cr"), false);
  assertEquals(printed.includes("db.example"), false);
});

test("the real runner reads the URL from the environment", () => {
  const lines: string[] = [];
  runMigrateBackup(
    {
      TURBOPANEL_MIGRATE_BACKUP_COMMAND:
        'test -n "$TURBOPANEL_DATABASE_URL" && echo "$TURBOPANEL_DATABASE_URL"',
      TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD,
      PATH: Deno.env.get("PATH") ?? "",
    },
    (l: string) => lines.push(l),
  );
  assertEquals(lines.join("\n").includes("db.example"), false);
  assertEquals(lines.at(-1), "migrate-locked: database backup finished");
});

test("redactSecrets blanks the URL and decoded password", () => {
  assertEquals(
    redactSecrets(`x ${URL_WITH_PASSWORD} y s3cr@t`, URL_WITH_PASSWORD),
    "x [redacted] y [redacted]",
  );
});
