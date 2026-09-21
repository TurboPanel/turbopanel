import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createDenoDb,
  createToolingDb,
  isConnectionClosedError,
  withToolingDb,
} from "./connection.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("createDenoDb throws when TURBOPANEL_DATABASE_URL is unset", () => {
  const previous = Deno.env.get("TURBOPANEL_DATABASE_URL");
  const previousDatabase = Deno.env.get("DATABASE_URL");
  Deno.env.delete("TURBOPANEL_DATABASE_URL");
  Deno.env.delete("DATABASE_URL");

  try {
    assertThrows(
      () => createDenoDb(),
      Error,
      "TURBOPANEL_DATABASE_URL is required",
    );
  } finally {
    if (previous !== undefined) {
      Deno.env.set("TURBOPANEL_DATABASE_URL", previous);
    }
    if (previousDatabase !== undefined) {
      Deno.env.set("DATABASE_URL", previousDatabase);
    }
  }
});

test("withToolingDb throws when database URL is missing", async () => {
  const previous = Deno.env.get("TURBOPANEL_DATABASE_URL");
  const previousDatabase = Deno.env.get("DATABASE_URL");
  Deno.env.delete("TURBOPANEL_DATABASE_URL");
  Deno.env.delete("DATABASE_URL");

  try {
    await assertRejects(
      () => withToolingDb(async () => "unused"),
      Error,
      "TURBOPANEL_DATABASE_URL is required",
    );
  } finally {
    if (previous !== undefined) {
      Deno.env.set("TURBOPANEL_DATABASE_URL", previous);
    }
    if (previousDatabase !== undefined) {
      Deno.env.set("DATABASE_URL", previousDatabase);
    }
  }
});

test("createToolingDb throws when database URL is missing", () => {
  const previous = Deno.env.get("TURBOPANEL_DATABASE_URL");
  const previousDatabase = Deno.env.get("DATABASE_URL");
  Deno.env.delete("TURBOPANEL_DATABASE_URL");
  Deno.env.delete("DATABASE_URL");

  try {
    assertThrows(
      () => createToolingDb(),
      Error,
      "TURBOPANEL_DATABASE_URL is required",
    );
  } finally {
    if (previous !== undefined) {
      Deno.env.set("TURBOPANEL_DATABASE_URL", previous);
    }
    if (previousDatabase !== undefined) {
      Deno.env.set("DATABASE_URL", previousDatabase);
    }
  }
});

test("isConnectionClosedError separates a lost connection from a refused query", () => {
  const withCode = (code: string, cause?: unknown): Error =>
    Object.assign(new Error(code), { code, ...(cause ? { cause } : {}) });

  // postgres.js's own, and the server's shutdown classes — what a primary
  // restart or a failover emits at the connections it drops.
  for (
    const code of [
      "CONNECTION_CLOSED",
      "CONNECTION_ENDED",
      "CONNECTION_DESTROYED",
      "ECONNRESET",
      "EPIPE",
      "57P01",
      "57P02",
      "57P03",
    ]
  ) {
    assertEquals(isConnectionClosedError(withCode(code)), true, code);
  }

  // drizzle 0.45 wraps driver errors, so the code is on the cause.
  assertEquals(
    isConnectionClosedError(
      Object.assign(new Error("Failed query"), {
        cause: withCode("CONNECTION_CLOSED"),
      }),
    ),
    true,
  );

  // A real refusal is never retried: a unique violation, a check violation, a
  // syntax error, or anything without a code at all.
  for (const code of ["23505", "23514", "42601", "42P01"]) {
    assertEquals(isConnectionClosedError(withCode(code)), false, code);
  }
  assertEquals(isConnectionClosedError(new Error("boom")), false);
  assertEquals(isConnectionClosedError("CONNECTION_CLOSED"), false);
  assertEquals(isConnectionClosedError(null), false);
});
