import { assertEquals } from "@std/assert";
import { mergeDeployPrincipalRuntimes } from "./merge-deploy-principal-runtimes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("mergeDeployPrincipalRuntimes adds node@24 for a native app owner", () => {
  const principalId = "11111111-1111-4111-8111-111111111111";
  const { principalMaterial, deployEntitlements } = mergeDeployPrincipalRuntimes({
    principalMaterial: [{
      principalId,
      username: "app_test",
      accessGroups: [],
      sshKeys: [],
    }],
    nativeAppServices: [{
      composeServiceName: "web",
      listenPort: 18_868,
      framework: "next" as const,
    }],
    sourceMaterial: [{
      composeServiceName: "web",
      sourceId: "33333333-3333-4333-8333-333333333333",
      releaseId: "44444444-4444-4444-8444-444444444444",
      commitSha: "abc123",
      provider: "github" as const,
      cloneUrl: "https://github.com/example/nextjs.git",
      ref: "trunk",
      principal: {
        principalId,
        username: "app_test",
      },
      build: { kind: "native" as const },
    }],
  });

  assertEquals(principalMaterial, [{
    principalId,
    username: "app_test",
    accessGroups: [],
    sshKeys: [],
    runtimes: [{ runtime: "node", series: "24" }],
  }]);
  assertEquals(deployEntitlements, [{
    principalId,
    runtime: "node",
    series: "24",
  }]);
});

test("mergeDeployPrincipalRuntimes is idempotent when node entitlement already present", () => {
  const principalId = "11111111-1111-4111-8111-111111111111";
  const { deployEntitlements } = mergeDeployPrincipalRuntimes({
    principalMaterial: [{
      principalId,
      username: "app_test",
      accessGroups: [],
      sshKeys: [],
      runtimes: [{ runtime: "node", series: "24" }],
    }],
    nativeAppServices: [{
      composeServiceName: "web",
      listenPort: 18_868,
      framework: "next" as const,
      nodeVersion: "24.17.0",
    }],
    sourceMaterial: [{
      composeServiceName: "web",
      sourceId: "33333333-3333-4333-8333-333333333333",
      releaseId: "44444444-4444-4444-8444-444444444444",
      commitSha: "abc123",
      provider: "github" as const,
      cloneUrl: "https://github.com/example/nextjs.git",
      ref: "trunk",
      principal: { principalId, username: "app_test" },
      build: { kind: "native" as const },
    }],
  });

  assertEquals(deployEntitlements, []);
});
