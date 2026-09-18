import { assert } from "@std/assert";
import { join } from "@std/path";
import { it } from "@std/testing/bdd";
import { DEFAULT_DUCKDB_LIB_DIR, DEFAULT_METRICS_DIR } from "./server-paths.ts";

/**
 * Co-located daemon checkout (`../turbopaneld` next to this repo). CI only checks
 * out turbopanel/turbopanel, so the unit template may be absent there.
 */
function resolveDaemonRepoRoot(): string {
  const override = Deno.env.get("TURBOPANEL_DAEMON_REPO")?.trim();
  if (override) return override;
  return new URL("../../turbopaneld", import.meta.url).pathname;
}

function instanceLaunchUnitPath(): string {
  return join(
    resolveDaemonRepoRoot(),
    "orchestration/roles/instance-launch/templates/turbopanel-instance.service.j2",
  );
}

/** Read a file from the co-located daemon checkout; null when absent (CI). */
async function readDaemonFile(relPath: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(join(resolveDaemonRepoRoot(), relPath));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return null;
  }
}

function extractAllowNetFlag(command: string): string | null {
  const match = /--allow-net=([^\s]+)/.exec(command);
  return match?.[1] ?? null;
}

function extractPathListFlag(command: string, flag: string): string[] {
  const match = new RegExp(`--${flag}=([^\\s]+)`).exec(command);
  return match?.[1].split(",") ?? [];
}

async function readCompileTasks(): Promise<Record<string, string>> {
  const denoJsonPath = new URL("../deno.json", import.meta.url);
  const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath));
  const tasks: Record<string, string> = {};
  for (const taskName of ["compile", "compile:dev"]) {
    const task = denoJson.tasks?.[taskName];
    assert(typeof task === "string", `deno.json must define tasks.${taskName}`);
    tasks[taskName] = task;
  }
  return tasks;
}

/**
 * The template's `ExecStart=` lines (deno-run + compiled branches), with
 * Jinja expressions collapsed (`{{ var }}` → `{{var}}`) so flag values
 * tokenize on whitespace like real command lines.
 */
async function readUnitExecStartLines(): Promise<string[] | null> {
  try {
    const serviceUnit = await Deno.readTextFile(instanceLaunchUnitPath());
    return serviceUnit
      .split("\n")
      .filter((line) => line.startsWith("ExecStart="))
      .map((line) => line.replaceAll(/\{\{\s*([^}]*?)\s*\}\}/g, "{{$1}}"));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return null;
  }
}

it("compile tasks grant FFI for the DuckDB native addon", async () => {
  // `@duckdb/node-api` loads a native `.node` addon: `deno compile` bundles it
  // from the npm cache and self-extracts at runtime, but loading it requires
  // FFI permission. Unscoped: the extraction path is a per-binary temp dir.
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    assert(
      /(^|\s)--allow-ffi(\s|$)/.test(task),
      `${taskName} must include --allow-ffi for the DuckDB native addon`,
    );
  }
});

it("compile tasks grant the metrics state tree", async () => {
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    for (const flag of ["allow-read", "allow-write"]) {
      const paths = extractPathListFlag(task, flag);
      assert(
        paths.includes(DEFAULT_METRICS_DIR),
        `${taskName} --${flag} must include ${DEFAULT_METRICS_DIR} (DuckDB metrics store)`,
      );
    }
  }
});

it("compile tasks carry no ClickHouse grants", async () => {
  // The metrics store moved to embedded DuckDB; the compiled instance must
  // not retain any reference to the retired ClickHouse store.
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    assert(
      !task.includes("TURBOPANEL_CLICKHOUSE"),
      `${taskName} must not reference TURBOPANEL_CLICKHOUSE`,
    );
    assert(
      !task.includes("clickhouse"),
      `${taskName} must not reference clickhouse`,
    );
  }
});

it("instance outbound network is unrestricted on self-hosted — no --allow-net host list", async () => {
  // Decided 2026-09-18: a self-hosted control plane reaches whatever its
  // operator configures — an alert webhook, a chat integration, a push relay,
  // a self-managed forge — and a host list baked at compile time made every
  // one of those impossible (Deno cannot widen it at runtime; delivery failed
  // with PermissionDenied). The host firewall is the boundary now. The bare
  // flag stays: Deno 2.9+ treats Unix-domain connect (Postgres, Redis, the
  // listen socket) as net, so removing --allow-net entirely would refuse the
  // database. A reintroduced host list is the regression this test exists for.
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    assert(
      /(^|\s)--allow-net(\s|$)/.test(task),
      `${taskName} must carry a bare --allow-net`,
    );
    assert(
      extractAllowNetFlag(task) === null,
      `${taskName} must not carry a --allow-net=<hosts> list (decided 2026-09-18)`,
    );
  }

  const execStartLines = await readUnitExecStartLines();
  if (execStartLines === null) return; // standalone CI: daemon checkout absent
  const denoRunLines = execStartLines.filter((line) => line.includes(" run "));
  assert(denoRunLines.length > 0, "unit template must keep deno-run branches");
  for (const line of denoRunLines) {
    assert(
      /(^|\s)--allow-net(\s|$)/.test(line),
      "deno-run ExecStart must carry a bare --allow-net",
    );
    assert(
      extractAllowNetFlag(line) === null,
      "deno-run ExecStart must not carry a --allow-net=<hosts> list (decided 2026-09-18)",
    );
  }
});

