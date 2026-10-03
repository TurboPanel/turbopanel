/**
 * Negative coverage for the metrics boundary guard: AE positional tokens and
 * the backend-private page-identity symbols must fail outside
 * `backends/cloudflare/`, and the real tree must stay clean.
 */
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  checkMetricsBoundaries,
  collectAeTokenFailures,
  collectPageIdentifierFailures,
} from "./check-metrics-boundaries.mjs";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");

test("the real tree keeps AE tokens and page-identity symbols backend-private", () => {
  assertEquals(checkMetricsBoundaries({ root: repoRoot }), []);
});

test("a temp tree with a leak in each rule fails", async () => {
  const root = await Deno.makeTempDir();
  try {
    const leaks: Record<string, string> = {
      "src/daemon/metrics/query/series-response.ts":
        "const value = row.double12;\n",
      "src/client/servers/metrics-routes.ts":
        "const ids = blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX];\n",
    };
    for (const [rel, body] of Object.entries(leaks)) {
      await Deno.mkdir(dirname(join(root, rel)), { recursive: true });
      await Deno.writeTextFile(join(root, rel), body);
    }
    const failures = checkMetricsBoundaries({ root });
    assertEquals(failures.length, 2);
    assert(failures.some((f) => f.includes('".double12"')));
    assert(
      failures.some((f) => f.includes("AE_BLOB_SOURCE_OR_IDENTITY_INDEX")),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("collectAeTokenFailures flags a positional AE literal outside backends/cloudflare/", () => {
  const failures = collectAeTokenFailures(
    "src/daemon/metrics/query/series-response.ts",
    "const value = row.double12;\n",
  );
  assertEquals(failures, [
    'src/daemon/metrics/query/series-response.ts:1 references AE physical token ".double12" outside backends/cloudflare/',
  ]);
});

test("collectAeTokenFailures flags the raw sentinel literal", () => {
  const failures = collectAeTokenFailures(
    "src/daemon/metrics/query/uptime.ts",
    "const SENTINEL = -1e308;\n",
  );
  assertEquals(failures.length, 1);
});

test("collectAeTokenFailures allows positional tokens inside backends/cloudflare/", () => {
  const failures = collectAeTokenFailures(
    "src/daemon/metrics/backends/cloudflare/field-map.ts",
    "doubles[embedBase] = nic0?.receiveBytesPerSecond ?? -1e308;\n",
  );
  assertEquals(failures, []);
});

test("collectAeTokenFailures allows importing the sentinel constant by name", () => {
  const failures = collectAeTokenFailures(
    "src/daemon/metrics/backends/duckdb/store.test.ts",
    'import { AE_MISSING_METRIC_SENTINEL } from "../cloudflare/field-map.ts";\n',
  );
  assertEquals(failures, []);
});

test("collectAeTokenFailures does not flag doc-comment prose mentioning a slot name", () => {
  const failures = collectAeTokenFailures(
    "src/daemon/metrics/query/uptime.ts",
    " * slot (`double20`-equivalent) for the sample's intervalSeconds.\n",
  );
  assertEquals(failures, []);
});

test("collectAeTokenFailures ignores non-.ts files", () => {
  const failures = collectAeTokenFailures(
    "src/daemon/metrics/AGENTS.md",
    "MetricPart double12 -1e308\n",
  );
  assertEquals(failures, []);
});

test("collectPageIdentifierFailures allows the allowlisted daemon ingest-route test", () => {
  const failures = collectPageIdentifierFailures(
    "src/daemon/api-routes.test.ts",
    "  const ids = blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX];\n",
  );
  assertEquals(failures, []);
});

test("collectPageIdentifierFailures flags a page-identifier symbol outside backends/cloudflare/", () => {
  const failures = collectPageIdentifierFailures(
    "src/client/servers/metrics-routes.ts",
    "  const ids = blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX];\n",
  );
  assertEquals(failures, [
    'src/client/servers/metrics-routes.ts:1 references backend-private page-identifier symbol "AE_BLOB_SOURCE_OR_IDENTITY_INDEX" outside backends/cloudflare/',
  ]);
});

test("collectPageIdentifierFailures flags a reimplemented splitPageIdentity helper", () => {
  const failures = collectPageIdentifierFailures(
    "src/client/servers/metrics-routes-helpers.ts",
    "function splitPageIdentity(csv: string) { return csv.split(','); }\n",
  );
  assertEquals(failures.length, 1);
});

test("collectPageIdentifierFailures allows page-identifier symbols inside backends/cloudflare/", () => {
  const failures = collectPageIdentifierFailures(
    "src/daemon/metrics/backends/cloudflare/sql-api.ts",
    "export function entityIdInPageIdentityPredicate(entityId: string): string {\n",
  );
  assertEquals(failures, []);
});
