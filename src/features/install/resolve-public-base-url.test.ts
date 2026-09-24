import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../../app/app.ts";
import {
  parseInstallBaseUrl,
  resolvePublicBaseUrl,
} from "./resolve-public-base-url.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseInstallBaseUrl keeps an already valid https origin and dials :8443 for a bare host", () => {
  assertEquals(
    parseInstallBaseUrl("https://panel.example.com"),
    "https://panel.example.com",
  );
  assertEquals(
    parseInstallBaseUrl("https://turbopanel.app"),
    "https://turbopanel.app",
  );
  assertEquals(
    parseInstallBaseUrl("https://turbopanel.app:443"),
    "https://turbopanel.app",
  );
  assertEquals(
    parseInstallBaseUrl("https://panel.example.com:8443"),
    "https://panel.example.com:8443",
  );
  assertEquals(
    parseInstallBaseUrl("panel.example.com"),
    "https://panel.example.com:8443",
  );
});

test("parseInstallBaseUrl rejects plaintext http", () => {
  assertEquals(parseInstallBaseUrl("http://panel.example.com"), null);
});

test("parseInstallBaseUrl rejects paths, query strings, and shell metacharacters", () => {
  assertEquals(
    parseInstallBaseUrl("https://panel.example.com; curl http://evil"),
    null,
  );
  assertEquals(parseInstallBaseUrl("https://panel.example.com/path"), null);
  assertEquals(parseInstallBaseUrl("https://panel.example.com?x=$(id)"), null);
  assertEquals(parseInstallBaseUrl("https://panel.example.com/`whoami`"), null);
});

test("resolvePublicBaseUrl prefers opts.baseUrl over forwarded headers", async () => {
  const app = new Hono<AppEnv>();
  app.get("/t", async (c) => {
    c.set("platformEnv", {});
    return c.text(
      await resolvePublicBaseUrl(c, {
        baseUrl: "https://preferred.example.com",
      }),
    );
  });
  const res = await app.request("https://internal.invalid/t", {
    headers: {
      "x-forwarded-host": "ignored.example.com",
      "x-forwarded-proto": "https",
    },
  });
  assertEquals(await res.text(), "https://preferred.example.com");
});

test("resolvePublicBaseUrl reads TURBOPANEL_BASE_URL from platformEnv on Workers", async () => {
  const app = new Hono<AppEnv>();
  app.get("/t", async (c) => {
    c.set("platformEnv", {
      TURBOPANEL_BASE_URL: "https://workers.example.com",
    });
    return c.text(await resolvePublicBaseUrl(c));
  });
  const res = await app.request("https://internal.invalid/t");
  assertEquals(await res.text(), "https://workers.example.com");
});

test("parseInstallBaseUrl rejects blank candidates", () => {
  assertEquals(parseInstallBaseUrl(undefined), null);
  assertEquals(parseInstallBaseUrl("   "), null);
});

test("resolvePublicBaseUrl prefers Deno TURBOPANEL_BASE_URL over forwarded headers", async () => {
  const previous = Deno.env.get("TURBOPANEL_BASE_URL");
  const previousPublic = Deno.env.get("TURBOPANEL_PUBLIC_URLS");
  Deno.env.set("TURBOPANEL_BASE_URL", "https://env.example.com");
  Deno.env.delete("TURBOPANEL_PUBLIC_URLS");
  try {
    const app = new Hono<AppEnv>();
    app.get("/t", async (c) => {
      c.set("platformEnv", {});
      return c.text(await resolvePublicBaseUrl(c));
    });
    const res = await app.request("https://internal.invalid/t", {
      headers: {
        "x-forwarded-host": "ignored.example.com",
        "x-forwarded-proto": "https",
      },
    });
    assertEquals(await res.text(), "https://env.example.com");
  } finally {
    if (previous === undefined) Deno.env.delete("TURBOPANEL_BASE_URL");
    else Deno.env.set("TURBOPANEL_BASE_URL", previous);
    if (previousPublic === undefined) Deno.env.delete("TURBOPANEL_PUBLIC_URLS");
    else Deno.env.set("TURBOPANEL_PUBLIC_URLS", previousPublic);
  }
});

