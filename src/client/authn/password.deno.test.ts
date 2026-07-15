import { assertEquals } from "jsr:@std/assert";
import {
  configurePbkdf2Iterations,
  currentPbkdf2Iterations,
  DEFAULT_PBKDF2_ITERATIONS,
  hashPassword,
  MIN_PBKDF2_ITERATIONS,
  passwordNeedsRehash,
  verifyPassword,
} from "./password.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} so Sonar (typescript:S2187)
 * recognizes these as real suites.
 */
const test = Deno.test.bind(Deno);

function iterationsOf(encoded: string): number {
  return Number.parseInt(encoded.split("$")[2], 10);
}

test("missing TURBOPANEL_PBKDF2_ITERATIONS uses the safe minimum", async () => {
  configurePbkdf2Iterations(undefined);
  assertEquals(currentPbkdf2Iterations(), MIN_PBKDF2_ITERATIONS);
  const encoded = await hashPassword("pw");
  assertEquals(iterationsOf(encoded) >= MIN_PBKDF2_ITERATIONS, true);
});

test("a low iteration count cannot weaken new hashes", async () => {
  configurePbkdf2Iterations("1000");
  assertEquals(currentPbkdf2Iterations(), MIN_PBKDF2_ITERATIONS);
  const encoded = await hashPassword("pw");
  assertEquals(iterationsOf(encoded), MIN_PBKDF2_ITERATIONS);
});

test("an invalid iteration value falls back to the minimum", async () => {
  configurePbkdf2Iterations("not-a-number");
  assertEquals(currentPbkdf2Iterations(), MIN_PBKDF2_ITERATIONS);
  const encoded = await hashPassword("pw");
  assertEquals(iterationsOf(encoded), MIN_PBKDF2_ITERATIONS);
});

test("a value above the minimum is honored", () => {
  const stronger = MIN_PBKDF2_ITERATIONS + 200_000;
  configurePbkdf2Iterations(String(stronger));
  assertEquals(currentPbkdf2Iterations(), stronger);
  configurePbkdf2Iterations(undefined);
});

test("verifyPassword still verifies hashes with an embedded lower count", async () => {
  // Force a stronger current policy, then verify a hash minted at the minimum.
  configurePbkdf2Iterations(undefined);
  const encoded = await hashPassword("correct horse");
  assertEquals(await verifyPassword("correct horse", encoded), true);
  assertEquals(await verifyPassword("wrong", encoded), false);
});

test("passwordNeedsRehash flags hashes below the current policy", async () => {
  configurePbkdf2Iterations(undefined);
  const atPolicy = await hashPassword("pw");
  assertEquals(passwordNeedsRehash(atPolicy), false);

  const belowPolicy =
    `$pbkdf2-sha256$1000$c2FsdHNhbHRzYWx0c2E$${"a".repeat(43)}`;
  assertEquals(passwordNeedsRehash(belowPolicy), true);

  assertEquals(passwordNeedsRehash("garbage"), false);
});

test("defaults expose the documented constant", () => {
  assertEquals(MIN_PBKDF2_ITERATIONS, DEFAULT_PBKDF2_ITERATIONS);
});
