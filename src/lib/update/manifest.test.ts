import { assertEquals } from "jsr:@std/assert";
import {
  resetTrunkManifestCacheForTests,
  resolveTrunkManifest,
} from "./manifest.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("resolveTrunkManifest coalesces concurrent lookups", async () => {
  resetTrunkManifestCacheForTests();
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCount += 1;
    const url = String(input);
    if (url.endsWith("/channels.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            channels: {
              trunk: {
                manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
              },
            },
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/channels/trunk/manifest.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            commit: "abc123",
            buildId: "build-1",
            builtAt: "2020-01-01T00:00:00.000Z",
            channel: "trunk",
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input);
  }) as typeof fetch;

  try {
    const [first, second] = await Promise.all([
      resolveTrunkManifest(),
      resolveTrunkManifest(),
    ]);
    assertEquals(first?.commit, "abc123");
    assertEquals(second?.commit, "abc123");
    assertEquals(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetTrunkManifestCacheForTests();
  }
});

test("resolveTrunkManifest reuses cached manifest within TTL", async () => {
  resetTrunkManifestCacheForTests();
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCount += 1;
    const url = String(input);
    if (url.endsWith("/channels.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            channels: {
              trunk: {
                manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
              },
            },
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/channels/trunk/manifest.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            commit: "cached-commit",
            buildId: "build-1",
            builtAt: "2020-01-01T00:00:00.000Z",
            channel: "trunk",
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input);
  }) as typeof fetch;

  try {
    const first = await resolveTrunkManifest();
    const second = await resolveTrunkManifest();
    assertEquals(first?.commit, "cached-commit");
    assertEquals(second?.commit, "cached-commit");
    assertEquals(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetTrunkManifestCacheForTests();
  }
});
