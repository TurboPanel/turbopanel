import { assertEquals, assertRejects } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  ClickHouseHttpClient,
  ClickHouseHttpError,
  ClickHouseHttpTimeoutError,
} from "./client.ts";
import { AE_DATASET_NAME } from "../analytics-engine/field-map.ts";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  signal?: AbortSignal | null;
};

function installFakeFetch(
  handler: (req: CapturedRequest) => Promise<Response> | Response,
): {
  calls: CapturedRequest[];
  fetch: typeof fetch;
} {
  const calls: CapturedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string"
      ? init.body
      : init?.body == null
      ? null
      : String(init.body);
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
      signal: init?.signal ?? null,
    };
    calls.push(captured);
    return await handler(captured);
  };
  return { calls, fetch: fetchFn };
}

it("ClickHouseHttpClient.exec posts query with auth headers and database", async () => {
  const { calls, fetch } = installFakeFetch(() =>
    new Response("", { status: 200 })
  );
  const client = new ClickHouseHttpClient({
    url: "http://127.0.0.1:8123",
    database: "turbopanel_metrics",
    user: "turbopanel_app",
    password: "secret",
    fetch,
  });
  await client.exec("CREATE TABLE IF NOT EXISTS t (x UInt8)");
  assertEquals(calls.length, 1);
  const req = calls[0]!;
  assertEquals(req.method, "POST");
  assertEquals(req.headers.get("X-ClickHouse-User"), "turbopanel_app");
  assertEquals(req.headers.get("X-ClickHouse-Key"), "secret");
  const url = new URL(req.url);
  assertEquals(url.searchParams.get("database"), "turbopanel_metrics");
  assertEquals(
    url.searchParams.get("query"),
    "CREATE TABLE IF NOT EXISTS t (x UInt8)",
  );
});

it("ClickHouseHttpClient.insertRows sends JSONEachRow body", async () => {
  const { calls, fetch } = installFakeFetch(() =>
    new Response("", { status: 200 })
  );
  const client = new ClickHouseHttpClient({
    url: "http://127.0.0.1:8123/",
    database: "db",
    user: "u",
    password: "p",
    fetch,
  });
  await client.insertRows(AE_DATASET_NAME, [
    { index1: "a", double1: 1.5 },
    { index1: "b", double1: 2.5 },
  ]);
  assertEquals(calls.length, 1);
  const req = calls[0]!;
  const url = new URL(req.url);
  assertEquals(
    url.searchParams.get("query"),
    `INSERT INTO ${AE_DATASET_NAME} FORMAT JSONEachRow`,
  );
  assertEquals(
    req.body,
    [
      JSON.stringify({ index1: "a", double1: 1.5 }),
      JSON.stringify({ index1: "b", double1: 2.5 }),
    ].join("\n"),
  );
});

it("ClickHouseHttpClient.query parses JSONEachRow and appends FORMAT", async () => {
  const { calls, fetch } = installFakeFetch(() =>
    new Response(
      `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n`,
      { status: 200 },
    )
  );
  const client = new ClickHouseHttpClient({
    url: "http://127.0.0.1:8123",
    database: "db",
    user: "u",
    password: "p",
    fetch,
  });
  const rows = await client.query<{ a: number }>("SELECT 1 AS a", {
    server_id: "11111111-1111-1111-1111-111111111111",
  });
  assertEquals(rows, [{ a: 1 }, { a: 2 }]);
  const url = new URL(calls[0]!.url);
  assertEquals(
    url.searchParams.get("query")?.includes("FORMAT JSONEachRow"),
    true,
  );
  assertEquals(
    url.searchParams.get("param_server_id"),
    "11111111-1111-1111-1111-111111111111",
  );
});

it("ClickHouseHttpClient throws ClickHouseHttpError on non-2xx", async () => {
  const { fetch } = installFakeFetch(() =>
    new Response("Code: 60. DB::Exception: Table missing", { status: 404 })
  );
  const client = new ClickHouseHttpClient({
    url: "http://127.0.0.1:8123",
    database: "db",
    user: "u",
    password: "p",
    fetch,
  });
  const err = await assertRejects(
    () => client.exec("SELECT 1"),
    ClickHouseHttpError,
  );
  assertEquals(err.status, 404);
  assertEquals(err.body.includes("Table missing"), true);
});

it("ClickHouseHttpClient surfaces insert timeout via AbortController", async () => {
  const { fetch } = installFakeFetch((req) =>
    new Promise((_resolve, reject) => {
      req.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    })
  );
  const client = new ClickHouseHttpClient({
    url: "http://127.0.0.1:8123",
    database: "db",
    user: "u",
    password: "p",
    fetch,
    insertTimeoutMs: 20,
  });
  const err = await assertRejects(
    () => client.insertRows(AE_DATASET_NAME, [{ index1: "a", double1: 1 }]),
    ClickHouseHttpTimeoutError,
  );
  assertEquals(err.kind, "insert");
  assertEquals(err.timeoutMs, 20);
});

it("ClickHouseHttpClient surfaces query timeout cleanly", async () => {
  const { fetch } = installFakeFetch((req) =>
    new Promise((_resolve, reject) => {
      req.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    })
  );
  const client = new ClickHouseHttpClient({
    url: "http://127.0.0.1:8123",
    database: "db",
    user: "u",
    password: "p",
    fetch,
    queryTimeoutMs: 15,
  });
  const err = await assertRejects(
    () => client.query("SELECT 1"),
    ClickHouseHttpTimeoutError,
  );
  assertEquals(err.kind, "query");
  assertEquals(err.timeoutMs, 15);
});
