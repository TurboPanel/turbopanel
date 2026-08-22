import { assertEquals } from "@std/assert";
import { isDeveloperSurfaceEnabled, isExplicitDevelopmentMode } from "./dev-mode.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} so Sonar (typescript:S2187)
 * recognizes these as real suites.
 */
const test = Deno.test.bind(Deno);

const KEYS = [
  "TURBOPANEL_DEV_SURFACE",
  "TURBOPANEL_MODE",
  "TURBOPANEL_UI_MODE",
] as const;

function withEnv(
  overrides: Partial<Record<(typeof KEYS)[number], string>>,
  fn: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) saved.set(key, Deno.env.get(key));
  try {
    for (const key of KEYS) {
      const value = overrides[key];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

test("disabled when all flags are unset", () => {
  withEnv({}, () => {
    assertEquals(isDeveloperSurfaceEnabled(), false);
    assertEquals(isExplicitDevelopmentMode(), false);
  });
});

test("disabled for production static UI mode", () => {
  withEnv({ TURBOPANEL_UI_MODE: "static" }, () => {
    assertEquals(isDeveloperSurfaceEnabled(), false);
  });
});

test("disabled for TURBOPANEL_UI_MODE=dev without TURBOPANEL_MODE=development", () => {
  withEnv({ TURBOPANEL_UI_MODE: "dev" }, () => {
    assertEquals(isDeveloperSurfaceEnabled(), false);
  });
});

test("enabled for the strict development + dev pair", () => {
  withEnv(
    { TURBOPANEL_MODE: "development", TURBOPANEL_UI_MODE: "dev" },
    () => {
      assertEquals(isDeveloperSurfaceEnabled(), true);
    },
  );
});

test("enabled via explicit TURBOPANEL_DEV_SURFACE=1", () => {
  withEnv({ TURBOPANEL_DEV_SURFACE: "1", TURBOPANEL_UI_MODE: "static" }, () => {
    assertEquals(isDeveloperSurfaceEnabled(), true);
  });
});

test("case-insensitive mode values still enable the strict pair", () => {
  withEnv(
    { TURBOPANEL_MODE: "Development", TURBOPANEL_UI_MODE: "DEV" },
    () => {
      assertEquals(isDeveloperSurfaceEnabled(), true);
    },
  );
});

test("disabled for malformed dev-surface / mode values", () => {
  withEnv({ TURBOPANEL_DEV_SURFACE: "yes" }, () => {
    assertEquals(isDeveloperSurfaceEnabled(), false);
  });
  withEnv({ TURBOPANEL_DEV_SURFACE: "true" }, () => {
    assertEquals(isDeveloperSurfaceEnabled(), false);
  });
  withEnv({ TURBOPANEL_MODE: "prod", TURBOPANEL_UI_MODE: "dev" }, () => {
    assertEquals(isDeveloperSurfaceEnabled(), false);
  });
  withEnv({ TURBOPANEL_MODE: "development", TURBOPANEL_UI_MODE: "development" }, () => {
    assertEquals(isDeveloperSurfaceEnabled(), false);
  });
});