it("instance unit ExecStart drops ClickHouse and grants DuckDB needs", async () => {
  const execStartLines = await readUnitExecStartLines();
  if (execStartLines === null) return; // standalone CI: daemon checkout absent
  assert(
    execStartLines.length > 0,
    "unit template must define ExecStart lines",
  );

  for (const line of execStartLines) {
    assert(
      !line.includes("clickhouse_http_port"),
      "turbopanel-instance.service.j2 ExecStart must not reference clickhouse_http_port",
    );
  }

  // Source mode (`deno run`) loads the DuckDB addon from Deno's npm cache
  // (real files, `$ORIGIN` finds libduckdb.so) but still needs FFI permission
  // and the metrics tree. The compiled branch bakes its flags at compile time.
  const denoRunLines = execStartLines.filter((line) => line.includes(" run "));
  assert(denoRunLines.length > 0, "unit template must keep deno-run branches");
  for (const line of denoRunLines) {
    assert(
      /(^|\s)--allow-ffi(\s|$)/.test(line),
      "deno-run ExecStart must include --allow-ffi for the DuckDB native addon",
    );
    for (const flag of ["allow-read", "allow-write"]) {
      const paths = extractPathListFlag(line, flag);
      assert(
        paths.includes("{{turbopanel_metrics_dir}}"),
        `deno-run ExecStart --${flag} must include {{ turbopanel_metrics_dir }}`,
      );
    }
  }
});

it("compiled instance branch vendors libduckdb.so on LD_LIBRARY_PATH", async () => {
  // `deno compile` self-extracts the bundled duckdb.node addon but not its
  // companion libduckdb.so, so the compiled ExecStart branch must point
  // LD_LIBRARY_PATH at the vendored directory — and the build flow must
  // actually populate that directory, or the service fails to start.
  const serviceUnit = await readDaemonFile(
    "orchestration/roles/instance-launch/templates/turbopanel-instance.service.j2",
  );
  if (serviceUnit === null) return; // standalone CI: daemon checkout absent
  const collapsed = serviceUnit.replaceAll(/\{\{\s*([^}]*?)\s*\}\}/g, "{{$1}}");
  assert(
    collapsed.includes(
      "Environment=LD_LIBRARY_PATH={{turbopanel_duckdb_lib_dir}}",
    ),
    "compiled branch must put {{ turbopanel_duckdb_lib_dir }} on LD_LIBRARY_PATH",
  );
  assert(
    collapsed.includes("ExecStart={{turbopanel_instance_binary}}"),
    "compiled branch must exec the compiled instance binary",
  );

  // The unit's LD_LIBRARY_PATH default must resolve to the same vendored
  // directory the binary probes at runtime (server-paths.ts).
  const defaults = await readDaemonFile(
    "orchestration/roles/instance-launch/defaults/main.yml",
  );
  assert(
    defaults !== null,
    "instance-launch defaults must exist next to the unit template",
  );
  assert(
    defaults.includes(
      'turbopanel_duckdb_lib_dir: "{{ turbopanel_vendor_dir }}/duckdb/lib"',
    ),
    "turbopanel_duckdb_lib_dir must default to <vendor>/duckdb/lib",
  );
  assert(
    defaults.includes(
      'turbopanel_vendor_dir: "{{ turbopanel_install_root }}/vendor"',
    ),
    "turbopanel_vendor_dir must default to <install root>/vendor",
  );
  assert(
    defaults.includes("turbopanel_install_root: /opt/turbopanel"),
    "turbopanel_install_root must default to /opt/turbopanel",
  );
  assert(
    DEFAULT_DUCKDB_LIB_DIR === "/opt/turbopanel/vendor/duckdb/lib",
    "server-paths DEFAULT_DUCKDB_LIB_DIR must match the unit's resolved LD_LIBRARY_PATH",
  );

  // Provisioning half of the contract: instance-build stages the
  // architecture-appropriate libduckdb.so into the vendored directory.
  const buildTasks = await readDaemonFile(
    "orchestration/roles/instance-build/tasks/main.yml",
  );
  assert(
    buildTasks !== null,
    "instance-build role must exist next to the unit template",
  );
  assert(
    buildTasks.includes("{{ turbopanel_duckdb_lib_dir }}/libduckdb.so"),
    "instance-build must stage libduckdb.so into turbopanel_duckdb_lib_dir",
  );
});

it("self-hosted compile tasks do not grant Stripe", async () => {
  const tasks = await readCompileTasks();
  // Outbound network is unrestricted (decided 2026-09-18), so the guard is
  // that nothing in a self-hosted compile task *names* Stripe: billing is
  // Workers-only and a compiled instance must never be configured toward it.
  for (const [taskName, task] of Object.entries(tasks)) {
    assert(
      !task.includes("api.stripe.com"),
      `${taskName} must not mention api.stripe.com`,
    );
  }
});

