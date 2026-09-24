import { assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  assertValidUpdateChannelEnv,
  builtinChannelManifestUrl,
  isUpdateChannel,
  pinnedChannelManifestUrl,
  resolveInstanceUpdateChannel,
  UPDATE_CHANNELS,
  type UpdateChannel,
} from "./update-channel.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HERE = dirname(fromFileUrl(import.meta.url));
/** The sibling daemon checkout, when this is the shared five-repo tree. */
const DAEMON_URLS_TS = join(HERE, "../../../../turbopaneld/src/update/urls.ts");

test("resolveInstanceUpdateChannel defaults to trunk and reads TURBOPANEL_UPDATE_CHANNEL", () => {
  assertEquals(resolveInstanceUpdateChannel(undefined), "trunk");
  assertEquals(resolveInstanceUpdateChannel({}), "trunk");
  assertEquals(
    resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: "  " }),
    "trunk",
  );
  assertEquals(
    resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: " release " }),
    "release",
  );
  assertEquals(
    resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: "rc" }),
    "rc",
  );
  // The request path never throws; startup does (below).
  assertEquals(
    resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: "stable" }),
    "trunk",
  );
});

test("assertValidUpdateChannelEnv throws the daemon's wording for an unknown channel", () => {
  assertValidUpdateChannelEnv(undefined);
  assertValidUpdateChannelEnv({ TURBOPANEL_UPDATE_CHANNEL: "release" });
  assertThrows(
    () => assertValidUpdateChannelEnv({ TURBOPANEL_UPDATE_CHANNEL: "stable" }),
    Error,
    'Invalid TURBOPANEL_UPDATE_CHANNEL: "stable". Valid values: trunk, edge, canary, rc, release',
  );
});

test("isUpdateChannel accepts exactly the daemon's vocabulary", () => {
  for (const channel of UPDATE_CHANNELS) {
    assertEquals(isUpdateChannel(channel), true);
  }
  assertEquals(isUpdateChannel("stable"), false);
  assertEquals(isUpdateChannel(""), false);
  assertEquals(isUpdateChannel(undefined), false);
});

test("builtinChannelManifestUrl: trunk on the CDN, canary/rc/release on GitHub Releases, edge none", () => {
  assertEquals(
    builtinChannelManifestUrl("trunk"),
    "https://dl.trbp.nl/channels/trunk/manifest.json",
  );
  assertEquals(
    builtinChannelManifestUrl("rc"),
    "https://github.com/TurboPanel/turbopaneld/releases/download/rc/manifest.json",
  );
  assertEquals(
    builtinChannelManifestUrl("release"),
    "https://github.com/TurboPanel/turbopaneld/releases/latest/download/manifest.json",
  );
  assertEquals(
    builtinChannelManifestUrl("canary"),
    "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest.json",
  );
  assertEquals(builtinChannelManifestUrl("edge"), null);
});

test("pinnedChannelManifestUrl pins canary and versioned releases and leaves trunk floating", () => {
  const kinds = ["daemon", "instance", "ui"] as const;
  const repos = {
    daemon: "TurboPanel/turbopaneld",
    instance: "TurboPanel/turbopanel",
    ui: "TurboPanel/ui",
  };
  for (const kind of kinds) {
    const repo = repos[kind];
    assertEquals(
      pinnedChannelManifestUrl(kind, "canary", "0.1.0-rc.1"),
      `https://github.com/${repo}/releases/download/canary/manifest-0.1.0-rc.1.json`,
    );
    assertEquals(
      pinnedChannelManifestUrl(kind, "rc", "0.1.1"),
      `https://github.com/${repo}/releases/download/v0.1.1/manifest.json`,
    );
    assertEquals(
      pinnedChannelManifestUrl(kind, "release", "0.1.1"),
      `https://github.com/${repo}/releases/download/v0.1.1/manifest.json`,
    );
    assertEquals(pinnedChannelManifestUrl(kind, "trunk", "0.1.1"), null);
    assertEquals(pinnedChannelManifestUrl(kind, "edge", "0.1.1"), null);
  }
  assertEquals(pinnedChannelManifestUrl("daemon", "canary", ""), null);
  assertEquals(pinnedChannelManifestUrl("daemon", "canary", "v0.1.0"), null);
  assertEquals(
    pinnedChannelManifestUrl("daemon", "release", "0.1.0/evil"),
    null,
  );
});

test("builtinChannelManifestUrl matches the daemon's table when the daemon checkout is beside this one", async () => {
  let daemon: {
    builtinChannelManifestUrl: (
      channel: UpdateChannel,
      kind?: "daemon" | "instance" | "ui",
    ) => string | null;
    pinnedChannelManifestUrl: (
      kind: "daemon" | "instance" | "ui",
      channel: UpdateChannel,
      version: string,
    ) => string | null;
  };
  try {
    daemon = await import(DAEMON_URLS_TS);
  } catch {
    // CI checks this repo out alone; the daemon's own urls.test.ts pins
    // run.sh to the same table, so the three copies still meet there.
    return;
  }
  const kinds = ["daemon", "instance", "ui"] as const;
  for (const kind of kinds) {
    for (const channel of UPDATE_CHANNELS) {
      assertEquals(
        builtinChannelManifestUrl(channel, kind),
        daemon.builtinChannelManifestUrl(channel, kind),
        `${kind} ${channel}`,
      );
      assertEquals(
        pinnedChannelManifestUrl(kind, channel, "0.1.2"),
        daemon.pinnedChannelManifestUrl(kind, channel, "0.1.2"),
        `pinned ${kind} ${channel}`,
      );
    }
  }
});
