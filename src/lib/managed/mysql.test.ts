import { assertEquals } from "@std/assert";
import { applyResourcesToComposeService } from "../compose/apply-service-options.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";
import { ManagedSecretPlaceholder } from "./index.ts";
import { BINLOG_EXPIRE_LOGS_SECONDS, mysqlEngineSpec } from "./mysql.ts";
import type { MysqlManagedSettings } from "./mysql.ts";
import { MYSQL_ALLOWED_IMAGES } from "./settings.ts";
import { MANAGED_SSL_MODES } from "./ssl.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function defaultSettings(
  overrides: Partial<MysqlManagedSettings> = {},
): MysqlManagedSettings {
  const parsed = mysqlEngineSpec.parseSettings({
    initialDatabase: "defaultdb",
    ...overrides,
  });
  if (!parsed) throw new TypeError("expected mysql settings");
  return parsed as MysqlManagedSettings;
}

test("default image is the approved MySQL 9.7 LTS reference", () => {
  assertEquals(mysqlEngineSpec.defaultImage, "docker.io/library/mysql:9.7");
  assertEquals(
    MYSQL_ALLOWED_IMAGES.includes(mysqlEngineSpec.defaultImage),
    true,
  );
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
  });
  assertEquals(spec.service.image, "docker.io/library/mysql:9.7");
});

test("parseSettings accepts every approved image and rejects everything else", () => {
  for (const image of MYSQL_ALLOWED_IMAGES) {
    const parsed = mysqlEngineSpec.parseSettings({ image });
    if (!parsed) throw new TypeError(`expected ${image} to be accepted`);
    assertEquals(parsed.image, image);
  }
  assertEquals(
    mysqlEngineSpec.parseSettings({ image: "docker.io/library/mysql:8" }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({ image: "docker.io/library/mysql:latest" }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({ image: "docker.io/library/mariadb:12.3" }),
    null,
  );
});

test("runtime spec has no ports key for single-member and container port stays 3306", () => {
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings({
      exposure: { enabled: true, scope: "public" },
    }),
    rootUsername: "root",
  });
  assertEquals("ports" in spec.service, false);
  assertEquals(spec.exposure.containerPort, 3306);
  assertEquals(spec.exposure.enabled, true);
});

test("multi-member private listener publishes native 3306", () => {
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
    member: {
      role: "primary",
      ordinal: 1,
      privateListener: { address: "203.0.113.10", port: 13306 },
    },
  });
  assertEquals(spec.service.ports, ["203.0.113.10:13306:3306"]);
});

test("volume name is hyphen-free and targets /var/lib/mysql", () => {
  const managedId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId,
    settings: defaultSettings(),
    rootUsername: "root",
  });
  assertEquals(spec.volumes[0]?.target, "/var/lib/mysql");
  assertEquals(
    spec.volumes[0]?.name,
    "managed_aaaaaaaa_bbbb_cccc_dddd_eeeeeeeeeeee_data",
  );
  assertEquals(spec.volumes[0]?.name.includes("-"), false);
});

test("MYSQL_ROOT_PASSWORD is placeholder and never plaintext", () => {
  const plaintext = "super-secret-password-never-in-spec";
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
  });
  assertEquals(spec.env.MYSQL_ROOT_PASSWORD, ManagedSecretPlaceholder);
  assertEquals(JSON.stringify(spec).includes(plaintext), false);
  assertEquals("MYSQL_USER" in spec.env, false);
  assertEquals("MYSQL_PASSWORD" in spec.env, false);
});

test("my.cnf is base plus operator snippet with bounded binlog retention", () => {
  const settings = defaultSettings({
    engineConfig: "max_connections = 200\n",
  });
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings,
    rootUsername: "root",
  });
  const conf = spec.configFiles.find((f) => f.path === "my.cnf");
  if (!conf) throw new TypeError("missing my.cnf");
  assertEquals(conf.mode, "0640");
  assertEquals(conf.contents.includes("bind-address=0.0.0.0"), true);
  assertEquals(conf.contents.includes("port=3306"), true);
  assertEquals(conf.contents.includes("gtid_mode=ON"), true);
  assertEquals(
    conf.contents.includes(
      `binlog_expire_logs_seconds=${BINLOG_EXPIRE_LOGS_SECONDS}`,
    ),
    true,
  );
  assertEquals(conf.contents.includes("# --- operator config ---"), true);
  assertEquals(conf.contents.includes("max_connections = 200"), true);
});

test("standby my.cnf sets read_only", () => {
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
    member: { role: "standby", ordinal: 2 },
  });
  const conf = spec.configFiles.find((f) => f.path === "my.cnf")?.contents ??
    "";
  assertEquals(conf.includes("read_only=ON"), true);
  assertEquals(conf.includes("super_read_only=ON"), true);
  assertEquals(conf.includes("server_id=2"), true);
});

