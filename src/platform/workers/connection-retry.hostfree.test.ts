import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { fetchWithConnectionRetry } from "./connection-retry.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** What postgres.js raises when a primary restart drops the connection. */
function connectionClosed(): Error {
  return Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });
}

/** The real app is mounted into the per-request app with `route`, as `workers.ts` does. */
function appFailingOnce(error: () => Error) {
  let calls = 0;
  const inner = new Hono();
  const handler = () => {
    calls += 1;
    if (calls === 1) throw error();
    return new Response(`ok after ${calls}`);
  };
  inner.get("/servers", handler);
  inner.post("/servers", handler);
  const requestApp = new Hono();
  requestApp.route("/", inner);
  return { requestApp, calls: () => calls };
}

test("a catch around app.fetch never sees a handler's throw — Hono answers 500 first", async () => {
  // Why the previous `try { await app.fetch() } catch` in workers.ts was dead code.
  const { requestApp } = appFailingOnce(connectionClosed);
  let caught = false;
  let response: Response | undefined;
  try {
    response = await requestApp.fetch(new Request("https://panel.test/servers"));
  } catch {
    caught = true;
  }
  assertEquals(caught, false);
  assertEquals(response?.status, 500);
});

test("a GET that lost its connection is replayed once on a fresh connection", async () => {
  const { requestApp, calls } = appFailingOnce(connectionClosed);
  const reopened: string[] = [];
  const response = await fetchWithConnectionRetry(
    requestApp,
    new Request("https://panel.test/servers"),
    {},
    undefined,
    {
      reopen: () => reopened.push("reopen"),
      onRetry: (method, path) => reopened.push(`${method} ${path}`),
    },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "ok after 2");
  assertEquals(calls(), 2);
  assertEquals(reopened, ["GET /servers", "reopen"]);
});

test("a POST that lost its connection is not replayed — it may have written", async () => {
  const { requestApp, calls } = appFailingOnce(connectionClosed);
  let reopened = 0;
  const response = await fetchWithConnectionRetry(
    requestApp,
    new Request("https://panel.test/servers", { method: "POST" }),
    {},
    undefined,
    { reopen: () => reopened++ },
  );
  assertEquals(response.status, 500);
  assertEquals(calls(), 1);
  assertEquals(reopened, 0);
});

test("any other failure keeps Hono's default response and is not replayed", async () => {
  const { requestApp, calls } = appFailingOnce(() => new Error("bug"));
  let reopened = 0;
  const response = await fetchWithConnectionRetry(
    requestApp,
    new Request("https://panel.test/servers"),
    {},
    undefined,
    { reopen: () => reopened++ },
  );
  assertEquals(response.status, 500);
  assertEquals(calls(), 1);
  assertEquals(reopened, 0);

  const thrown = new Hono();
  thrown.get("/gone", () => {
    throw new HTTPException(410, { message: "gone" });
  });
  const gone = await fetchWithConnectionRetry(
    thrown,
    new Request("https://panel.test/gone"),
    {},
    undefined,
    { reopen: () => reopened++ },
  );
  assertEquals(gone.status, 410);
  assertEquals(await gone.text(), "gone");
});
