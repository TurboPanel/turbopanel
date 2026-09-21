/**
 * The baseline security headers the app sets itself, on both runtimes —
 * the guarantee that does not depend on Caddy, a reverse proxy an operator
 * chose, or a Cloudflare zone setting outside this repository.
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import {
  HSTS_HEADER,
  HSTS_VALUE,
  isSecureRequest,
  isWebSocketUpgradeRequest,
  registerSecurityHeaders,
  SECURITY_HEADERS,
} from "./security-headers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  registerSecurityHeaders(app);
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/boom", () => {
    // A route that refuses still gets the headers — the interesting case is
    // the error response, which is exactly what an attacker aims at.
    return new Response("no", { status: 403 });
  });
  return app;
}

test("every response carries the baseline headers, including refusals", async () => {
  const app = buildApp();
  for (const path of ["/ok", "/boom"]) {
    const res = await app.request(`https://panel.example.com${path}`);
    for (const [name, value] of SECURITY_HEADERS) {
      assertEquals(res.headers.get(name), value, `${path} ${name}`);
    }
  }
});

test("HSTS rides https and is left off plaintext", async () => {
  const app = buildApp();
  const secure = await app.request("https://panel.example.com/ok");
  assertEquals(secure.headers.get(HSTS_HEADER), HSTS_VALUE);

  // The co-located dev surface is deliberately plain http; HSTS there is
  // meaningless to a browser and misleading in a capture.
  const plain = await app.request("http://localhost:8880/ok");
  assertEquals(plain.headers.get(HSTS_HEADER), null);
  // The rest still apply.
  assertEquals(plain.headers.get("X-Frame-Options"), "DENY");

  // Behind a TLS-terminating proxy the request URL is the internal one.
  const proxied = await app.request("http://localhost:8880/ok", {
    headers: { "x-forwarded-proto": "https" },
  });
  assertEquals(proxied.headers.get(HSTS_HEADER), HSTS_VALUE);
});

test("isSecureRequest reads the proxy declaration first, then the URL", () => {
  assertEquals(isSecureRequest("https://panel.example.com/x"), true);
  assertEquals(isSecureRequest("http://localhost:8880/x"), false);
  assertEquals(isSecureRequest("http://localhost:8880/x", "https"), true);
  // A proxy chain lists the client-facing protocol first.
  assertEquals(isSecureRequest("http://localhost:8880/x", "https, http"), true);
  assertEquals(isSecureRequest("https://panel.example.com/x", "http"), false);
  assertEquals(isSecureRequest("not a url"), false);
  assertEquals(isSecureRequest("not a url", "https"), true);
});

test("clickjacking is refused to old and new browsers alike", () => {
  const byName = new Map(SECURITY_HEADERS);
  assertEquals(byName.get("X-Frame-Options"), "DENY");
  assertEquals(byName.get("Content-Security-Policy"), "frame-ancestors 'none'");
});

test("isWebSocketUpgradeRequest matches the handshake header only", () => {
  assertEquals(isWebSocketUpgradeRequest("websocket"), true);
  assertEquals(isWebSocketUpgradeRequest(" Websocket "), true);
  assertEquals(isWebSocketUpgradeRequest("h2c"), false);
  assertEquals(isWebSocketUpgradeRequest(undefined), false);
});

test("websocket upgrades skip document security headers and still return 101", async () => {
  const app = new Hono<AppEnv>();
  registerSecurityHeaders(app);
  app.get("/ws", () =>
    new Response(null, {
      status: 101,
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    })
  );
  const res = await app.request("https://panel.example.com/ws", {
    headers: { upgrade: "websocket", connection: "Upgrade" },
  });
  assertEquals(res.status, 101);
  assertEquals(res.headers.get("X-Frame-Options"), null);
  assertEquals(res.headers.get(HSTS_HEADER), null);
});