test("engine TLS is unconditional, independent of the client SSL mode", () => {
  // ProxySQL dials backends with `use_ssl=1`, so the engine keeps
  // `require_secure_transport=ON` even when clients are allowed plaintext.
  for (const mode of MANAGED_SSL_MODES) {
    const spec = mysqlEngineSpec.buildRuntimeSpec({
      managedId: "11111111-1111-1111-1111-111111111111",
      settings: defaultSettings({ ssl: { mode } }),
      rootUsername: "root",
    });
    const conf = spec.configFiles.find((f) => f.path === "my.cnf");
    if (!conf) throw new TypeError("missing my.cnf");
    assertEquals(conf.contents.includes("require_secure_transport=ON"), true);
    assertEquals(conf.contents.includes("authentication_policy=*,,"), true);
    assertEquals(
      conf.contents.includes("authentication_policy=caching_sha2_password"),
      false,
    );
    assertEquals(spec.tlsMaterial?.selfSigned, true);
  }
});

test("mysql defaultSettings leave ssl.mode unset so the org default applies", () => {
  assertEquals(mysqlEngineSpec.defaultSettings.ssl.mode, undefined);
  assertEquals(defaultSettings().ssl.mode, undefined);
});

test("initdb platform bootstrap is secret-free socket auth", () => {
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
  });
  const initdb = spec.configFiles.find((f) =>
    f.path === "initdb/00-turbopanel.sql"
  );
  if (!initdb) throw new TypeError("missing initdb");
  assertEquals(initdb.contents.includes("auth_socket"), true);
  assertEquals(initdb.contents.includes("INSTALL PLUGIN auth_socket"), true);
  assertEquals(initdb.contents.includes("INSTALL PLUGIN IF NOT EXISTS"), false);
  assertEquals(initdb.contents.includes("IDENTIFIED BY"), false);
  assertEquals(initdb.contents.includes("'mysql'@'localhost'"), true);
});

test("socket healthcheck without password", () => {
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
  });
  const cmd = spec.healthcheck.test[1] ?? "";
  assertEquals(cmd.includes("mysqladmin ping --protocol=socket"), true);
  // Password flags are `-p` / `--password` — do not treat `--protocol` as a match.
  assertEquals(/\s-p(?:\s|=|$)/.test(cmd), false);
  assertEquals(cmd.includes("--password"), false);
});

test("resource mapping matches applyResourcesToComposeService", () => {
  const resources = {
    cpus: 1.5,
    memoryBytes: 512 * 1024 * 1024,
    memoryReservationBytes: 256 * 1024 * 1024,
  };
  const settings = defaultSettings({ resources });
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings,
    rootUsername: "root",
  });
  const expected: Record<string, unknown> = {};
  applyResourcesToComposeService(expected, resources);
  assertEquals(spec.service.cpus, expected.cpus);
  assertEquals(spec.service.mem_limit, expected.mem_limit);
  const conf = spec.configFiles.find((f) => f.path === "my.cnf")?.contents ??
    "";
  assertEquals(conf.includes("innodb_buffer_pool_size="), true);
});

test("buildConnectionInfo masks the password and renders the given mode", () => {
  const info = mysqlEngineSpec.buildConnectionInfo({
    host: "db.example",
    port: 3306,
    database: "defaultdb",
    username: "root",
    sslMode: "verify-full",
  });
  assertEquals(info.dsn.includes("***"), true);
  assertEquals(info.dsn.includes("ssl-mode=VERIFY_IDENTITY"), true);
  assertEquals(info.dsn.includes("super-secret"), false);
});

test("formatSslMode uses MySQL ssl-mode spellings, not libpq ones", () => {
  // MySQL has no "try plaintext first" value, so `allow` and `prefer` collapse
  // onto PREFERRED, and hostname verification is VERIFY_IDENTITY.
  assertEquals(
    MANAGED_SSL_MODES.map((mode) => mysqlEngineSpec.formatSslMode(mode)),
    [
      "DISABLED",
      "PREFERRED",
      "PREFERRED",
      "REQUIRED",
      "VERIFY_CA",
      "VERIFY_IDENTITY",
    ],
  );
});

test("backup descriptor advertises sql dump client", () => {
  const backup = mysqlEngineSpec.backup;
  if (!backup) throw new TypeError("expected mysql backup descriptor");
  assertEquals(backup.artifactExtension, "sql");
  assertEquals(backup.supportsDatabaseScope, true);
  assertEquals(backup.supportsInstanceScope, false);
  assertEquals(backup.executor, {
    kind: "docker-exec",
    dumpClient: "mysqldump",
    restoreClient: "mysql",
  });
});

