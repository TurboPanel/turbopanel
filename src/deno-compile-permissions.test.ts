import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { it } from "@std/testing/bdd";

const DEFAULT_CLICKHOUSE_HTTP_PORT = 8123;
const DEFAULT_CLICKHOUSE_URL = `http://127.0.0.1:${DEFAULT_CLICKHOUSE_HTTP_PORT}`;

/**
 * Co-located daemon checkout (`../daemon` next to this repo). CI only checks
 * out turbopanel/turbopanel, so the unit template may be absent there.
 */
function resolveDaemonRepoRoot(): string {
  const override = Deno.env.get("TURBOPANEL_DAEMON_REPO")?.trim();
  if (override) return override;
  return new URL("../../daemon", import.meta.url).pathname;
}

function instanceLaunchUnitPath(): string {
  return join(
    resolveDaemonRepoRoot(),
    "orchestration/roles/instance-launch/templates/turbopanel-instance.service.j2",
  );
}

function extractAllowNetFlag(command: string): string | null {
  const match = /--allow-net=([^\s]+)/.exec(command);
  return match?.[1] ?? null;
}

function extractClickHouseHttpPort(serviceUnit: string): number {
  const match = /127\.0\.0\.1:\{\{\s*clickhouse_http_port\s*\|\s*default\((\d+)\)\s*\}\}/.exec(
    serviceUnit,
  );
  if (!match) {
    throw new TypeError(
      "turbopanel-instance.service.j2 must declare clickhouse_http_port in --allow-net",
    );
  }
  return Number(match[1]);
}

/**
 * Prefer the daemon unit default when the sibling checkout is present; otherwise
 * use the compile-task pin (standalone CI).
 */
async function resolveClickHouseHttpPort(): Promise<number> {
  try {
    const serviceUnit = await Deno.readTextFile(instanceLaunchUnitPath());
    const port = extractClickHouseHttpPort(serviceUnit);
    assertEquals(port, DEFAULT_CLICKHOUSE_HTTP_PORT);
    return port;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return DEFAULT_CLICKHOUSE_HTTP_PORT;
  }
}

function clickHouseUrlHostPermission(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`unsupported ClickHouse URL protocol: ${parsed.protocol}`);
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.hostname}:${port}`;
}

it("compiled instance --allow-net includes ClickHouse HTTP endpoint", async () => {
  const denoJsonPath = new URL("../deno.json", import.meta.url);
  const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath));
  const compileTask = denoJson.tasks?.compile;
  assert(typeof compileTask === "string", "deno.json must define tasks.compile");

  const allowNet = extractAllowNetFlag(compileTask);
  assert(allowNet, "compile task must include --allow-net");

  const clickhousePort = await resolveClickHouseHttpPort();
  const requiredPermission = `127.0.0.1:${clickhousePort}`;
  assert(
    allowNet.split(",").includes(requiredPermission),
    `compile --allow-net must include ${requiredPermission} (source + compiled parity with instance-launch unit)`,
  );
});

it("compiled instance can reach configured TURBOPANEL_CLICKHOUSE_URL host", async () => {
  const denoJsonPath = new URL("../deno.json", import.meta.url);
  const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath));
  const compileTask = denoJson.tasks?.compile as string;
  const allowNet = extractAllowNetFlag(compileTask);
  assert(allowNet);

  const configuredUrl = DEFAULT_CLICKHOUSE_URL;
  const requiredPermission = clickHouseUrlHostPermission(configuredUrl);
  assert(
    allowNet.split(",").includes(requiredPermission),
    `compile --allow-net must include ${requiredPermission} for ${configuredUrl}`,
  );
});
