import { assertEquals, assertRejects } from "@std/assert";
import { and, eq, or } from "drizzle-orm";
import { passkey, twoFactor, user } from "../../db/schema.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  type MockAuthState,
} from "./authn-hostfree-doubles.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function twoUsers(): MockAuthState {
  const state = createEmptyMockAuthState();
  for (const id of ["user-a", "user-b"]) {
    state.users.push({
      id,
      email: `${id}@example.com`,
      isDisabled: false,
      isEmailVerified: false,
      is2FaEnabled: true,
      role: "user",
    });
    state.twoFactorRows.push({
      id: `2fa-${id}`,
      userId: id,
      secret: "sealed",
      isVerified: false,
      backupCodes: "[]",
    });
    state.passkeys.push({
      id: `pk-${id}`,
      userId: id,
      name: null,
      createdAt: "2026-09-25T00:00:00.000Z",
      credentialId: `cred-${id}`,
      publicKey: "pk",
      counter: 1,
      deviceType: "singleDevice",
      isBackedUp: false,
      aaguid: null,
      transports: null,
    });
  }
  return state;
}

test("an update touches only the rows its WHERE names", async () => {
  const state = twoUsers();
  const db = createMockAuthDb(state);
  await db.update(twoFactor).set({ isVerified: true }).where(
    eq(twoFactor.id, "2fa-user-b"),
  );
  await db.update(user).set({ is2FaEnabled: false }).where(
    eq(user.id, "user-b"),
  );
  assertEquals(state.twoFactorRows.map((row) => row.isVerified), [
    false,
    true,
  ]);
  assertEquals(state.users.map((row) => row.is2FaEnabled), [true, false]);
});

test("a compare-and-set on a stale counter matches nothing", async () => {
  const state = twoUsers();
  const db = createMockAuthDb(state);
  const stale = await db.update(passkey).set({ counter: 9 }).where(
    and(eq(passkey.id, "pk-user-a"), eq(passkey.counter, 5)),
  ).returning({ id: passkey.id });
  assertEquals(stale, []);
  const fresh = await db.update(passkey).set({ counter: 9 }).where(
    and(eq(passkey.id, "pk-user-a"), eq(passkey.counter, 1)),
  ).returning({ id: passkey.id });
  assertEquals(fresh, [{ id: "pk-user-a" }]);
  assertEquals(state.passkeys.map((row) => row.counter), [9, 1]);
});

test("a delete removes only the matched user's rows", async () => {
  const state = twoUsers();
  const db = createMockAuthDb(state);
  await db.delete(twoFactor).where(eq(twoFactor.userId, "user-a"));
  const removed = await db.delete(passkey).where(
    and(eq(passkey.id, "pk-user-b"), eq(passkey.userId, "user-b")),
  ).returning({ id: passkey.id });
  assertEquals(state.twoFactorRows.map((row) => row.userId), ["user-b"]);
  assertEquals(removed, [{ id: "pk-user-b" }]);
  assertEquals(state.passkeys.map((row) => row.id), ["pk-user-a"]);
});

test("an unsupported WHERE shape fails loudly instead of matching everything", async () => {
  const db = createMockAuthDb(twoUsers());
  await assertRejects(() =>
    Promise.resolve(
      db.update(twoFactor).set({ isVerified: true }).where(
        or(eq(twoFactor.id, "2fa-user-a"), eq(twoFactor.id, "2fa-user-b")),
      ),
    )
  );
});
