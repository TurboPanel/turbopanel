import { assertEquals } from "@std/assert";
import {
  resetUpdateManifestCacheForTests,
  resolveUpdateManifest,
  seedUpdateManifestCacheForTests,
  setUpdateManifestProvider,
} from "./manifest.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const TRUNK_MANIFEST_URL = "https://dl.trbp.nl/channels/trunk/manifest.json";
const RC_MANIFEST_URL =
  "https://github.com/TurboPanel/turbopaneld/releases/download/rc/manifest.json";
const RELEASE_MANIFEST_URL =
  "https://github.com/TurboPanel/turbopaneld/releases/latest/download/manifest.json";

function manifestBody(channel: string, commit = "abc123") {
  return JSON.stringify({
    commit,
    buildId: `build-${commit}`,
    builtAt: "2020-01-01T00:00:00.000Z",
    channel,
  });
}

/** Install a fetch stub and return the URLs it was asked for. */
function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("resolveUpdateManifest reads the built-in rail with one fetch — no channels.json hop", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch((url) =>
    url === TRUNK_MANIFEST_URL
      ? new Response(manifestBody("trunk"), { status: 200 })
      : new Response("missing", { status: 404 })
  );
  try {
    const manifest = await resolveUpdateManifest("trunk");
    assertEquals(manifest, {
      commit: "abc123",
      buildId: "build-abc123",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: TRUNK_MANIFEST_URL,
    });
    assertEquals(stub.calls, [TRUNK_MANIFEST_URL]);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest follows rc and release to GitHub Releases", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch((url) => {
    if (url === RC_MANIFEST_URL) {
      return new Response(manifestBody("rc", "rc1"), { status: 200 });
    }
    if (url === RELEASE_MANIFEST_URL) {
      return new Response(manifestBody("release", "rel1"), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  });
  try {
    assertEquals((await resolveUpdateManifest("rc"))?.commit, "rc1");
    assertEquals((await resolveUpdateManifest("release"))?.commit, "rel1");
    assertEquals(
      (await resolveUpdateManifest("release"))?.manifestUrl,
      RELEASE_MANIFEST_URL,
    );
    assertEquals(stub.calls, [RC_MANIFEST_URL, RELEASE_MANIFEST_URL]);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest is null for reserved channels without fetching", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch(() => {
    throw new TypeError("must not fetch");
  });
  try {
    assertEquals(await resolveUpdateManifest("edge"), null);
    assertEquals(await resolveUpdateManifest("canary"), null);
    assertEquals(stub.calls, []);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest coalesces concurrent lookups per channel", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch((url) =>
    new Response(manifestBody(url === RC_MANIFEST_URL ? "rc" : "trunk"), {
      status: 200,
    })
  );
  try {
    const [first, second, rc] = await Promise.all([
      resolveUpdateManifest("trunk"),
      resolveUpdateManifest("trunk"),
      resolveUpdateManifest("rc"),
    ]);
    assertEquals(first?.commit, "abc123");
    assertEquals(second?.commit, "abc123");
    assertEquals(rc?.channel, "rc");
    assertEquals(stub.calls, [TRUNK_MANIFEST_URL, RC_MANIFEST_URL]);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest reuses the cached manifest within the TTL, per channel", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch(() =>
    new Response(manifestBody("trunk"), { status: 200 })
  );
  try {
    await resolveUpdateManifest("trunk");
    await resolveUpdateManifest("trunk");
    assertEquals(stub.calls.length, 1);
    await resolveUpdateManifest("release");
    assertEquals(stub.calls.length, 2);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest returns null when the manifest is unavailable", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch(() => new Response("nope", { status: 500 }));
  try {
    assertEquals(await resolveUpdateManifest("trunk"), null);
    // A release that does not exist yet (404 until the first promotion) is
    // the same "unknown" the page already degrades to.
    assertEquals(await resolveUpdateManifest("release"), null);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest returns null for incomplete manifest fields", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ commit: "only" }), { status: 200 })
  );
  try {
    assertEquals(await resolveUpdateManifest("trunk"), null);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest returns null when fetch throws", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch(() => {
    throw new TypeError("network down");
  });
  try {
    assertEquals(await resolveUpdateManifest("trunk"), null);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("seedUpdateManifestCacheForTests short-circuits the fetch path for its channel only", async () => {
  resetUpdateManifestCacheForTests();
  seedUpdateManifestCacheForTests({
    commit: "seeded",
    buildId: "b",
    builtAt: "2020-01-01T00:00:00.000Z",
    channel: "trunk",
    manifestUrl: "https://dl.trbp.nl/m.json",
  });
  const stub = stubFetch(() => new Response("missing", { status: 404 }));
  try {
    assertEquals((await resolveUpdateManifest("trunk"))?.commit, "seeded");
    assertEquals(stub.calls, []);
    assertEquals(await resolveUpdateManifest("rc"), null);
    assertEquals(stub.calls, [RC_MANIFEST_URL]);
  } finally {
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});

test("resolveUpdateManifest defers to a registered provider for every channel", async () => {
  resetUpdateManifestCacheForTests();
  const stub = stubFetch(() => {
    throw new TypeError("provider must bypass the rail fetch");
  });
  const target = {
    commit: "abc+1",
    buildId: "dev-abc+1",
    builtAt: "2026-01-01T00:00:00.000Z",
    channel: "trunk",
    manifestUrl: "/repo/dist/manifest.json",
  };
  try {
    setUpdateManifestProvider(() => Promise.resolve(target));
    assertEquals(await resolveUpdateManifest("trunk"), target);
    assertEquals(await resolveUpdateManifest("release"), target);
    assertEquals(stub.calls, []);
  } finally {
    setUpdateManifestProvider(null);
    stub.restore();
    resetUpdateManifestCacheForTests();
  }
});