it("production compile excludes developer-only permissions and entry", async () => {
  const { compile: compileTask } = await readCompileTasks();
  assert(
    compileTask.endsWith(" src/deno.ts") ||
      compileTask.includes(" src/deno.ts "),
    "production compile must target src/deno.ts",
  );
  assert(
    !compileTask.includes("src/deno-dev.ts"),
    "production compile must not target src/deno-dev.ts",
  );

  // Outbound network is unrestricted (decided 2026-09-18), so the developer
  // ports are no longer a --allow-net question; they must simply not appear.
  for (const port of ["4983", "1025", "8123"]) {
    assert(
      !compileTask.includes(`127.0.0.1:${port}`),
      `production compile must not reference developer port ${port}`,
    );
  }

  const allowRun = /--allow-run=([^\s]+)/.exec(compileTask)?.[1] ?? "";
  for (const denied of ["git", "tar", "systemctl", "mkfifo"]) {
    assert(
      !allowRun.split(",").includes(denied),
      `production compile must not --allow-run=${denied}`,
    );
  }
});

it("compile tasks embed the migrations and can run openssl for the install-time verbs", async () => {
  // instance-runtime-packaging (Road to 0.1.x): `turbopanel-instance migrate`
  // reads the shipped migrations out of the binary, and
  // `generate-self-signed-cert` shells out to /usr/bin/openssl and
  // /usr/bin/hostname exactly as scripts/generate-self-signed-cert.mjs does.
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    assert(
      /(^|\s)--include migrations(\s|$)/.test(task),
      `${taskName} must --include migrations so the migrate subcommand works without a checkout`,
    );
    const allowRun = (/--allow-run=([^\s]+)/.exec(task)?.[1] ?? "").split(",");
    for (const bin of ["openssl", "/usr/bin/openssl", "/usr/bin/hostname"]) {
      assert(
        allowRun.includes(bin),
        `${taskName} --allow-run must include ${bin}`,
      );
    }
  }
});

it("the mailer compiles as its own binary with outbound network and the socket tree only", async () => {
  // A compiled mailer bakes its permission set. Unlike the instance, it talks
  // to operator-configured SMTP relays and Mailgun — the one place a broad
  // --allow-net is honest — and touches only the runtime/config trees and the
  // Postgres socket directory (postgres.js needs write there to connect).
  const denoJson = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  const task: unknown = denoJson.tasks?.["compile:mailer"];
  assert(
    typeof task === "string",
    "deno.json must define tasks.compile:mailer",
  );
  assert(
    task.endsWith(" mailer/main.ts"),
    "compile:mailer must target mailer/main.ts",
  );
  assert(
    task.includes(" -o dist/turbopanel-mailer "),
    "compile:mailer must emit dist/turbopanel-mailer",
  );
  assert(
    /(^|\s)--allow-net(\s|$)/.test(task),
    "compile:mailer grants unrestricted outbound --allow-net",
  );
  const allowRead = (/--allow-read=([^\s]+)/.exec(task)?.[1] ?? "").split(",");
  for (
    const dir of ["/run/turbopanel", "/etc/turbopanel", "/var/run/turbopanel"]
  ) {
    assert(
      allowRead.includes(dir),
      `compile:mailer --allow-read must include ${dir}`,
    );
  }
  const allowWrite = (/--allow-write=([^\s]+)/.exec(task)?.[1] ?? "").split(
    ",",
  );
  assert(
    allowWrite.includes("/var/run/turbopanel"),
    "compile:mailer --allow-write must cover the Postgres socket tree",
  );
  assert(
    !task.includes("--allow-run"),
    "compile:mailer must not --allow-run anything",
  );
  assert(!task.includes("--allow-ffi"), "compile:mailer must not --allow-ffi");
});

it("compile tasks can read and write the Postgres socket directory the unit names", async () => {
  // install-rehearsal (Road to 0.1.x): postgres.js connects over
  // /var/run/turbopanel/postgres/.s.PGSQL.5432 through node:net, which under
  // Deno needs --allow-read and --allow-write on that path in addition to
  // the unix: --allow-net entry — the source-mode unit grants both
  // (postgres_socket_dir); the compiled binary was refused with NotCapable
  // on its first `migrate` on a clean host until the compile tasks did too.
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    const allowRead = (/--allow-read=([^\s]+)/.exec(task)?.[1] ?? "").split(
      ",",
    );
    const allowWrite = (/--allow-write=([^\s]+)/.exec(task)?.[1] ?? "").split(
      ",",
    );
    assert(
      allowRead.includes("/var/run/turbopanel"),
      `${taskName} --allow-read must include /var/run/turbopanel`,
    );
    assert(
      allowWrite.includes("/var/run/turbopanel"),
      `${taskName} --allow-write must include /var/run/turbopanel`,
    );
    // The Postgres socket connect is covered by the bare --allow-net
    // (decided 2026-09-18); the read/write grants above are the part that
    // still has to be spelled out for postgres.js.
    assert(
      /(^|\s)--allow-net(\s|$)/.test(task),
      `${taskName} must carry --allow-net for the Postgres socket connect`,
    );
  }
});
