import { assertEquals } from "@std/assert";
import {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_VERSION,
  assertPasswordHasherAvailable,
  configureArgon2idWorkFactor,
  getArgon2idPolicy,
  hashPassword,
  verifyPassword,
} from "./password.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} so Sonar (typescript:S2187)
 * recognizes these as real suites.
 */
const test = Deno.test.bind(Deno);

/**
 * These hashes are NFKC-normalized Argon2id (`@noble/hashes`, pure-TS, no WASM)
 * shared by account passwords and license tokens, per the pre-MVP hard cutover.
 */
function phcParams(
  encoded: string,
): { m: number; t: number; p: number; v: number } {
  const parts = encoded.split("$");
  const version = Number.parseInt(parts[2]!.slice(2), 10);
  const params = Object.fromEntries(
    parts[3]!.split(",").map((token) => {
      const eq = token.indexOf("=");
      return [token.slice(0, eq), token.slice(eq + 1)];
    }),
  );
  return {
    v: version,
    m: Number.parseInt(params.m!, 10),
    t: Number.parseInt(params.t!, 10),
    p: Number.parseInt(params.p!, 10),
  };
}

test("hashPassword emits Argon2id PHC at the OWASP baseline", async () => {
  const encoded = await hashPassword("pw");
  assertEquals(encoded.startsWith("$argon2id$"), true);
  assertEquals(phcParams(encoded), {
    v: ARGON2ID_VERSION,
    m: ARGON2ID_MEMORY_KIB,
    t: ARGON2ID_ITERATIONS,
    p: ARGON2ID_PARALLELISM,
  });
});

test("OWASP floor guard: emitted params and policy stay at/above baseline", async () => {
  const encoded = await hashPassword("pw");
  const params = phcParams(encoded);
  assertEquals(params.m >= ARGON2ID_MEMORY_KIB, true);
  assertEquals(params.t >= ARGON2ID_ITERATIONS, true);
  assertEquals(params.p, ARGON2ID_PARALLELISM);

  const policy = getArgon2idPolicy();
  assertEquals(policy.memoryKib >= ARGON2ID_MEMORY_KIB, true);
  assertEquals(policy.iterations >= ARGON2ID_ITERATIONS, true);
  assertEquals(policy.parallelism, ARGON2ID_PARALLELISM);
  assertEquals(policy.version, ARGON2ID_VERSION);
});

test("verifyPassword accepts the correct password and rejects wrong ones", async () => {
  const encoded = await hashPassword("correct horse");
  assertEquals(await verifyPassword("correct horse", encoded), true);
  assertEquals(await verifyPassword("wrong", encoded), false);
});

test("verifyPassword applies NFKC normalization", async () => {
  // U+FB01 LATIN SMALL LIGATURE FI → "fi" under NFKC (not NFC alone).
  const ligatureEncoded = await hashPassword("ﬁle");
  assertEquals(await verifyPassword("file", ligatureEncoded), true);

  // Composed vs decomposed accent (Café).
  const composedEncoded = await hashPassword("Caf\u00e9");
  assertEquals(await verifyPassword("Cafe\u0301", composedEncoded), true);
});

/** 16-byte salt + 32-byte digest (PHC unpadded base64), digest is filler only. */
const PHC_SALT_B64 = "c2FsdHNhbHRzYWx0c2FsdA"; // "saltsaltsaltsalt"
const PHC_DIGEST_B64 = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE"; // 32× "a"

test("verifyPassword rejects wrong-algorithm tags and malformed hashes", async () => {
  assertEquals(await verifyPassword("pw", "garbage"), false);
  // Wrong Argon2 variant / non-argon2id tags must fail closed.
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2i$v=19$m=19456,t=2,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$scrypt$ln=16,r=8,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  // Partial numeric params must not parse (`Number.parseInt` would accept these).
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456junk,t=2,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=2.9,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  // Undersized salt (12 bytes) must fail closed.
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  // Unknown / duplicate parameter names.
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=2,p=1,key=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,m=19456,t=2$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  // Above documented verification caps — fail closed, never throw.
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=999999,t=2,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
});

test("configureArgon2idWorkFactor is raise-only and clamps to verification caps", () => {
  configureArgon2idWorkFactor({ memoryKib: null, timeCost: null });
  assertEquals(getArgon2idPolicy(), {
    memoryKib: ARGON2ID_MEMORY_KIB,
    iterations: ARGON2ID_ITERATIONS,
    parallelism: ARGON2ID_PARALLELISM,
    version: ARGON2ID_VERSION,
  });

  configureArgon2idWorkFactor({ memoryKib: "abc", timeCost: "1" });
  assertEquals(getArgon2idPolicy().memoryKib, ARGON2ID_MEMORY_KIB);
  assertEquals(getArgon2idPolicy().iterations, ARGON2ID_ITERATIONS);

  configureArgon2idWorkFactor({
    memoryKib: String(ARGON2ID_MEMORY_KIB + 1024),
    timeCost: "4",
  });
  assertEquals(getArgon2idPolicy().memoryKib, ARGON2ID_MEMORY_KIB + 1024);
  assertEquals(getArgon2idPolicy().iterations, 4);

  configureArgon2idWorkFactor({ memoryKib: "999999", timeCost: "99" });
  assertEquals(getArgon2idPolicy().memoryKib, 65_536);
  assertEquals(getArgon2idPolicy().iterations, 16);

  configureArgon2idWorkFactor({ memoryKib: null, timeCost: null });
});

test("assertPasswordHasherAvailable completes the hash+verify self-test", async () => {
  configureArgon2idWorkFactor({ memoryKib: null, timeCost: null });
  await assertPasswordHasherAvailable();
});

test("verifyPassword rejects additional malformed PHC branches", async () => {
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=18$m=19456,t=2,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=17,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=2,p=5$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=2,p=1$${PHC_SALT_B64}$invalid-chars!`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=2,p=1$${PHC_SALT_B64}$not-valid-base64!!!`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$m=19456,t=2,p=1$${PHC_SALT_B64}$c2FsdHNhbHRzYWx0c2FsdA`,
    ),
    false,
  );
  assertEquals(
    await verifyPassword(
      "pw",
      `$argon2id$v=19$=19456,t=2,p=1$${PHC_SALT_B64}$${PHC_DIGEST_B64}`,
    ),
    false,
  );
});