test("parseSettings rejects reserved cnf keys and includes", () => {
  assertEquals(
    mysqlEngineSpec.parseSettings({ engineConfig: "port = 5555\n" }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({ engineConfig: "gtid_mode = OFF\n" }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({
      engineConfig: "bind-address = 127.0.0.1\n",
    }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({
      engineConfig: "!include /etc/passwd\n",
    }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({
      dockerOptions: { extraEnv: { MYSQL_ROOT_PASSWORD: "x" } },
    }),
    null,
  );
});

test("parseSettings rejects invalid initialDatabase", () => {
  assertEquals(
    mysqlEngineSpec.parseSettings({ initialDatabase: "bad-name" }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({ initialDatabase: "a".repeat(65) }),
    null,
  );
  // System schemas are not valid application initial databases.
  assertEquals(
    mysqlEngineSpec.parseSettings({ initialDatabase: "mysql" }),
    null,
  );
  assertEquals(mysqlEngineSpec.parseSettings({ initialDatabase: "sys" }), null);
  const defaults = mysqlEngineSpec.parseSettings({}) as MysqlManagedSettings;
  assertEquals(defaults.initialDatabase, "defaultdb");
});

test("userOperations use backtick quote and 32-char max", () => {
  assertEquals(mysqlEngineSpec.userOperations.identifier.quote, "`");
  assertEquals(mysqlEngineSpec.userOperations.identifier.maxLength, 32);
  assertEquals(mysqlEngineSpec.userOperations.executor.client, "mysql");
});

test("binding DSN embeds the plaintext password with MySQL ssl-mode spelling", () => {
  const binding = mysqlEngineSpec.binding;
  if (!binding) throw new TypeError("expected mysql binding descriptor");
  assertEquals(binding.scheme, "mysql");
  assertEquals(binding.unprefixed.host, "MYSQL_HOST");
  assertEquals(binding.unprefixed.sslMode, undefined);
  const dsn = binding.buildBindingDsn({
    host: "203.0.113.41",
    port: 13306,
    database: "defaultdb",
    username: "app_user",
    password: TEST_ONLY_TURBOPANEL_SECRET,
    sslMode: "verify-ca",
  });
  assertEquals(dsn.startsWith("mysql://"), true);
  assertEquals(dsn.includes(encodeURIComponent(TEST_ONLY_TURBOPANEL_SECRET)), true);
  assertEquals(dsn.includes("***"), false);
  assertEquals(dsn.includes("ssl-mode=VERIFY_CA"), true);
});

test("useOrgTls omits self-signed tlsMaterial", () => {
  const withOrg = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
    useOrgTls: true,
  });
  assertEquals(withOrg.tlsMaterial, undefined);

  const withoutOrg = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings: defaultSettings(),
    rootUsername: "root",
  });
  assertEquals(withoutOrg.tlsMaterial?.commonName, "managed-mysql");
});

test("buildRuntimeSpec applies dockerOptions onto compose service and env", () => {
  const settings = defaultSettings({
    dockerOptions: {
      restart: "on-failure",
      stopGracePeriodSeconds: 45,
      shmSizeBytes: 32 * 1024 * 1024,
      ulimits: { nofile: { soft: 512, hard: 1024 } },
      labels: { "app.tier": "mysql" },
      extraEnv: { MY_FLAG: "1" },
    },
    exposure: { enabled: true, scope: "datacenter" },
  });
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings,
    rootUsername: "root",
  });
  assertEquals(spec.service.restart, "on-failure");
  assertEquals(spec.service.stop_grace_period, "45s");
  assertEquals(spec.service.shm_size, 32 * 1024 * 1024);
  assertEquals(spec.service.ulimits, {
    nofile: { soft: 512, hard: 1024 },
  });
  assertEquals(spec.service.labels, { "app.tier": "mysql" });
  assertEquals(spec.env.MY_FLAG, "1");
  assertEquals(spec.exposure.scope, "datacenter");
});

test("parseSettings rejects non-objects and system schemas; null uses defaults", () => {
  assertEquals(mysqlEngineSpec.parseSettings([]), null);
  assertEquals(mysqlEngineSpec.parseSettings("mysql"), null);
  assertEquals(
    mysqlEngineSpec.parseSettings({ initialDatabase: "information_schema" }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({ initialDatabase: "performance_schema" }),
    null,
  );
  assertEquals(
    mysqlEngineSpec.parseSettings({ initialDatabase: 12 }),
    null,
  );
  const fromNull = mysqlEngineSpec.parseSettings(null);
  if (!fromNull) throw new TypeError("expected defaults for null settings");
  assertEquals((fromNull as MysqlManagedSettings).initialDatabase, "defaultdb");
  const fromUndefined = mysqlEngineSpec.parseSettings(undefined);
  if (!fromUndefined) {
    throw new TypeError("expected defaults for undefined settings");
  }
  assertEquals(
    (fromUndefined as MysqlManagedSettings).initialDatabase,
    "defaultdb",
  );
});

test("buildRuntimeSpec falls back when settings omit image and initialDatabase", () => {
  const settings = {
    ssl: {},
    exposure: { enabled: false },
  } as MysqlManagedSettings;
  const spec = mysqlEngineSpec.buildRuntimeSpec({
    managedId: "11111111-1111-1111-1111-111111111111",
    settings,
    rootUsername: "root",
  });
  assertEquals(spec.service.image, mysqlEngineSpec.defaultImage);
  assertEquals(spec.env.MYSQL_DATABASE, "defaultdb");
});

test("buildConnectionInfo renders disable as DISABLED", () => {
  const info = mysqlEngineSpec.buildConnectionInfo({
    host: "db.example",
    port: 3306,
    database: "defaultdb",
    username: "root",
    sslMode: "disable",
  });
  assertEquals(info.dsn.includes("ssl-mode=DISABLED"), true);
});
