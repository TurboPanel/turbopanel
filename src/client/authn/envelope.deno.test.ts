import { assertEquals } from "jsr:@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  ENVELOPE_PREFIX_DAEMON,
  ENVELOPE_PREFIX_SECRET,
  ENVELOPE_SCHEME_CHALLENGE,
  ENVELOPE_SCHEME_DAEMON,
  ENVELOPE_SCHEME_OTP,
  ENVELOPE_SCHEME_SECRET,
  ENVELOPE_SCHEME_SESSION,
  formatEnvelope,
  hasEnvelopeScheme,
  parseEnvelope,
} from "./envelope.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

describe("formatEnvelope", () => {
  it("joins scheme, version token, and fields", () => {
    assertEquals(
      formatEnvelope(ENVELOPE_SCHEME_SECRET, 1, "payloadB64u"),
      "tpsecret.v1.payloadB64u",
    );
    assertEquals(
      formatEnvelope(ENVELOPE_SCHEME_DAEMON, 3, "serverId", "keyId", "blob"),
      "tpdaemon.v3.serverId.keyId.blob",
    );
    assertEquals(
      formatEnvelope(ENVELOPE_SCHEME_SESSION, 2, "token", "sigB64u"),
      "tpsession.v2.token.sigB64u",
    );
  });
});

describe("parseEnvelope", () => {
  it("parses tpsecret with one payload field", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret.v1.abc123", 1), {
      version: 1,
      fields: ["abc123"],
    });
  });

  it("parses tpdaemon with three fields after version", () => {
    assertEquals(
      parseEnvelope(
        ENVELOPE_SCHEME_DAEMON,
        "tpdaemon.v2.srv.key.payload",
        3,
      ),
      {
        version: 2,
        fields: ["srv", "key", "payload"],
      },
    );
  });

  it("parses tpsession and tpchallenge two-field envelopes", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SESSION, "tpsession.v1.tok.sig", 2), {
      version: 1,
      fields: ["tok", "sig"],
    });
    assertEquals(
      parseEnvelope(ENVELOPE_SCHEME_CHALLENGE, "tpchallenge.v1.payload.sig", 2),
      {
        version: 1,
        fields: ["payload", "sig"],
      },
    );
  });

  it("parses tpotp single-field verifier envelopes", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_OTP, "tpotp.v1.deadbeef", 1), {
      version: 1,
      fields: ["deadbeef"],
    });
  });

  it("rejects wrong scheme prefix", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpdaemon.v1.x", 1), null);
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_DAEMON, "tpsecret.v1.x", 3), null);
  });

  it("rejects wrong field counts", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret.v1.a.b", 1), null);
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SESSION, "tpsession.v1.only", 2), null);
  });

  it("rejects empty fields", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret.v1.", 1), null);
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_DAEMON, "tpdaemon.v1.a..c", 3), null);
  });

  it("rejects invalid version tokens", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret.v0.payload", 1), null);
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret.v01.payload", 1), null);
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret.v.payload", 1), null);
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret.vNaN.payload", 1), null);
  });

  it("rejects values that only share a prefix with the scheme", () => {
    assertEquals(parseEnvelope(ENVELOPE_SCHEME_SECRET, "tpsecret-extra.v1.x", 1), null);
  });
});

describe("hasEnvelopeScheme", () => {
  it("detects scheme prefix without validating structure", () => {
    assertEquals(hasEnvelopeScheme(ENVELOPE_SCHEME_SECRET, "tpsecret.v1.x"), true);
    assertEquals(hasEnvelopeScheme(ENVELOPE_SCHEME_SECRET, "tpsecret.not-valid"), true);
    assertEquals(hasEnvelopeScheme(ENVELOPE_SCHEME_DAEMON, "tpdaemon.v9.a.b.c"), true);
    assertEquals(hasEnvelopeScheme(ENVELOPE_SCHEME_SECRET, "tpdaemon.v1.x"), false);
    assertEquals(hasEnvelopeScheme(ENVELOPE_SCHEME_SECRET, "plaintext"), false);
  });

  it("exports stable prefix constants", () => {
    assertEquals(ENVELOPE_PREFIX_SECRET, "tpsecret.");
    assertEquals(ENVELOPE_PREFIX_DAEMON, "tpdaemon.");
  });
});

test("envelope suite loaded", () => {
  assertEquals(typeof formatEnvelope, "function");
});
