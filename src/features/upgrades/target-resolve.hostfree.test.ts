import { assertEquals } from "@std/assert";
import { setting } from "../../db/schema.ts";
import type { Db } from "../../db/connection.ts";
import type { UpdateManifestTarget } from "../update/manifest.ts";
import type { ReleaseArtifactKind } from "../../contracts/update-channel.ts";
import {
  channelHasInstancePackage,
  getLatestAvailableBuild,
  isUpgradeTarget,
  LATEST_BUILD_SETTINGS_KEY,
  resolveUpgradeTarget,
  setLatestAvailableBuild,
  unitTargetFromManifest,
} from "./target-resolve.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function createFakeSettingDb(initial?: unknown) {
  let stored: unknown = initial;
  const db = {
    select() {
      const builder = {
        from() {
          return builder;
        },
        where() {
          return builder;
        },
        limit(): Promise<Array<{ value: unknown }>> {
          return stored === undefined
            ? Promise.resolve([])
            : Promise.resolve([{ value: stored }]);
        },
      };
      return builder;
    },
    insert(table: unknown) {
      return {
        values(row: { key: string; value: unknown }) {
          return {
            onConflictDoUpdate(args: { set: { value: unknown } }) {
              if (table === setting && row.key === LATEST_BUILD_SETTINGS_KEY) {
                stored = args.set.value;
              }
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
  };
  return db as unknown as Db;
}

function manifest(
  overrides: Partial<UpdateManifestTarget> = {},
): UpdateManifestTarget {
  return {
    commit: "abc",
    buildId: "abc+1",
    builtAt: "2026-01-01T00:00:00Z",
    channel: "release",
    manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    ...overrides,
  };
}

test("channelHasInstancePackage: only canary/rc/release", () => {
  assertEquals(channelHasInstancePackage("trunk"), false);
  assertEquals(channelHasInstancePackage("edge"), false);
  assertEquals(channelHasInstancePackage("canary"), true);
  assertEquals(channelHasInstancePackage("rc"), true);
  assertEquals(channelHasInstancePackage("release"), true);
});

test("unitTargetFromManifest pins a versioned release, floats trunk", () => {
  const release = unitTargetFromManifest(
    "instance",
    "release",
    manifest({ version: "0.1.1" }),
  );
  assertEquals(release, {
    version: "0.1.1",
    commit: "abc",
    buildId: "abc+1",
    builtAt: "2026-01-01T00:00:00Z",
    manifestUrl:
      "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
  });
  // trunk daemon has no version pin — keep the manifest's own URL.
  const trunk = unitTargetFromManifest(
    "daemon",
    "trunk",
    manifest({ version: undefined }),
  );
  assertEquals(
    trunk?.manifestUrl,
    "https://dl.trbp.nl/channels/trunk/manifest.json",
  );
  assertEquals(trunk?.version, null);
  assertEquals(unitTargetFromManifest("daemon", "trunk", null), null);
});

test("resolveUpgradeTarget resolves each unit through the injected resolver", async () => {
  const resolver = (kind: ReleaseArtifactKind) =>
    Promise.resolve(
      kind === "ui" ? null : manifest({ version: "0.1.1", commit: kind }),
    );
  const target = await resolveUpgradeTarget("release", resolver);
  assertEquals(target.daemon?.commit, "daemon");
  assertEquals(target.instance?.commit, "instance");
  assertEquals(target.ui, null);
});

test("isUpgradeTarget guards the jsonb shape", () => {
  assertEquals(
    isUpgradeTarget({ daemon: null, instance: null, ui: null }),
    true,
  );
  assertEquals(
    isUpgradeTarget({
      daemon: {
        version: "1",
        commit: "a",
        buildId: "b",
        builtAt: "t",
        manifestUrl: "u",
      },
      instance: null,
      ui: null,
    }),
    true,
  );
  assertEquals(
    isUpgradeTarget({ daemon: { commit: 5 }, instance: null, ui: null }),
    false,
  );
  assertEquals(isUpgradeTarget(null), false);
  assertEquals(isUpgradeTarget({ daemon: null }), false);
});

test("latest-build setting round-trips and rejects a bad row", async () => {
  const db = createFakeSettingDb();
  assertEquals(await getLatestAvailableBuild(db), null);
  const target = {
    daemon: {
      version: "0.1.1",
      commit: "a",
      buildId: "b",
      builtAt: "t",
      manifestUrl: "u",
    },
    instance: null,
    ui: null,
  };
  await setLatestAvailableBuild(db, target);
  assertEquals(await getLatestAvailableBuild(db), target);
  assertEquals(
    await getLatestAvailableBuild(createFakeSettingDb({ nope: 1 })),
    null,
  );
});
