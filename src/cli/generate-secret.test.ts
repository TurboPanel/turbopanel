import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { runGenerateSecretCommand } from "./generate-secret.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("generate-secret writes one 48-character [A-Za-z0-9_] value, fresh each time", () => {
  const lines: string[] = [];
  runGenerateSecretCommand((line) => lines.push(line));
  runGenerateSecretCommand((line) => lines.push(line));
  assertEquals(lines.length, 2);
  for (const line of lines) assertMatch(line, /^[A-Za-z0-9_]{48}$/);
  assertNotEquals(lines[0], lines[1]);
});
