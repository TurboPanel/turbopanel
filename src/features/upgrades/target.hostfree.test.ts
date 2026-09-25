import { assertEquals } from "@std/assert";
import {
  differsFromInstalled,
  EMPTY_UNIT_TARGET,
  isDowngrade,
  isOnTarget,
  unitTarget,
  updateAvailableFor,
  type UpgradeTarget,
} from "./target.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const target: UpgradeTarget = {
  daemon: {
    version: "0.1.1",
    commit: "aaa",
    buildId: "b1",
    builtAt: "t",
    manifestUrl: "u",
  },
  instance: {
    version: "0.1.1",
    commit: "bbb",
    buildId: "b2",
    builtAt: "t",
    manifestUrl: "u",
  },
  ui: null,
};

test("unitTarget reads the daemon / instance pin and tolerates null", () => {
  assertEquals(unitTarget(target, "daemon")?.commit, "aaa");
  assertEquals(unitTarget(target, "instance")?.commit, "bbb");
  assertEquals(unitTarget(null, "daemon"), null);
  assertEquals(
    unitTarget({ daemon: null, instance: null, ui: null }, "daemon"),
    null,
  );
});

test("isOnTarget only when both commits are known and equal", () => {
  assertEquals(
    isOnTarget({ version: null, commit: "aaa" }, target.daemon),
    true,
  );
  assertEquals(
    isOnTarget({ version: null, commit: "zzz" }, target.daemon),
    false,
  );
  assertEquals(
    isOnTarget({ version: null, commit: null }, target.daemon),
    false,
  );
  assertEquals(
    isOnTarget({ version: null, commit: "aaa" }, EMPTY_UNIT_TARGET),
    false,
  );
  assertEquals(isOnTarget(null, target.daemon), false);
  assertEquals(isOnTarget(null, null), false);
});

test("differsFromInstalled: unknown target never differs; unknown install does", () => {
  assertEquals(
    differsFromInstalled({ version: null, commit: "aaa" }, target.daemon),
    false,
  );
  assertEquals(
    differsFromInstalled({ version: null, commit: "old" }, target.daemon),
    true,
  );
  // Host with no known commit but a resolved target still needs the install.
  assertEquals(
    differsFromInstalled({ version: null, commit: null }, target.daemon),
    true,
  );
  // Unknown target: nothing to roll out.
  assertEquals(
    differsFromInstalled({ version: null, commit: "old" }, EMPTY_UNIT_TARGET),
    false,
  );
  assertEquals(differsFromInstalled(null, null), false);
});

test("isDowngrade is strictly-older semver only", () => {
  assertEquals(isDowngrade("0.2.0", "0.1.1"), true);
  assertEquals(isDowngrade("v0.1.1", "0.1.1-rc.1"), true);
  assertEquals(isDowngrade("0.1.1-canary.9", "0.1.1-canary.10"), false);
  assertEquals(isDowngrade("0.1.1", "0.1.1"), false);
  assertEquals(isDowngrade("0.1.0", "0.1.1"), false);
  assertEquals(isDowngrade(null, "0.1.1"), false);
  assertEquals(isDowngrade("trunk-build", "0.1.1"), false);
  assertEquals(isDowngrade("0.2.0", null), false);
});

test("updateAvailableFor is the server's one update-available rule", () => {
  const installed = { version: "0.1.1", commit: "aaa" };
  // A new commit at the same or a higher version is an update.
  assertEquals(updateAvailableFor(installed, { version: "0.1.1", commit: "bbb" }), true);
  assertEquals(updateAvailableFor(installed, { version: "0.1.2", commit: "bbb" }), true);
  // The same commit is not, whatever the version label says.
  assertEquals(updateAvailableFor(installed, { version: "0.1.2", commit: "aaa" }), false);
  // An older version on a different commit would downgrade: not offered.
  assertEquals(updateAvailableFor(installed, { version: "0.1.0", commit: "bbb" }), false);
  // No target, or a target without a commit, offers nothing.
  assertEquals(updateAvailableFor(installed, null), false);
  assertEquals(updateAvailableFor(installed, { version: "0.1.2", commit: null }), false);
  // A host that reports no commit needs the install.
  assertEquals(updateAvailableFor({ version: null, commit: null }, { commit: "bbb" }), true);
});
