/**
 * Step-up auth for sensitive 2FA mutations (`assertRecentAuthOr403`): a
 * credential account must resubmit its password; everyone else (passkey /
 * OAuth) must have a session younger than {@link REAUTH_WINDOW_MS}.
 * Host-free: the one `account` select is mocked; password hashing is real.
 */
import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { hashPassword } from "./password.ts";
import { assertRecentAuthOr403, REAUTH_WINDOW_MS } from "./reauth.ts";
import type { SessionData } from "./session-store.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

function mockDb(credentialPassword: string | null | undefined): Db {
  const rows = credentialPassword === undefined
    ? []
    : [{ password: credentialPassword }];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db;
}

function session(over: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: "s1",
    userId: USER_ID,
    email: "user@example.com",
    role: "user",
    ...over,
  };
}

/** Run the guard inside a real Hono context so `c.json()` works. */
async function run(
  db: Db | undefined,
  sess: SessionData,
  body: { password?: unknown },
): Promise<{ status: number; error?: string } | null> {
  let result: Response | null = null;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (db) (c as Context<AppEnv>).set("db", db);
    await next();
  });
  app.post("/", async (c) => {
    result = await assertRecentAuthOr403(c, sess, body);
    return c.json({ ran: true });
  });
  await app.request("/", { method: "POST" });
  if (result === null) return null;
  const res = result as Response;
  return { status: res.status, error: (await res.json()).error };
}

test("a credential account passes only with its own password resubmitted", async () => {
  const db = mockDb(await hashPassword(PASSWORD));
  assertEquals(await run(db, session(), { password: PASSWORD }), null);
  assertEquals(await run(db, session(), { password: "wrong" }), {
    status: 403,
    error: "Reauthentication required",
  });
  assertEquals(await run(db, session(), {}), {
    status: 403,
    error: "Reauthentication required",
  });
  assertEquals(await run(db, session(), { password: "" }), {
    status: 403,
    error: "Reauthentication required",
  });
  // A fresh session does not substitute for the password on a credential account.
  assertEquals(
    await run(db, session({ createdAt: new Date().toISOString() }), {}),
    { status: 403, error: "Reauthentication required" },
  );
});

test("a passkey / OAuth account passes on a session younger than the window, and nothing else", async () => {
  const db = mockDb(undefined); // no credential row at all
  const now = Date.now();
  assertEquals(
    await run(
      db,
      session({ createdAt: new Date(now - 60_000).toISOString() }),
      {},
    ),
    null,
  );
  assertEquals(
    await run(
      db,
      session({
        createdAt: new Date(now - REAUTH_WINDOW_MS - 1_000).toISOString(),
      }),
      {},
    ),
    { status: 403, error: "Reauthentication required" },
  );
  // No createdAt, a future createdAt, or an unparsable one: refused.
  assertEquals(await run(db, session(), {}), {
    status: 403,
    error: "Reauthentication required",
  });
  assertEquals(
    await run(
      db,
      session({ createdAt: new Date(now + 60_000).toISOString() }),
      {},
    ),
    { status: 403, error: "Reauthentication required" },
  );
  assertEquals(await run(db, session({ createdAt: "not a date" }), {}), {
    status: 403,
    error: "Reauthentication required",
  });
  // A credential row with a null password is the same as no credential.
  assertEquals(
    await run(
      mockDb(null),
      session({ createdAt: new Date(now).toISOString() }),
      {},
    ),
    null,
  );
});

test("no database is a 503, not a silent pass", async () => {
  assertEquals(
    await run(undefined, session({ createdAt: new Date().toISOString() }), {}),
    {
      status: 503,
      error: "Database unavailable",
    },
  );
});