test("resolvePublicBaseUrl accepts https forwarded host when env is unset", async () => {
  const previousBase = Deno.env.get("TURBOPANEL_BASE_URL");
  const previousPublic = Deno.env.get("TURBOPANEL_PUBLIC_URLS");
  Deno.env.delete("TURBOPANEL_BASE_URL");
  Deno.env.delete("TURBOPANEL_PUBLIC_URLS");
  try {
    const app = new Hono<AppEnv>();
    app.get("/t", async (c) => {
      c.set("platformEnv", {});
      return c.text(await resolvePublicBaseUrl(c));
    });
    const res = await app.request("https://internal.invalid/t", {
      headers: {
        "x-forwarded-host": "edge.example.com",
        "x-forwarded-proto": "https",
      },
    });
    assertEquals(await res.text(), "https://edge.example.com");
  } finally {
    if (previousBase === undefined) Deno.env.delete("TURBOPANEL_BASE_URL");
    else Deno.env.set("TURBOPANEL_BASE_URL", previousBase);
    if (previousPublic === undefined) Deno.env.delete("TURBOPANEL_PUBLIC_URLS");
    else Deno.env.set("TURBOPANEL_PUBLIC_URLS", previousPublic);
  }
});

test("resolvePublicBaseUrl uses TURBOPANEL_PUBLIC_URLS first entry when set", async () => {
  const previousBase = Deno.env.get("TURBOPANEL_BASE_URL");
  const previousPublic = Deno.env.get("TURBOPANEL_PUBLIC_URLS");
  Deno.env.delete("TURBOPANEL_BASE_URL");
  Deno.env.set(
    "TURBOPANEL_PUBLIC_URLS",
    "https://public.example.com,https://secondary.example.com",
  );
  try {
    const app = new Hono<AppEnv>();
    app.get("/t", async (c) => {
      c.set("platformEnv", {});
      return c.text(await resolvePublicBaseUrl(c));
    });
    const res = await app.request("https://internal.invalid/t");
    assertEquals(await res.text(), "https://public.example.com");
  } finally {
    if (previousBase === undefined) Deno.env.delete("TURBOPANEL_BASE_URL");
    else Deno.env.set("TURBOPANEL_BASE_URL", previousBase);
    if (previousPublic === undefined) Deno.env.delete("TURBOPANEL_PUBLIC_URLS");
    else Deno.env.set("TURBOPANEL_PUBLIC_URLS", previousPublic);
  }
});

test("resolvePublicBaseUrl dials :8443 for a bare stored hostname", async () => {
  const previousBase = Deno.env.get("TURBOPANEL_BASE_URL");
  const previousPublic = Deno.env.get("TURBOPANEL_PUBLIC_URLS");
  Deno.env.delete("TURBOPANEL_BASE_URL");
  Deno.env.set("TURBOPANEL_PUBLIC_URLS", "panel.lan");
  try {
    const app = new Hono<AppEnv>();
    app.get("/t", async (c) => {
      c.set("platformEnv", {});
      return c.text(await resolvePublicBaseUrl(c));
    });
    const res = await app.request("https://internal.invalid/t");
    assertEquals(await res.text(), "https://panel.lan:8443");
  } finally {
    if (previousBase === undefined) Deno.env.delete("TURBOPANEL_BASE_URL");
    else Deno.env.set("TURBOPANEL_BASE_URL", previousBase);
    if (previousPublic === undefined) Deno.env.delete("TURBOPANEL_PUBLIC_URLS");
    else Deno.env.set("TURBOPANEL_PUBLIC_URLS", previousPublic);
  }
});
