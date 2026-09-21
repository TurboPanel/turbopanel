import { assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  assertValidUpdateChannelEnv,
  builtinChannelManifestUrl,
  isUpdateChannel,
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
const test = Deno.test.bind(Deno)

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
  for (const channel of UPDATE_CHANNELS) assertEquals(isUpdateChannel(channel), true);
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

test("builtinChannelManifestUrl matches the daemon's table when the daemon checkout is beside this one", async () => {
  let daemonSource: string;
  try {
    daemonSource = await Deno.readTextFile(DAEMON_URLS_TS);
  } catch {
    // CI checks this repo out alone; the daemon's own urls.test.ts pins
    // run.sh to the same table, so the three copies still meet there.
    return;
  }
  const fn = daemonSource.match(
    /export function builtinChannelManifestUrl\([\s\S]*?\n\}/,
  );
  if (!fn) throw new Error("builtinChannelManifestUrl not found in the daemon's urls.ts");
  // Evaluate the daemon's switch the cheap way: substitute its constants.
  const table = new Map<string, string>();
  for (const m of fn[0].matchAll(/case "(\w+)":\s*\n\s*return `([^`]+)`;/g)) {
    table.set(
      m[1],
      m[2]
        .replace("${DL_BASE_URL}", "https://dl.trbp.nl")
        .replace("${GITHUB_RELEASES_REPO}", "TurboPanel/turbopaneld"),
    );
  }
  const expected = new Map<string, string>();
  for (const channel of UPDATE_CHANNELS as readonly UpdateChannel[]) {
    const url = builtinChannelManifestUrl(channel);
    if (url !== null) expected.set(channel, url);
  }
  assertEquals(table.size, 4);
  assertEquals(table, expected);
});
