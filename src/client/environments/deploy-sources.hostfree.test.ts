import { assertEquals } from "@std/assert";
import {
  isSshCloneUrl,
  parseGithubRepositoryPath,
  requestedCommitShaForSource,
} from "./deploy-sources.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SHA = "a".repeat(40);

test("a webhook SHA pins only the source that produced it", () => {
  const selection = {
    ref: "refs/heads/main",
    commitSha: SHA,
    sourceId: "src-1",
  };
  assertEquals(requestedCommitShaForSource(selection, "src-1"), SHA);
  // The other repository bound in the same environment resolves from its own
  // declared/default ref — this commit does not exist there.
  assertEquals(requestedCommitShaForSource(selection, "src-2"), undefined);
});

test("a SHA with no source identity pins nothing", () => {
  assertEquals(
    requestedCommitShaForSource(
      { ref: null, commitSha: SHA, sourceId: null },
      "src-1",
    ),
    undefined,
  );
  assertEquals(
    requestedCommitShaForSource({ ref: null, commitSha: SHA }, "src-1"),
    undefined,
  );
});

test("no selection and no SHA pin nothing", () => {
  assertEquals(requestedCommitShaForSource(undefined, "src-1"), undefined);
  assertEquals(
    requestedCommitShaForSource(
      { ref: "main", commitSha: null, sourceId: "src-1" },
      "src-1",
    ),
    undefined,
  );
});

test("isSshCloneUrl separates the SSH transport from https", () => {
  assertEquals(isSshCloneUrl("ssh://git@example.com/owner/repo.git"), true);
  assertEquals(isSshCloneUrl("git@example.com:owner/repo.git"), true);
  assertEquals(isSshCloneUrl("https://example.com/owner/repo.git"), false);
});

test("parseGithubRepositoryPath reads both URL forms", () => {
  assertEquals(parseGithubRepositoryPath("https://github.com/o/r.git"), {
    owner: "o",
    repo: "r",
  });
  assertEquals(parseGithubRepositoryPath("git@github.com:o/r.git"), {
    owner: "o",
    repo: "r",
  });
  assertEquals(parseGithubRepositoryPath("https://github.com/o"), null);
});
