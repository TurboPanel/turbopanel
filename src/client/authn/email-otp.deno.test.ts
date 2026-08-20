import { assertEquals } from "@std/assert";
import {
  deriveOtpVerifier,
  generateOtp,
  hashEmailForOtp,
  OTP_VERIFIER_SECRET_PURPOSE,
  requireOtpVerifierSecrets,
  verifyOtpVerifier,
} from "./email-otp.ts";
import { deriveSecretsConfig } from "./secrets.ts";
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts';

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function otpVerifierSecrets() {
  const config = parseTestSecretsConfig("deno");
  return deriveSecretsConfig(config, OTP_VERIFIER_SECRET_PURPOSE);
}

test("generateOtp returns the requested length of decimal digits", () => {
  const otp = generateOtp(6);
  assertEquals(otp.length, 6);
  assertEquals(/^\d{6}$/.test(otp), true);
  assertEquals(generateOtp(8).length, 8);
});

test("hashEmailForOtp normalizes case and whitespace", async () => {
  const lower = await hashEmailForOtp("  User@Example.COM  ");
  const exact = await hashEmailForOtp("user@example.com");
  assertEquals(lower, exact);
  assertEquals(/^[0-9a-f]{64}$/.test(lower), true);
});

test("deriveOtpVerifier and verifyOtpVerifier round-trip with rotation fallbacks", async () => {
  const secrets = await otpVerifierSecrets();
  const emailHash = await hashEmailForOtp("otp@example.com");
  const otp = "123456";
  const stored = await deriveOtpVerifier("sign-in", emailHash, otp, secrets);
  assertEquals(stored.startsWith(`tpotp.v${secrets.current.version}.`), true);
  assertEquals(
    await verifyOtpVerifier("sign-in", emailHash, otp, stored, secrets),
    true,
  );
  assertEquals(
    await verifyOtpVerifier("sign-in", emailHash, "000000", stored, secrets),
    false,
  );
  assertEquals(
    await verifyOtpVerifier("sign-in", emailHash, otp, "not-a-verifier", secrets),
    false,
  );
  assertEquals(
    await verifyOtpVerifier("sign-in", emailHash, otp, "tpotp.v0.deadbeef", secrets),
    false,
  );
  // Old v1.<hex> shape must be rejected (no back-compat).
  assertEquals(
    await verifyOtpVerifier("sign-in", emailHash, otp, "v1.deadbeef", secrets),
    false,
  );
  assertEquals(
    await verifyOtpVerifier(
      "sign-in",
      emailHash,
      otp,
      "tpotp.v1.not-hex-!!!!",
      secrets,
    ),
    false,
  );
});

test("requireOtpVerifierSecrets fails closed without a keyring", () => {
  try {
    requireOtpVerifierSecrets(undefined);
    throw new Error("expected requireOtpVerifierSecrets to throw");
  } catch (err) {
    assertEquals(err instanceof Error, true);
    assertEquals(
      (err as Error).message.includes("OTP verifier secrets are required"),
      true,
    );
  }
});
