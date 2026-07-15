import { assertEquals, assertThrows } from "jsr:@std/assert";
import { MIN_SECRET_LENGTH, parseSecretsEnv } from "./secrets.ts";
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
  const config = parseSecretsEnv(STRONG_A, undefined, "deno");
  assertEquals(config.versioned.length, 1);
  assertEquals(config.versioned[0], { version: 1, value: STRONG_A });
});

test("parses a valid plural keyring sorted descending by version", () => {
  const config = parseSecretsEnv(
    undefined,
    `1:${STRONG_A},2:${STRONG_B}`,
    "deno",
  );
  assertEquals(config.versioned.map((v) => v.version), [2, 1]);
  assertEquals(config.versioned[0].value, STRONG_B);
});

test("rejects an empty plural entry value", () => {
  assertThrows(
    () => parseSecretsEnv(undefined, `1:,2:${STRONG_A}`, "deno"),
    Error,
    "must not be empty",
  );
});

test("rejects duplicate versions in the keyring", () => {
  assertThrows(
    () => parseSecretsEnv(undefined, `1:${STRONG_A},1:${STRONG_B}`, "deno"),
    Error,
    "Duplicate secret version",
  );
});

test("rejects a non-numeric version", () => {
  assertThrows(
    () => parseSecretsEnv(undefined, `x:${STRONG_A}`, "deno"),
    Error,
    "not a positive integer",
  );
});

test("rejects a zero / non-positive version", () => {
  assertThrows(
    () => parseSecretsEnv(undefined, `0:${STRONG_A}`, "deno"),
    Error,
    "not a positive integer",
  );
});

test("rejects a too-short single secret", () => {
  assertEquals(TOO_SHORT.length < MIN_SECRET_LENGTH, true);
  assertThrows(
    () => parseSecretsEnv(TOO_SHORT, undefined, "deno"),
    Error,
    "too short",
  );
});

test("rejects a too-short plural secret", () => {
  assertThrows(
    () => parseSecretsEnv(undefined, `1:${TOO_SHORT}`, "deno"),
    Error,
    "too short",
  );
});

test("rejects missing secrets outside explicit dev mode (deno)", () => {
  withEnv(
    { TURBOPANEL_DEV_SURFACE: null, TURBOPANEL_MODE: null, TURBOPANEL_UI_MODE: null },
    () => {
      assertThrows(
        () => parseSecretsEnv(undefined, undefined, "deno"),
        Error,
        "TURBOPANEL_SECRET or TURBOPANEL_SECRETS is required",
      );
    },
  );
});

test("rejects missing secrets when TURBOPANEL_UI_MODE=static", () => {
  withEnv(
    { TURBOPANEL_DEV_SURFACE: null, TURBOPANEL_MODE: "development", TURBOPANEL_UI_MODE: "static" },
    () => {
      assertThrows(
        () => parseSecretsEnv(undefined, undefined, "deno"),
        Error,
        "required",
      );
    },
  );
});

test("always rejects missing secrets on workers regardless of dev flags", () => {
  withEnv({ TURBOPANEL_DEV_SURFACE: "1" }, () => {
    assertThrows(
      () => parseSecretsEnv(undefined, undefined, "workers"),
      Error,
      "required",
    );
  });
});

test("allows an ephemeral secret only under an explicit dev flag", () => {
  withEnv({ TURBOPANEL_DEV_SURFACE: "1" }, () => {
    const config = parseSecretsEnv(undefined, undefined, "deno");
    assertEquals(config.versioned.length, 1);
    assertEquals(config.versioned[0].value.length >= MIN_SECRET_LENGTH, true);
  });
});

test("allows an ephemeral secret under strict development mode pair", () => {
  withEnv(
    { TURBOPANEL_DEV_SURFACE: null, TURBOPANEL_MODE: "development", TURBOPANEL_UI_MODE: "dev" },
    () => {
      const config = parseSecretsEnv(undefined, undefined, "deno");
      assertEquals(config.versioned.length, 1);
    },
  );
});
