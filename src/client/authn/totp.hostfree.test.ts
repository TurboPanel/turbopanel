import { assertEquals } from "@std/assert";
import {
  buildOtpAuthUri,
  decodeBase32,
  encodeBase32,
  generateTotp,
  generateTotpSecret,
  TOTP_ISSUER,
  verifyTotp,
} from "./totp.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** RFC 6238 Appendix B SHA-1 shared secret (ASCII `12345678901234567890`). */
const RFC6238_SECRET = new TextEncoder().encode("12345678901234567890");

test("encodeBase32 of the RFC 6238 SHA-1 secret is unpadded", () => {
  assertEquals(
    encodeBase32(RFC6238_SECRET),
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  );
});

test("decodeBase32 round-trips the RFC 6238 secret", () => {
  const decoded = decodeBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assertEquals(Array.from(decoded), Array.from(RFC6238_SECRET));
});

test("generateTotp matches RFC 6238 Appendix B SHA-1 8-digit vectors", async () => {
  const vectors: Array<{ unixSeconds: number; code: string }> = [
    { unixSeconds: 59, code: "94287082" },
    { unixSeconds: 1111111109, code: "07081804" },
    { unixSeconds: 1111111111, code: "14050471" },
    { unixSeconds: 1234567890, code: "89005924" },
    { unixSeconds: 2000000000, code: "69279037" },
    { unixSeconds: 20000000000, code: "65353130" },
  ];
  for (const vector of vectors) {
    const code = await generateTotp(RFC6238_SECRET, {
      unixSeconds: vector.unixSeconds,
      digits: 8,
    });
    assertEquals(code, vector.code);
  }
});

test("verifyTotp accepts a current 6-digit code and rejects a wrong one", async () => {
  const secret = decodeBase32(generateTotpSecret());
  const now = Math.floor(Date.now() / 1000);
  const code = await generateTotp(secret, { unixSeconds: now });
  assertEquals(await verifyTotp(secret, code, now), true);
  assertEquals(await verifyTotp(secret, "000000", now), false);
});

test("verifyTotp accepts the previous and next 30-second step", async () => {
  const secret = decodeBase32(generateTotpSecret());
  const now = Math.floor(Date.now() / 1000);
  const previous = await generateTotp(secret, { unixSeconds: now - 30 });
  const next = await generateTotp(secret, { unixSeconds: now + 30 });
  assertEquals(await verifyTotp(secret, previous, now), true);
  assertEquals(await verifyTotp(secret, next, now), true);
});

test("buildOtpAuthUri uses TurboPanel issuer and SHA1 parameters", () => {
  const uri = buildOtpAuthUri("User@Example.com", "MFRGGZDF");
  assertEquals(
    uri.startsWith(
      `otpauth://totp/${
        encodeURIComponent(`${TOTP_ISSUER}:user@example.com`)
      }?`,
    ),
    true,
  );
  assertEquals(uri.includes("issuer=TurboPanel"), true);
  assertEquals(uri.includes("algorithm=SHA1"), true);
  assertEquals(uri.includes("digits=6"), true);
  assertEquals(uri.includes("period=30"), true);
});
