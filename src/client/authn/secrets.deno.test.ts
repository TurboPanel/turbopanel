import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { stub } from "@std/testing/mock";
import {
  deriveEncryptionSecretsConfig,
  deriveKey,
  deriveSecretsConfig,
  MIN_SECRET_LENGTH,
  parseSecretsEnv,
  parseSecretsFromEnv,
} from "./secrets.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";

const STRONG_A = TEST_ONLY_TURBOPANEL_SECRET;
const STRONG_B = "Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7";
const TOO_SHORT = "abc123_short";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} so Sonar (typescript:S2187)
 * recognizes these as real suites.
 */
const test = Deno.test.bind(Deno);

const DEV_ENV_KEYS = [
  "TURBOPANEL_DEV_SURFACE",
  "TURBOPANEL_MODE",
  "TURBOPANEL_UI_MODE",
] as const;

function withEnv(
  overrides: Partial<Record<(typeof DEV_ENV_KEYS)[number], string | null>>,
  fn: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const key of DEV_ENV_KEYS) {
    saved.set(key, Deno.env.get(key));
  }
  try {
    for (const key of DEV_ENV_KEYS) {
      const value = overrides[key];
      if (value === undefined) {
        Deno.env.delete(key);
      } else if (value === null) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

test("parses a valid single secret at version 1", () => {
  const config = parseSecretsEnv(`1:${STRONG_A}`, "deno");
  assertEquals(config.versioned.length, 1);
  assertEquals(config.versioned[0], { version: 1, value: STRONG_A });
});

test("parses a valid plural keyring keeping written order (descending)", () => {
  const config = parseSecretsEnv(`2:${STRONG_B},1:${STRONG_A}`, "deno");
  assertEquals(config.versioned.map((v) => v.version), [2, 1]);
  assertEquals(config.versioned[0].value, STRONG_B);
});

test("keeps non-descending keyring order without throwing and warns (first entry is current)", () => {
  const writes: string[] = [];
  const writeStub = stub(Deno.stderr, "writeSync", (data: Uint8Array) => {
    writes.push(new TextDecoder().decode(data));
    return data.byteLength;
  });
  try {
    const config = parseSecretsEnv(`1:${STRONG_A},2:${STRONG_B}`, "deno");
    assertEquals(config.versioned.length, 2);
    assertEquals(config.versioned[0], { version: 1, value: STRONG_A });
    assertEquals(config.versioned[1], { version: 2, value: STRONG_B });
    const authWarns = writes.filter((line) => line.includes(" WARN auth"));
    assertEquals(authWarns.length, 1);
    assertEquals(
      authWarns[0]?.includes(
        "TURBOPANEL_SECRETS entries are not listed in descending version order",
      ),
      true,
    );
    assertEquals(
      authWarns[0]?.includes(
        "the first entry is treated as current — list highest version first",
      ),
      true,
    );
  } finally {
    writeStub.restore();
  }
});

test("accepts gapped descending versions without warning", () => {
  const writes: string[] = [];
  const writeStub = stub(Deno.stderr, "writeSync", (data: Uint8Array) => {
    writes.push(new TextDecoder().decode(data));
    return data.byteLength;
  });
  try {
    const config = parseSecretsEnv(`3:${STRONG_A},1:${STRONG_B}`, "deno");
    assertEquals(config.versioned.map((v) => v.version), [3, 1]);
    assertEquals(config.versioned[0].version, 3);
    assertEquals(config.versioned[0].value, STRONG_A);
    const authWarns = writes.filter((line) => line.includes(" WARN auth"));
    assertEquals(authWarns.length, 0);
  } finally {
    writeStub.restore();
  }
});

test("rejects an empty plural entry value", () => {
  assertThrows(
    () => parseSecretsEnv(`1:,2:${STRONG_A}`, "deno"),
    Error,
    "must not be empty",
  );
});

test("rejects duplicate versions in the keyring", () => {
  assertThrows(
    () => parseSecretsEnv(`1:${STRONG_A},1:${STRONG_B}`, "deno"),
    Error,
    "Duplicate secret version",
  );
});

test("rejects a non-numeric version", () => {
  assertThrows(
    () => parseSecretsEnv(`x:${STRONG_A}`, "deno"),
    Error,
    "not a positive integer",
  );
});

test("rejects a zero / non-positive version", () => {
  assertThrows(
    () => parseSecretsEnv(`0:${STRONG_A}`, "deno"),
    Error,
    "not a positive integer",
  );
});

test("rejects a too-short single secret", () => {
  assertEquals(TOO_SHORT.length < MIN_SECRET_LENGTH, true);
  assertThrows(
    () => parseSecretsEnv(`1:${TOO_SHORT}`, "deno"),
    Error,
    "too short",
  );
});

test("rejects a too-short plural secret", () => {
  assertThrows(
    () => parseSecretsEnv(`1:${TOO_SHORT}`, "deno"),
    Error,
    "too short",
  );
});

test("rejects missing secrets outside explicit dev mode (deno)", () => {
  withEnv(
    { TURBOPANEL_DEV_SURFACE: null, TURBOPANEL_MODE: null, TURBOPANEL_UI_MODE: null },
    () => {
      assertThrows(
        () => parseSecretsEnv(undefined, "deno"),
        Error,
        "TURBOPANEL_SECRET is required",
      );
    },
  );
});

test("rejects missing secrets when TURBOPANEL_UI_MODE=static", () => {
  withEnv(
    { TURBOPANEL_DEV_SURFACE: null, TURBOPANEL_MODE: "development", TURBOPANEL_UI_MODE: "static" },
    () => {
      assertThrows(
        () => parseSecretsEnv(undefined, "deno"),
        Error,
        "required",
      );
    },
  );
});

test("always rejects missing secrets on workers regardless of dev flags", () => {
  withEnv({ TURBOPANEL_DEV_SURFACE: "1" }, () => {
    assertThrows(
      () => parseSecretsEnv(undefined, "workers"),
      Error,
      "required",
    );
  });
});

test("allows an ephemeral secret only under an explicit dev flag", () => {
  withEnv({ TURBOPANEL_DEV_SURFACE: "1" }, () => {
    const config = parseSecretsEnv(undefined, "deno");
    assertEquals(config.versioned.length, 1);
    assertEquals(config.versioned[0].value.length >= MIN_SECRET_LENGTH, true);
  });
});

test("allows an ephemeral secret under strict development mode pair", () => {
  withEnv(
    { TURBOPANEL_DEV_SURFACE: null, TURBOPANEL_MODE: "development", TURBOPANEL_UI_MODE: "dev" },
    () => {
      const config = parseSecretsEnv(undefined, "deno");
      assertEquals(config.versioned.length, 1);
    },
  );
});

test("rejects a keyring entry without a version separator", () => {
  assertThrows(
    () => parseSecretsEnv(STRONG_A, "deno"),
    Error,
    'expected "version:secret"',
  );
});

test("parseSecretsFromEnv treats TURBOPANEL_SECRET as version 1", () => {
  const config = parseSecretsFromEnv({ TURBOPANEL_SECRET: STRONG_A }, "workers");
  assertEquals(config.versioned, [{ version: 1, value: STRONG_A }]);
});

test("parseSecretsFromEnv uses TURBOPANEL_SECRETS as the full keyring when set", () => {
  const config = parseSecretsFromEnv(
    { TURBOPANEL_SECRET: STRONG_A, TURBOPANEL_SECRETS: `2:${STRONG_B},1:${STRONG_A}` },
    "workers",
  );
  assertEquals(config.versioned.map((v) => v.version), [2, 1]);
  assertEquals(config.versioned[0].value, STRONG_B);
});

test("parseSecretsFromEnv ignores empty TURBOPANEL_SECRETS and uses TURBOPANEL_SECRET", () => {
  const config = parseSecretsFromEnv(
    { TURBOPANEL_SECRET: STRONG_A, TURBOPANEL_SECRETS: "  " },
    "workers",
  );
  assertEquals(config.versioned, [{ version: 1, value: STRONG_A }]);
});

test("parseSecretsFromEnv rejects a too-short TURBOPANEL_SECRET", () => {
  assertThrows(
    () => parseSecretsFromEnv({ TURBOPANEL_SECRET: TOO_SHORT }, "workers"),
    Error,
    "too short",
  );
});

test("parseSecretsFromEnv requires TURBOPANEL_SECRET on workers when neither var is set", () => {
  assertThrows(
    () => parseSecretsFromEnv({}, "workers"),
    Error,
    "TURBOPANEL_SECRET is required",
  );
});

test("deriveKey produces an HMAC key that signs and verifies", async () => {
  const mac = await deriveKey(STRONG_A, "test-purpose");
  const data = new TextEncoder().encode("payload");
  const sig = await crypto.subtle.sign("HMAC", mac, data);
  assertEquals(await crypto.subtle.verify("HMAC", mac, sig, data), true);
});

test("deriveSecretsConfig orders current and fallbacks by version", async () => {
  const config = parseSecretsEnv(`2:${STRONG_B},1:${STRONG_A}`, "deno");
  const derived = await deriveSecretsConfig(config, "session-signing");
  assertEquals(derived.current.version, 2);
  assertEquals(derived.fallbacks.length, 1);
  assertEquals(derived.fallbacks[0]?.version, 1);
});

test("deriveEncryptionSecretsConfig derives AES-GCM keys", async () => {
  const config = parseSecretsEnv(`1:${STRONG_A}`, "deno");
  const derived = await deriveEncryptionSecretsConfig(config, "data-encryption");
  assertEquals(derived.current.version, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    derived.current.key,
    new TextEncoder().encode("secret"),
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    derived.current.key,
    ciphertext,
  );
  assertEquals(new TextDecoder().decode(plaintext), "secret");
});

test("deriveSecretsConfig rejects an empty versioned list", async () => {
  await assertRejects(
    () => deriveSecretsConfig({ versioned: [] }, "session-signing"),
    Error,
    "No signing secret available",
  );
});
