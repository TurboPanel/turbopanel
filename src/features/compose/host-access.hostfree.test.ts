/**
 * `host-access.ts` on its own: what it finds, and the fingerprint an automated
 * deploy's approval is checked against.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  collectHostAccessFindings,
  hostAccessFingerprint,
  hostAccessIssues,
} from "./host-access.ts";
import { makeComposeTag } from "./tags.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SOCKET = "/var/run/docker.sock:/var/run/docker.sock";

function stack(web: Record<string, unknown>): Record<string, unknown> {
  return { services: { web: { image: "traefik:v3", ...web } } };
}

test("an ordinary document has no findings and no fingerprint", async () => {
  const data = stack({ volumes: ["./data:/data", "cache:/cache"] });
  assertEquals(collectHostAccessFindings(data), []);
  assertEquals(await hostAccessFingerprint(data), null);
});

test("an unrelated edit keeps the fingerprint, so an approval survives it", async () => {
  const before = await hostAccessFingerprint(stack({ volumes: [SOCKET] }));
  const after = await hostAccessFingerprint(
    stack({ image: "traefik:v3.1", ports: ["80:80"], volumes: [SOCKET] }),
  );
  assertNotEquals(before, null);
  assertEquals(after, before);
});

test("changing where a bind points changes the fingerprint", async () => {
  const socket = await hostAccessFingerprint(stack({ volumes: [SOCKET] }));
  const root = await hostAccessFingerprint(stack({ volumes: ["/:/host"] }));
  assertNotEquals(root, socket);
});

test("adding a gated key changes the fingerprint", async () => {
  const bindOnly = await hostAccessFingerprint(stack({ volumes: [SOCKET] }));
  const privileged = await hostAccessFingerprint(
    stack({ volumes: [SOCKET], privileged: true }),
  );
  assertNotEquals(privileged, bindOnly);
});

test("changing a gated key's value changes the fingerprint", async () => {
  const a = await hostAccessFingerprint(stack({ cap_add: ["NET_ADMIN"] }));
  const b = await hostAccessFingerprint(stack({ cap_add: ["SYS_ADMIN"] }));
  assertNotEquals(a, b);
});

test("the fingerprint does not depend on key order", async () => {
  const a = await hostAccessFingerprint({
    services: {
      web: { image: "x", volumes: [SOCKET], privileged: true },
      db: { image: "y", pid: "host" },
    },
  });
  const b = await hostAccessFingerprint({
    services: {
      db: { pid: "host", image: "y" },
      web: { privileged: true, volumes: [SOCKET], image: "x" },
    },
  });
  assertEquals(a, b);
});

test("a bind hidden inside an !override tag is still found", () => {
  const data = stack({ volumes: makeComposeTag("override", [SOCKET]) });
  assertEquals(
    collectHostAccessFindings(data).map((finding) => finding.path),
    ["services.web.volumes[0]"],
  );
});

test("an include of another project's file is found", () => {
  const data = {
    include: ["/srv/users/other/compose.yaml", { path: ["./local.yaml", "/etc/x.yaml"] }],
    services: { web: { image: "x" } },
  };
  assertEquals(
    collectHostAccessFindings(data).map((finding) => finding.path),
    ["include[0]", "include[1].path[1]"],
  );
});

test("hostAccessIssues lists gated keys and value-level reach together", () => {
  const issues = hostAccessIssues(stack({ volumes: [SOCKET], uts: "host" }));
  assertEquals(issues.map((issue) => issue.path).sort(), [
    "services.web.uts",
    "services.web.volumes[0]",
  ]);
});

test("a non-string path is refused rather than trusted", () => {
  const findings = collectHostAccessFindings({
    services: { web: { image: "x", env_file: [{ path: 42 }] } },
  });
  assertEquals(findings.map((finding) => finding.path), [
    "services.web.env_file[0].path",
  ]);
});
